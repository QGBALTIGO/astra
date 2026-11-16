import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { CustomerRadarRepository, RadarRepository } from './customer-radar.js';
import { radarTestDatabase, seedRadarAccounts } from './radar-pg-fixture.js';
import type { PostgresAdapter } from '../adapters/postgres-adapter.js';
import { RADAR_DEFAULT_PREFERENCES, type RadarSnapshot } from '../../services/radar/contracts.js';
describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'Radar actual PostgreSQL isolation and recovery',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>,
      db: PostgresAdapter,
      a: CustomerRadarRepository,
      b: CustomerRadarRepository,
      publicRepo: RadarRepository;
    const userA = 'whatsapp:5567999991111',
      userB = 'whatsapp:5567999992222';
    const connect = <T extends object>(r: T): T => Object.assign(r, { adapter: db });
    beforeAll(async () => {
      fixture = await radarTestDatabase();
      db = fixture.adapter;
    });
    beforeEach(async () => {
      await db.exec(
        'TRUNCATE customer_radar_outbox,customer_radar_interests,customer_radar_preferences,radar_resources,radar_provider_limits,customer_phone_aliases,customer_accounts,channel_users CASCADE'
      );
      await seedRadarAccounts(db);
      a = connect(new CustomerRadarRepository(userA));
      b = connect(new CustomerRadarRepository(userB));
      publicRepo = connect(new RadarRepository());
    });
    afterAll(async () => {
      await fixture?.close();
    });
    const create = () =>
      a.create({ source: 'currency', target: 'USD', delivery: 'digest', leadMinutes: 60 }, 'USD');
    const enable = async (repo = a) =>
      (await repo.savePreferences({ ...RADAR_DEFAULT_PREFERENCES, enabled: true })).revision;
    async function prepare() {
      const i = await create();
      const revision = await enable();
      const row = (await a.get(i.id))!;
      const payload = {
        title: 'USD',
        text: 'Referência',
        source: 'Frankfurter',
        url: 'https://frankfurter.dev/',
      };
      await publicRepo.queue(
        userA,
        row,
        revision,
        i.id + ':event',
        payload,
        new Date(Date.now() + 3600000)
      );
      return { i, row, revision, payload };
    }
    it('starts every account with explicit opt-in disabled', async () => {
      expect((await a.preferences()).preferences.enabled).toBe(false);
      expect(await publicRepo.activeAccounts('')).toEqual([]);
    });
    it('stores a user choice without enrolling any other account', async () => {
      await create();
      expect(await a.list()).toHaveLength(1);
      expect(await b.list()).toHaveLength(0);
      expect((await b.preferences()).preferences.enabled).toBe(false);
    });
    it('does not let B read, pause, edit or delete A even with a known ID', async () => {
      const i = await create();
      expect(await b.get(i.id)).toBeNull();
      expect(await b.change(i.id, { active: false })).toBeNull();
      expect(await b.remove(i.id)).toBe(false);
      expect((await a.list())[0]!.active).toBe(true);
    });
    it('shares one public resource across private followers', async () => {
      await create();
      await b.create(
        { source: 'currency', target: 'USD', delivery: 'digest', leadMinutes: 60 },
        'USD'
      );
      expect(
        (await db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM radar_resources'))!.n
      ).toBe('1');
      expect((await a.list())[0]!.id).not.toBe((await b.list())[0]!.id);
    });
    it('serializes duplicate subscription creation', async () => {
      const results = await Promise.allSettled([create(), create(), create()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await a.list()).toHaveLength(1);
    });
    it('does not collect resources without eligible active followers', async () => {
      await create();
      await db.execute("UPDATE channel_users SET access_expires_at=NOW()-INTERVAL '1 minute'");
      expect(await publicRepo.claimResources()).toEqual([]);
    });
    it('claims a shared resource only once across concurrent worker calls', async () => {
      await create();
      const results = await Promise.all([publicRepo.claimResources(), publicRepo.claimResources()]);
      expect(results.flat()).toHaveLength(1);
    });
    it('fences a stale collector after lease recovery', async () => {
      await create();
      const old = (await publicRepo.claimResources())[0]!;
      await db.execute("UPDATE radar_resources SET leased_until=NOW()-INTERVAL '1 second'");
      const newer = (await publicRepo.claimResources())[0]!;
      const snapshot: RadarSnapshot = {
        items: [],
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        sourceLabel: 'Fonte',
        sourceUrl: 'https://example.com/',
      };
      expect(await publicRepo.saveSnapshot(old.id, old.lease_token, snapshot, 3600)).toBe(false);
      expect(await publicRepo.saveSnapshot(newer.id, newer.lease_token, snapshot, 3600)).toBe(true);
    });
    it('keeps sensitive rule thresholds outside public caches', async () => {
      await a.create(
        {
          source: 'currency',
          target: 'USD',
          delivery: 'threshold',
          threshold: '5.123456',
          comparison: 'above',
          leadMinutes: 60,
        },
        'USD'
      );
      const r = await db.queryOne<Record<string, unknown>>('SELECT * FROM radar_resources');
      expect(JSON.stringify(r)).not.toContain('5.123456');
      expect(JSON.stringify(r)).not.toContain(userA);
    });
    it('enforces tenant consistency on outbox foreign keys', async () => {
      const i = await create();
      await enable();
      await enable(b);
      await expect(
        db.execute(
          `INSERT INTO customer_radar_outbox(id,user_id,interest_id,interest_revision,preference_revision,event_key,payload,expires_at)
   VALUES('bad',$1,$2,1,1,'bad','{}',NOW()+INTERVAL '1 hour')`,
          [userB, i.id]
        )
      ).rejects.toMatchObject({ code: '23503' });
    });
    it('does not queue effects after the interest was paused', async () => {
      const { i, row, revision, payload } = await prepare();
      await a.change(i.id, { active: false });
      expect(
        await publicRepo.queue(
          userA,
          row,
          revision,
          i.id + ':later',
          payload,
          new Date(Date.now() + 3600000)
        )
      ).toBe(false);
      expect(await publicRepo.claimDeliveries()).toEqual([]);
    });
    it('cancels a claimed job when preferences are disabled', async () => {
      await prepare();
      const job = (await publicRepo.claimDeliveries())[0]!;
      await a.savePreferences(RADAR_DEFAULT_PREFERENCES);
      expect(await publicRepo.deliveryCurrent(job)).toBe(false);
      expect(await publicRepo.beginDelivery(job)).toBe(false);
    });
    it('serializes final authorization behind an in-progress opt-out', async () => {
      await prepare();
      const job = (await publicRepo.claimDeliveries())[0]!;
      let entered!: () => void, release!: () => void;
      const locked = new Promise<void>((r) => {
          entered = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      const optout = db.transaction(async () => {
        await db.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'radar:' + userA,
        ]);
        await db.execute(
          "UPDATE customer_radar_preferences SET preferences=jsonb_set(preferences,'{enabled}','false'::jsonb),revision=revision+1 WHERE user_id=$1",
          [userA]
        );
        entered();
        await gate;
      });
      await locked;
      let authorized = false;
      const begin = publicRepo.beginDelivery(job).then((v) => {
        authorized = v;
        return v;
      });
      try {
        await new Promise((r) => setTimeout(r, 40));
        expect(authorized).toBe(false);
      } finally {
        release();
        await optout;
      }
      expect(await begin).toBe(false);
    });
    it('does not expose A notification history to B', async () => {
      await prepare();
      expect(await a.history()).toHaveLength(1);
      expect(await b.history()).toEqual([]);
    });
    it('idempotently merges all daily subjects into one account job', async () => {
      const revision = await enable();
      await create();
      await a.create({ source: 'ptax', target: 'EUR', delivery: 'digest', leadMinutes: 60 }, 'EUR');
      const date = new Date(Date.now() + 3600000);
      const queued = await Promise.all([
        publicRepo.queueDigest(userA, revision, '2026-11-16', date),
        publicRepo.queueDigest(userA, revision, '2026-11-16', date),
      ]);
      expect(queued.filter(Boolean)).toHaveLength(1);
      expect(await publicRepo.claimDeliveries(10)).toHaveLength(1);
    });
    it('does not replay a sent digest after preference edits', async () => {
      const revision = await enable();
      await create();
      const expiry = new Date(Date.now() + 3600000);
      await publicRepo.queueDigest(userA, revision, '2026-11-16', expiry);
      const job = (await publicRepo.claimDeliveries())[0]!;
      await publicRepo.beginDelivery(job);
      await publicRepo.finishDelivery(job, 'sent', 'receipt');
      const pref2 = await enable();
      expect(await publicRepo.queueDigest(userA, pref2, '2026-11-16', expiry)).toBe(false);
    });
    it('allows a cancelled pending digest to use current preferences', async () => {
      const revision = await enable();
      await create();
      const expiry = new Date(Date.now() + 3600000);
      await publicRepo.queueDigest(userA, revision, '2026-11-16', expiry);
      const pref2 = await enable();
      expect(await publicRepo.queueDigest(userA, pref2, '2026-11-16', expiry)).toBe(true);
      expect((await publicRepo.claimDeliveries())[0]!.preference_revision).toBe(pref2);
    });
    it('recovers a claimed job before transmission, with a new token', async () => {
      await prepare();
      const old = (await publicRepo.claimDeliveries())[0]!;
      await db.execute("UPDATE customer_radar_outbox SET leased_until=NOW()-INTERVAL '1 second'");
      const newer = (await publicRepo.claimDeliveries())[0]!;
      expect(newer.lease_token).not.toBe(old.lease_token);
      expect(await publicRepo.beginDelivery(old)).toBe(false);
      expect(await publicRepo.beginDelivery(newer)).toBe(true);
    });
    it('never automatically retries an ambiguous in-flight delivery after restart', async () => {
      await prepare();
      const job = (await publicRepo.claimDeliveries())[0]!;
      await publicRepo.beginDelivery(job);
      await db.execute("UPDATE customer_radar_outbox SET leased_until=NOW()-INTERVAL '1 second'");
      expect(await publicRepo.claimDeliveries()).toEqual([]);
      expect(
        (await db.queryOne<{ status: string }>('SELECT status FROM customer_radar_outbox'))!.status
      ).toBe('unknown');
    });
    it('expires late events instead of sending a missed pregame notification', async () => {
      await prepare();
      await db.execute("UPDATE customer_radar_outbox SET expires_at=NOW()-INTERVAL '1 second'");
      expect(await publicRepo.claimDeliveries()).toEqual([]);
      expect((await a.history())[0]!.status).toBe('expired');
    });
    it('limits provider requests globally across independent collectors', async () => {
      const accepted = await Promise.all(
        Array.from({ length: 20 }, () => publicRepo.reserveProvider('source', 60000))
      );
      expect(accepted.filter(Boolean)).toHaveLength(1);
    });
    it('revalidates source changes after edits while retaining ownership', async () => {
      const { i } = await prepare();
      await a.change(i.id, { delivery: 'threshold', threshold: '5.55', comparison: 'above' });
      const current = await a.get(i.id);
      expect(current!.revision).toBe(2);
      expect(current!.input.threshold).toBe('5.55');
      expect(await publicRepo.claimDeliveries()).toEqual([]);
    });
  }
);
