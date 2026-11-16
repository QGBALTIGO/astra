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
    const newsCards = () => [
      {
        text: '📰 *Uma notícia importante*\n\nPublicado em 16/11/2026\nGlobal Voices · CC BY 3.0',
        urlButton: {
          label: 'Ler matéria' as const,
          url: 'https://pt.globalvoices.org/2026/11/16/noticia/',
        },
      },
    ];
    it('queues a private news read for an account with no Radar opt-in or interests', async () => {
      expect(await publicRepo.queueNewsPreview(userA, 0, 'message-a', newsCards())).toBe('queued');
      expect((await a.preferences()).preferences.enabled).toBe(false);
      expect((await a.preferences()).revision).toBe(0);
      expect(await a.list()).toEqual([]);
      expect(await b.history()).toEqual([]);
      const job = (await publicRepo.claimDeliveries())[0]!;
      expect(job.event_key).toBe('preview:message-a');
      expect(job.payload).toMatchObject({ newsPreview: true, cards: newsCards() });
      expect(await publicRepo.deliveryCurrent(job)).toBe(true);
      expect(await publicRepo.beginDelivery(job)).toBe(true);
      expect(await publicRepo.sendingDeliveryCurrent(job)).toBe(true);
      expect((await a.preferences()).preferences.enabled).toBe(false);
    });
    it('deduplicates previews including unknown sends and applies rate limits independently by account', async () => {
      expect(await publicRepo.queueNewsPreview(userA, 0, 'message-a', newsCards())).toBe('queued');
      const job = (await publicRepo.claimDeliveries())[0]!;
      await publicRepo.beginDelivery(job);
      await publicRepo.finishDelivery(job, 'unknown');
      expect(await publicRepo.queueNewsPreview(userA, 0, 'message-a', newsCards())).toBe(
        'existing'
      );
      expect(await publicRepo.queueNewsPreview(userA, 0, 'message-b', newsCards())).toBe(
        'rate_limited'
      );
      expect(await publicRepo.queueNewsPreview(userB, 0, 'message-a', newsCards())).toBe('queued');
      const later = await publicRepo.claimDeliveries(10);
      expect(later).toHaveLength(1);
      expect(later[0]!.user_id).toBe(userB);
      expect((await a.history())[0]!.status).toBe('unknown');
    });
    it('requires the current preference revision even for an explicitly requested paused preview', async () => {
      const pref = await a.savePreferences(RADAR_DEFAULT_PREFERENCES);
      expect(await publicRepo.queueNewsPreview(userA, 0, 'stale', newsCards())).toBe('unavailable');
      expect(await publicRepo.queueNewsPreview(userA, pref.revision, 'current', newsCards())).toBe(
        'queued'
      );
      const job = (await publicRepo.claimDeliveries())[0]!;
      expect(await publicRepo.beginDelivery(job)).toBe(true);
      await a.savePreferences(RADAR_DEFAULT_PREFERENCES);
      expect(await publicRepo.sendingDeliveryCurrent(job)).toBe(false);
      // A receipt already accepted during an opt-out is still an audit fact.
      expect(await publicRepo.recordDeliveryPart(job, 0, 'accepted-before-optout', 1)).toBe(true);
    });
    it('cancels a claimed paused preview when the customer changes preferences before it starts', async () => {
      expect(await publicRepo.queueNewsPreview(userA, 0, 'message-a', newsCards())).toBe('queued');
      const job = (await publicRepo.claimDeliveries())[0]!;
      await a.savePreferences(RADAR_DEFAULT_PREFERENCES);
      expect(await publicRepo.deliveryCurrent(job)).toBe(false);
      expect(await publicRepo.beginDelivery(job)).toBe(false);
      expect((await a.preferences()).preferences.enabled).toBe(false);
    });
    it('does not interpret an arbitrary payload flag as preview consent', async () => {
      await prepare();
      await db.execute(
        "UPDATE customer_radar_outbox SET payload=jsonb_set(payload,'{newsPreview}','true'::jsonb)"
      );
      await db.execute(
        "UPDATE customer_radar_preferences SET preferences=jsonb_set(preferences,'{enabled}','false'::jsonb)"
      );
      const job = (await publicRepo.claimDeliveries())[0]!;
      expect(await publicRepo.deliveryCurrent(job)).toBe(false);
      expect(await publicRepo.beginDelivery(job)).toBe(false);
    });
    it('rejects malformed news cards, unsafe destinations and oversized batches before creating preferences or jobs', async () => {
      const valid = newsCards()[0]!;
      const invalid = [
        [],
        [valid, valid, valid, valid],
        [{ ...valid, text: '' }],
        [{ ...valid, text: 'x'.repeat(501) }],
        [
          {
            ...valid,
            urlButton: { label: 'Ler matéria', url: 'http://pt.globalvoices.org/noticia/' },
          },
        ],
        [
          {
            ...valid,
            urlButton: {
              label: 'Ler matéria',
              url: 'https://pt.globalvoices.org.evil.test/noticia/',
            },
          },
        ],
        [
          {
            ...valid,
            urlButton: {
              label: 'Ler matéria',
              url: 'https://private@pt.globalvoices.org/noticia/',
            },
          },
        ],
        [
          {
            ...valid,
            urlButton: {
              label: 'Ler matéria',
              url: 'https://pt.globalvoices.org/' + 'x'.repeat(600),
            },
          },
        ],
        [{ ...valid, urlButton: { label: 'Enviar', url: valid.urlButton.url } }],
      ];
      for (const cards of invalid)
        expect(await publicRepo.queueNewsPreview(userA, 0, 'invalid', cards as never)).toBe(
          'unavailable'
        );
      expect(await db.query('SELECT * FROM customer_radar_preferences')).toEqual([]);
      expect(await a.history()).toEqual([]);
    });
    it('records sequential confirmed parts atomically and keeps them after an unknown batch without replay', async () => {
      await prepare();
      const job = (await publicRepo.claimDeliveries())[0]!;
      expect(await publicRepo.sendingDeliveryCurrent(job)).toBe(false);
      expect(await publicRepo.recordDeliveryPart(job, 0, 'first', 3)).toBe(false);
      expect(await publicRepo.beginDelivery(job)).toBe(true);
      expect(
        await Promise.all([
          publicRepo.recordDeliveryPart(job, 0, 'first', 3),
          publicRepo.recordDeliveryPart(job, 0, 'first', 3),
        ])
      ).toEqual([true, true]);
      expect(await publicRepo.recordDeliveryPart(job, 0, 'other-receipt', 3)).toBe(false);
      expect(await publicRepo.recordDeliveryPart(job, 2, 'third', 3)).toBe(false);
      expect(await publicRepo.recordDeliveryPart(job, 1, 'second', 2)).toBe(false);
      expect(await publicRepo.recordDeliveryPart(job, 1, 'second', 3)).toBe(true);
      await publicRepo.finishDelivery(job, 'unknown');
      expect(await publicRepo.claimDeliveries()).toEqual([]);
      const saved = await db.queryOne<{ payload: typeof job.payload; status: string }>(
        'SELECT payload,status FROM customer_radar_outbox WHERE id=$1',
        [job.id]
      );
      expect(saved).toMatchObject({
        status: 'unknown',
        payload: {
          totalParts: 3,
          deliveredParts: [
            { index: 0, transportId: 'first' },
            { index: 1, transportId: 'second' },
          ],
        },
      });
      expect(await publicRepo.recordDeliveryPart(job, 2, 'third', 3)).toBe(false);
    });
    it('fences part receipts and every-part authorization against wrong owners, leases, expiry and interest changes', async () => {
      const { i } = await prepare();
      const job = (await publicRepo.claimDeliveries())[0]!;
      const otherOwner = { ...job, user_id: userB };
      expect(await publicRepo.deliveryCurrent(otherOwner)).toBe(false);
      expect(await publicRepo.beginDelivery(otherOwner)).toBe(false);
      expect(await publicRepo.beginDelivery(job)).toBe(true);
      expect(await publicRepo.sendingDeliveryCurrent(job)).toBe(true);
      expect(await publicRepo.sendingDeliveryCurrent(otherOwner)).toBe(false);
      expect(await publicRepo.recordDeliveryPart(otherOwner, 0, 'wrong-owner', 1)).toBe(false);
      expect(
        await publicRepo.recordDeliveryPart({ ...job, lease_token: 'stale' }, 0, 'wrong-lease', 1)
      ).toBe(false);
      expect(await publicRepo.sendingDeliveryCurrent({ ...job, lease_token: 'stale' })).toBe(false);
      await a.change(i.id, { active: false });
      expect(await publicRepo.sendingDeliveryCurrent(job)).toBe(false);
      await a.change(i.id, { active: true });
      expect(await publicRepo.sendingDeliveryCurrent(job)).toBe(false);
      await db.execute(
        "UPDATE customer_radar_outbox SET interest_revision=(SELECT revision FROM customer_radar_interests WHERE id=$1),expires_at=NOW()-INTERVAL '1 second' WHERE id=$2",
        [i.id, job.id]
      );
      expect(await publicRepo.sendingDeliveryCurrent(job)).toBe(false);
      await db.execute(
        "UPDATE customer_radar_outbox SET expires_at=NOW()+INTERVAL '1 hour',leased_until=NOW()-INTERVAL '1 second' WHERE id=$1",
        [job.id]
      );
      expect(await publicRepo.sendingDeliveryCurrent(job)).toBe(false);
      expect(await b.history()).toEqual([]);
    });
    it('rejects invalid part indexes, receipt IDs and changing batch sizes without touching the payload', async () => {
      await prepare();
      const job = (await publicRepo.claimDeliveries())[0]!;
      await publicRepo.beginDelivery(job);
      for (const [index, id, total] of [
        [-1, 'receipt', 1],
        [0.5, 'receipt', 1],
        [1, 'receipt', 1],
        [0, '', 1],
        [0, 'x'.repeat(257), 1],
        [0, 'bad\nreceipt', 1],
        [0, 'receipt', 0],
        [0, 'receipt', 11],
      ] as const)
        expect(await publicRepo.recordDeliveryPart(job, index, id, total)).toBe(false);
      expect(
        (await db.queryOne<{ payload: typeof job.payload }>(
          'SELECT payload FROM customer_radar_outbox WHERE id=$1',
          [job.id]
        ))!.payload
      ).toEqual(job.payload);
    });
    it('starts every account with explicit opt-in disabled', async () => {
      expect((await a.preferences()).preferences.enabled).toBe(false);
      expect(await publicRepo.activeAccounts('')).toEqual([]);
    });
    it('queues one explicit extra digest without replaying an uncertain daily delivery', async () => {
      await create();
      const revision = await enable();
      await publicRepo.queueDigest(userA, revision, '2026-11-16', new Date(Date.now() + 3600000));
      await db.execute("UPDATE customer_radar_outbox SET status='unknown' WHERE user_id=$1", [
        userA,
      ]);
      expect(await publicRepo.queueRequestedDigest(userA, revision, 'private-message-a')).toBe(
        'queued'
      );
      expect(await publicRepo.queueRequestedDigest(userA, revision, 'private-message-a')).toBe(
        'existing'
      );
      expect(await publicRepo.queueRequestedDigest(userA, revision, 'private-message-b')).toBe(
        'rate_limited'
      );
      expect(
        (await db.queryOne<{ status: string }>(
          "SELECT status FROM customer_radar_outbox WHERE user_id=$1 AND event_key='digest:2026-11-16'",
          [userA]
        ))!.status
      ).toBe('unknown');
      expect(await b.history()).toHaveLength(0);
    });
    it('does not queue an extra digest without active matching preferences', async () => {
      expect(await publicRepo.queueRequestedDigest(userB, 0, 'private-message-c')).toBe(
        'unavailable'
      );
      expect(await b.history()).toHaveLength(0);
    });
    it('stores a user choice without enrolling any other account', async () => {
      await create();
      expect(await a.list()).toHaveLength(1);
      expect(await b.list()).toHaveLength(0);
      expect((await b.preferences()).preferences.enabled).toBe(false);
    });
    it('chat opt-in enables only the requested topic and preserves the other customer', async () => {
      const old = await create();
      await b.create(
        { source: 'currency', target: 'USD', delivery: 'digest', leadMinutes: 60 },
        'USD'
      );
      await enable(b);
      const next = await a.followFromChat(
        { source: 'news', target: 'Tecnologia', delivery: 'digest', leadMinutes: 60 },
        'Tecnologia',
        '08:00'
      );
      expect(next.keptPaused).toBe(1);
      expect((await a.get(old.id))!.active).toBe(false);
      expect((await a.get(next.interest.id))!.active).toBe(true);
      expect((await a.preferences()).preferences).toMatchObject({ enabled: true, time: '08:00' });
      expect((await b.list())[0]!.active).toBe(true);
      expect((await b.preferences()).preferences.time).toBe('07:00');
    });
    it('rolls back the whole chat opt-in when its schedule cannot be saved', async () => {
      const old = await create();
      await expect(
        a.followFromChat(
          { source: 'news', target: 'Tecnologia', delivery: 'digest', leadMinutes: 60 },
          'Tecnologia',
          '23:00'
        )
      ).rejects.toThrow();
      expect(await a.list()).toHaveLength(1);
      expect((await a.get(old.id))!.active).toBe(true);
      expect((await a.preferences()).preferences.enabled).toBe(false);
    });
    it('serializes duplicate chat requests without creating duplicate follows', async () => {
      const input = {
        source: 'news' as const,
        target: 'Tecnologia',
        delivery: 'digest' as const,
        leadMinutes: 60,
      };
      await Promise.all(
        Array.from({ length: 12 }, () => a.followFromChat(input, 'Tecnologia', '08:00'))
      );
      expect(await a.list()).toHaveLength(1);
      expect((await a.preferences()).preferences.enabled).toBe(true);
    });
    it('rolls back the interest, other topics and public resource when the preference write fails', async () => {
      const old = await create();
      await db.exec(
        `ALTER TABLE customer_radar_preferences ADD CONSTRAINT radar_test_reject_schedule CHECK (preferences->>'time' <> '08:13')`
      );
      try {
        await expect(
          a.followFromChat(
            { source: 'news', target: 'Tecnologia', delivery: 'digest', leadMinutes: 60 },
            'Tecnologia',
            '08:13'
          )
        ).rejects.toThrow();
        expect(await a.list()).toHaveLength(1);
        expect((await a.get(old.id))!.active).toBe(true);
        expect((await a.preferences()).preferences.enabled).toBe(false);
        expect(
          (await db.queryOne<{ n: string }>(
            "SELECT COUNT(*) AS n FROM radar_resources WHERE source='news'"
          ))!.n
        ).toBe('0');
      } finally {
        await db.exec(
          'ALTER TABLE customer_radar_preferences DROP CONSTRAINT radar_test_reject_schedule'
        );
      }
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
    it('ignores a retired provider throttle while respecting the replacement budget', async () => {
      await a.create({ source: 'news', target: 'IA', delivery: 'digest', leadMinutes: 60 }, 'IA');
      await publicRepo.reserveProvider('api.gdeltproject.org', 1000);
      await publicRepo.blockProvider('api.gdeltproject.org', 86400);
      await publicRepo.reserveProvider('pt.globalvoices.org', 1000);
      await publicRepo.blockProvider('pt.globalvoices.org', 86400);
      expect(await publicRepo.claimResources()).toEqual([]);
      await db.execute(
        "UPDATE radar_provider_limits SET next_request_at=NOW()-INTERVAL '1 second',blocked_until=NOW()-INTERVAL '1 second' WHERE provider='pt.globalvoices.org'"
      );
      expect(await publicRepo.claimResources()).toHaveLength(1);
    });
    it('refreshes an old failed public adapter without changing private opt-ins', async () => {
      const interest = await a.create(
        { source: 'news', target: 'IA', delivery: 'digest', leadMinutes: 60 },
        'IA'
      );
      const row = await a.get(interest.id);
      await db.execute(
        "UPDATE radar_resources SET error_code='provider_throttled',next_poll_at=NOW()+INTERVAL '1 day' WHERE id=$1",
        [row!.resource_id]
      );
      await publicRepo.refreshReplacedSources();
      expect((await a.list())[0]!.errorCode).toBeNull();
      expect((await a.preferences()).preferences.enabled).toBe(false);
      expect((await b.preferences()).preferences.enabled).toBe(false);
      expect(await publicRepo.claimResources()).toHaveLength(1);
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
