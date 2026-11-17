import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { CustomerRadarRepository, RadarRepository } from './customer-radar.js';
import { radarTestDatabase, seedRadarAccounts } from './radar-pg-fixture.js';
import type { PostgresAdapter } from '../adapters/postgres-adapter.js';
import { RADAR_DEFAULT_PREFERENCES, type RadarSnapshot } from '../../services/radar/contracts.js';
import { interestDecisions, stillMatchesDelivery } from '../../services/radar/rules.js';
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
      vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-test-key');
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
      vi.unstubAllEnvs();
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
    const kickoffInput = {
      source: 'football' as const,
      target: 'br:cr-vasco-da-gama',
      delivery: 'before' as const,
      leadMinutes: 60,
    };
    async function queuedKickoff() {
      const followed = await a.followFromChat(kickoffInput, 'Vasco', '07:00');
      const row = (await a.get(followed.interest.id))!;
      const instant = new Date();
      const snapshot: RadarSnapshot = {
        observedAt: instant.toISOString(),
        expiresAt: new Date(instant.getTime() + 20 * 60000).toISOString(),
        sourceLabel: 'DadosFutebol',
        sourceUrl: 'https://example.org/',
        items: [
          {
            id: 'legacy-match',
            title: 'Vasco × Bahia',
            at: new Date(instant.getTime() + 45 * 60000).toISOString(),
            provider: 'football-data',
            providerMatchId: 'mt_synthetic',
            status: 'scheduled',
          },
        ],
      };
      await db.execute('UPDATE radar_resources SET snapshot=$2::jsonb WHERE id=$1', [
        row.resource_id,
        JSON.stringify(snapshot),
      ]);
      const current = (await a.get(row.id))!;
      const pref = await a.preferences();
      const [decision] = interestDecisions(current, instant, 'America/Cuiaba');
      expect(
        await publicRepo.queue(
          userA,
          current,
          pref.revision,
          decision!.key,
          decision!.payload,
          decision!.expiresAt
        )
      ).toBe(true);
      return {
        current,
        pref,
        instant,
        snapshot,
        decision: decision!,
        job: (await publicRepo.claimDeliveries())[0]!,
      };
    }
    async function rescheduledKickoff(state: Awaited<ReturnType<typeof queuedKickoff>>) {
      state.snapshot.items[0]!.at = new Date(state.instant.getTime() + 10 * 60000).toISOString();
      await db.execute('UPDATE radar_resources SET snapshot=$2::jsonb WHERE id=$1', [
        state.current.resource_id,
        JSON.stringify(state.snapshot),
      ]);
      await a.change(state.current.id, { leadMinutes: 15 });
      const current = (await a.get(state.current.id))!;
      const [decision] = interestDecisions(current, state.instant, 'America/Cuiaba');
      expect(decision!.key).not.toBe(state.decision.key);
      return { current, decision: decision! };
    }
    it.each(['sent', 'unknown', 'sending'] as const)(
      'does not create another event for a %s match after a kickoff and lead change',
      async (status) => {
        const state = await queuedKickoff();
        expect(await publicRepo.beginDelivery(state.job)).toBe(true);
        if (status !== 'sending')
          await publicRepo.finishDelivery(
            state.job,
            status,
            status === 'sent' ? 'synthetic-receipt' : undefined
          );
        const next = await rescheduledKickoff(state);
        expect(
          await publicRepo.queue(
            userA,
            next.current,
            state.pref.revision,
            next.decision.key,
            next.decision.payload,
            next.decision.expiresAt
          )
        ).toBe(false);
        expect(await publicRepo.claimDeliveries()).toEqual([]);
        expect((await a.history())[0]!.status).toBe(status);
        expect(await a.history()).toHaveLength(1);
      }
    );
    it.each(['transport', 'part'] as const)(
      'retains the one-match fence for a cancelled job with a %s receipt',
      async (receipt) => {
        const state = await queuedKickoff();
        expect(await publicRepo.beginDelivery(state.job)).toBe(true);
        if (receipt === 'part')
          expect(await publicRepo.recordDeliveryPart(state.job, 0, 'synthetic-receipt', 1)).toBe(
            true
          );
        await publicRepo.finishDelivery(
          state.job,
          'cancelled',
          receipt === 'transport' ? 'synthetic-receipt' : undefined
        );
        const next = await rescheduledKickoff(state);
        expect(
          await publicRepo.queue(
            userA,
            next.current,
            state.pref.revision,
            next.decision.key,
            next.decision.payload,
            next.decision.expiresAt
          )
        ).toBe(false);
        expect(await a.history()).toHaveLength(1);
      }
    );
    it('allows a new schedule after a provably unsent delivery was released and cancelled', async () => {
      const state = await queuedKickoff();
      expect(await publicRepo.beginDelivery(state.job)).toBe(true);
      await publicRepo.deferDelivery(state.job, 0, true);
      const next = await rescheduledKickoff(state);
      expect(
        await publicRepo.queue(
          userA,
          next.current,
          state.pref.revision,
          next.decision.key,
          next.decision.payload,
          next.decision.expiresAt
        )
      ).toBe(true);
      const job = (await publicRepo.claimDeliveries())[0]!;
      expect(job.event_key).toBe(next.decision.key);
      expect(await publicRepo.beginDelivery(state.job)).toBe(false);
    });
    it('allows only one prequeued version of a match to cross the send boundary concurrently', async () => {
      const state = await queuedKickoff();
      state.snapshot.items[0]!.at = new Date(state.instant.getTime() + 50 * 60000).toISOString();
      await db.execute('UPDATE radar_resources SET snapshot=$2::jsonb WHERE id=$1', [
        state.current.resource_id,
        JSON.stringify(state.snapshot),
      ]);
      const row = (await a.get(state.current.id))!;
      const [next] = interestDecisions(row, state.instant, 'America/Cuiaba');
      expect(
        await publicRepo.queue(
          userA,
          row,
          state.pref.revision,
          next!.key,
          next!.payload,
          next!.expiresAt
        )
      ).toBe(true);
      const newer = (await publicRepo.claimDeliveries())[0]!;
      const allowed = await Promise.all([
        publicRepo.beginDelivery(state.job),
        publicRepo.beginDelivery(newer),
      ]);
      expect(allowed.filter(Boolean)).toHaveLength(1);
      const winner = allowed[0] ? state.job : newer;
      const blocked = allowed[0] ? newer : state.job;
      await publicRepo.finishDelivery(winner, 'sent', 'synthetic-receipt');
      expect(await publicRepo.beginDelivery(blocked)).toBe(false);
      expect((await a.history()).filter((entry) => entry.status === 'sent')).toHaveLength(1);
    });
    it('can pause an existing kickoff subscription after the key is removed but cannot resume or edit it', async () => {
      const followed = await a.followFromChat(kickoffInput, 'Vasco', '07:00');
      vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', '');
      expect(await a.change(followed.interest.id, { active: false })).toMatchObject({
        active: false,
      });
      const paused = await a.get(followed.interest.id);
      await expect(a.change(followed.interest.id, { active: true })).rejects.toThrow();
      await expect(
        a.change(followed.interest.id, { active: false, leadMinutes: 15 })
      ).rejects.toThrow();
      expect(await a.get(followed.interest.id)).toEqual(paused);
    });
    it('keeps the global clock and other queued topics when following before football kickoff', async () => {
      const { i, row, revision, payload } = await prepare();
      const pref = await a.preferences();
      const other = (await publicRepo.claimDeliveries())[0]!;
      const result = await a.followFromChat(kickoffInput, 'Vasco', '19:45');
      expect(result.interest).toMatchObject({ delivery: 'before', leadMinutes: 60, active: true });
      expect(await a.preferences()).toEqual(pref);
      expect((await a.get(i.id))!.input).toEqual(row.input);
      expect((await a.get(i.id))!.active).toBe(true);
      expect(await publicRepo.deliveryCurrent(other)).toBe(true);
      expect(await b.list()).toEqual([]);
      expect(result.keptPaused).toBe(0);
      expect(
        await publicRepo.queue(
          userA,
          row,
          revision,
          other.event_key,
          payload,
          new Date(Date.now() + 3600000)
        )
      ).toBe(false);
    });
    it('activates only the requested before topic from a globally paused account', async () => {
      const old = await create();
      await a.savePreferences({ ...RADAR_DEFAULT_PREFERENCES, enabled: false, time: '08:15' });
      const result = await a.followFromChat(kickoffInput, 'Vasco', '19:45');
      expect(result.keptPaused).toBe(1);
      expect((await a.get(old.id))!.active).toBe(false);
      expect((await a.preferences()).preferences).toMatchObject({ enabled: true, time: '08:15' });
      expect(result.interest).toMatchObject({ active: true, delivery: 'before' });
      expect((await b.preferences()).preferences.enabled).toBe(false);
    });
    it('explicitly replaces only the same team mode and cancels its old unsent day notice', async () => {
      await create();
      await enable();
      const day = await a.followFromChat(
        { ...kickoffInput, delivery: 'matchday', notifyTime: '09:00' },
        'Vasco',
        '09:00'
      );
      const old = (await a.get(day.interest.id))!;
      const pref = await a.preferences();
      await publicRepo.queue(
        userA,
        old,
        pref.revision,
        'old-day-notice',
        { title: 'Vasco', text: '', source: '', url: '' },
        new Date(Date.now() + 3600000)
      );
      const leased = (await publicRepo.claimDeliveries())[0]!;
      const next = await a.followFromChat(kickoffInput, 'Vasco', '19:45');
      expect(next.interest.id).toBe(day.interest.id);
      expect(next.interest).toMatchObject({ delivery: 'before' });
      expect(next.interest).not.toHaveProperty('notifyTime');
      expect((await a.list()).filter((topic) => topic.source === 'football')).toHaveLength(1);
      expect((await a.list()).find((topic) => topic.source === 'currency')!.active).toBe(true);
      expect(await a.preferences()).toEqual(pref);
      expect(await publicRepo.beginDelivery(leased)).toBe(false);
    });
    it('serializes duplicate kickoff evaluation, fences a reschedule and creates one new event', async () => {
      const followed = await a.followFromChat(kickoffInput, 'Vasco', '07:00');
      const interest = (await a.get(followed.interest.id))!;
      const instant = new Date();
      const snapshot: RadarSnapshot = {
        observedAt: instant.toISOString(),
        expiresAt: new Date(instant.getTime() + 20 * 60000).toISOString(),
        sourceLabel: 'DadosFutebol',
        sourceUrl: 'https://example.org/',
        items: [
          {
            id: 'legacy-match',
            title: 'Vasco × Bahia',
            at: new Date(instant.getTime() + 45 * 60000).toISOString(),
            provider: 'football-data',
            providerMatchId: 'mt_synthetic',
            status: 'scheduled',
          },
        ],
      };
      await db.execute('UPDATE radar_resources SET snapshot=$2::jsonb WHERE id=$1', [
        interest.resource_id,
        JSON.stringify(snapshot),
      ]);
      const current = (await a.get(interest.id))!;
      const pref = await a.preferences();
      const [decision] = interestDecisions(current, instant, 'America/Cuiaba');
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          publicRepo.queue(
            userA,
            current,
            pref.revision,
            decision!.key,
            decision!.payload,
            decision!.expiresAt
          )
        )
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const old = (await publicRepo.claimDeliveries())[0]!;
      snapshot.items[0]!.at = new Date(instant.getTime() + 50 * 60000).toISOString();
      await db.execute('UPDATE radar_resources SET snapshot=$2::jsonb WHERE id=$1', [
        interest.resource_id,
        JSON.stringify(snapshot),
      ]);
      const changed = (await a.get(interest.id))!;
      expect(stillMatchesDelivery(changed, old, instant, 'America/Cuiaba')).toBe(false);
      await publicRepo.finishDelivery(old, 'cancelled');
      const [next] = interestDecisions(changed, instant, 'America/Cuiaba');
      expect(next!.key).not.toBe(decision!.key);
      expect(
        await publicRepo.queue(
          userA,
          changed,
          pref.revision,
          next!.key,
          next!.payload,
          next!.expiresAt
        )
      ).toBe(true);
      const fresh = (await publicRepo.claimDeliveries())[0]!;
      expect(fresh.event_key).toBe(next!.key);
      expect(await publicRepo.beginDelivery(old)).toBe(false);
      expect(await publicRepo.beginDelivery(fresh)).toBe(true);
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
    it('stores a matchday clock without replacing the digest clock or either customer time zone', async () => {
      await a.savePreferences({ ...RADAR_DEFAULT_PREFERENCES, time: '08:15' });
      await db.execute(
        "UPDATE customer_accounts SET time_zone='America/Cuiaba' WHERE data_user_id=$1",
        [userA]
      );
      const old = await create();
      const other = await b.create(
        { source: 'currency', target: 'USD', delivery: 'digest', leadMinutes: 60 },
        'USD'
      );
      await enable(b);
      const clocks = await db.query(
        'SELECT data_user_id,time_zone,time_zone_source FROM customer_accounts ORDER BY data_user_id'
      );
      const next = await a.followFromChat(
        {
          source: 'football',
          target: 'br:cr-vasco-da-gama',
          delivery: 'matchday',
          notifyTime: '09:00',
          leadMinutes: 60,
        },
        'Vasco',
        '09:30'
      );
      expect(next.interest).toMatchObject({
        delivery: 'matchday',
        notifyTime: '09:30',
        active: true,
      });
      expect(next.keptPaused).toBe(1);
      expect((await a.get(old.id))!.active).toBe(false);
      expect((await a.preferences()).preferences).toMatchObject({ enabled: true, time: '08:15' });
      expect((await b.get(other.id))!.active).toBe(true);
      expect((await b.preferences()).preferences.time).toBe('07:00');
      expect(
        await db.query(
          'SELECT data_user_id,time_zone,time_zone_source FROM customer_accounts ORDER BY data_user_id'
        )
      ).toEqual(clocks);
    });
    it('keeps other enabled topics untouched when opting into matchday alerts', async () => {
      const old = await create();
      const preferences = await a.savePreferences({
        ...RADAR_DEFAULT_PREFERENCES,
        enabled: true,
        time: '08:15',
      });
      const original = (await a.get(old.id))!;
      await publicRepo.queue(
        userA,
        original,
        preferences.revision,
        'other-topic',
        {
          title: 'USD',
          text: 'Referência',
          source: 'Frankfurter',
          url: 'https://frankfurter.dev/',
        },
        new Date(Date.now() + 3600000)
      );
      const otherDelivery = (await publicRepo.claimDeliveries())[0]!;
      const next = await a.followFromChat(
        {
          source: 'football',
          target: 'br:cr-vasco-da-gama',
          delivery: 'matchday',
          notifyTime: '09:30',
          leadMinutes: 60,
        },
        'Vasco',
        '09:30'
      );
      expect(next.keptPaused).toBe(0);
      expect(await a.get(old.id)).toMatchObject({
        active: true,
        revision: original.revision,
        input: original.input,
      });
      expect((await a.preferences()).preferences).toMatchObject({ enabled: true, time: '08:15' });
      expect(await a.preferences()).toEqual(preferences);
      expect(await publicRepo.deliveryCurrent(otherDelivery)).toBe(true);
    });
    it('starts matchday with a paused digest clock in quiet hours without allowing that digest to resume', async () => {
      await a.savePreferences({
        ...RADAR_DEFAULT_PREFERENCES,
        time: '09:00',
        quietStart: '08:00',
        quietEnd: '10:00',
      });
      const old = await create();
      const followed = await a.followFromChat(
        {
          source: 'football',
          target: 'br:cr-vasco-da-gama',
          delivery: 'matchday',
          notifyTime: '11:00',
          leadMinutes: 60,
        },
        'Vasco',
        '11:00'
      );
      expect((await a.preferences()).preferences).toMatchObject({ enabled: true, time: '09:00' });
      expect(followed.interest).toMatchObject({
        delivery: 'matchday',
        notifyTime: '11:00',
        active: true,
      });
      expect((await a.get(old.id))!.active).toBe(false);
      await expect(a.change(old.id, { active: true })).rejects.toThrow('horário do resumo');
      await expect(
        a.create({ source: 'currency', target: 'EUR', delivery: 'digest', leadMinutes: 60 }, 'EUR')
      ).rejects.toThrow('horário do resumo');
      await expect(a.savePreferences((await a.preferences()).preferences)).rejects.toThrow(
        'horário do resumo'
      );
      expect(
        (
          await a.followFromChat(
            {
              source: 'football',
              target: 'br:cr-vasco-da-gama',
              delivery: 'matchday',
              notifyTime: '11:00',
              leadMinutes: 60,
            },
            'Vasco',
            '12:00'
          )
        ).interest.notifyTime
      ).toBe('12:00');
    });
    it.each(['22:00', '23:30', '06:59'])(
      'rejects matchday time %s during quiet hours without partial opt-in',
      async (time) => {
        const old = await create();
        const before = await a.preferences();
        await expect(
          a.followFromChat(
            {
              source: 'football',
              target: 'br:cr-vasco-da-gama',
              delivery: 'matchday',
              notifyTime: time,
              leadMinutes: 60,
            },
            'Vasco',
            time
          )
        ).rejects.toThrow('fora do período de silêncio');
        expect(await a.preferences()).toEqual(before);
        expect(await a.list()).toHaveLength(1);
        expect((await a.get(old.id))!.active).toBe(true);
        expect(
          (await db.queryOne<{ n: string }>(
            "SELECT COUNT(*) AS n FROM radar_resources WHERE source='football'"
          ))!.n
        ).toBe('0');
      }
    );
    it('accepts the end of quiet hours and validates matchday schedule edits atomically', async () => {
      const next = await a.followFromChat(
        {
          source: 'football',
          target: 'br:cr-vasco-da-gama',
          delivery: 'matchday',
          notifyTime: '07:00',
          leadMinutes: 60,
        },
        'Vasco',
        '07:00'
      );
      const original = (await a.get(next.interest.id))!;
      await expect(a.change(original.id, { notifyTime: '22:00' })).rejects.toThrow(
        'fora do período de silêncio'
      );
      expect(await a.get(original.id)).toEqual(original);
      expect(await a.change(original.id, { notifyTime: '10:30' })).toMatchObject({
        notifyTime: '10:30',
        revision: original.revision + 1,
      });
      expect((await a.preferences()).preferences.time).toBe('07:00');
      expect(await a.change(original.id, { delivery: 'digest' })).toMatchObject({
        delivery: 'digest',
      });
      expect((await a.get(original.id))!.input.notifyTime).toBeUndefined();
    });
    it('does not let dashboard creation bypass the matchday quiet-hour validation', async () => {
      await expect(
        a.create(
          {
            source: 'football',
            target: 'br:cr-vasco-da-gama',
            delivery: 'matchday',
            notifyTime: '23:00',
            leadMinutes: 60,
          },
          'Vasco'
        )
      ).rejects.toThrow('fora do período de silêncio');
      expect(await a.list()).toEqual([]);
      expect(
        (await db.queryOne<{ n: string }>(
          "SELECT COUNT(*) AS n FROM radar_resources WHERE source='football'"
        ))!.n
      ).toBe('0');
    });
    it('rejects quiet-hour edits that would silence an active matchday clock', async () => {
      await a.followFromChat(
        {
          source: 'football',
          target: 'br:cr-vasco-da-gama',
          delivery: 'matchday',
          notifyTime: '09:30',
          leadMinutes: 60,
        },
        'Vasco',
        '09:30'
      );
      const before = await a.preferences();
      await expect(
        a.savePreferences({ ...before.preferences, quietStart: '08:00', quietEnd: '10:00' })
      ).rejects.toThrow('fora do período de silêncio');
      expect(await a.preferences()).toEqual(before);
      expect((await a.list())[0]!).toMatchObject({ active: true, notifyTime: '09:30' });
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
    it.each([true, false])(
      'refreshes football toward the configured provider=%s without touching private state or healthy news',
      async (enabled) => {
        vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', enabled ? 'synthetic-test-key' : '');
        const expected = enabled ? 'API Dados Futebol' : 'openfootball';
        const previous = enabled ? 'openfootball' : 'API Dados Futebol';
        const topic = await a.create(
          {
            source: 'football',
            target: 'br:cr-vasco-da-gama',
            delivery: 'digest',
            leadMinutes: 60,
          },
          'Vasco'
        );
        const revision = await enable();
        const interest = (await a.get(topic.id))!;
        await publicRepo.queue(
          userA,
          interest,
          revision,
          'preserve-football-receipt',
          { title: 'Vasco', text: '', source: previous, url: '' },
          new Date(Date.now() + 3600000)
        );
        const job = (await publicRepo.claimDeliveries())[0]!;
        expect(await publicRepo.beginDelivery(job)).toBe(true);
        await publicRepo.finishDelivery(job, 'sent', 'synthetic-receipt');
        const preferences = await a.preferences();
        const receipt = await db.queryOne('SELECT * FROM customer_radar_outbox WHERE id=$1', [
          job.id,
        ]);
        await db.execute(
          "UPDATE radar_resources SET snapshot=$2::jsonb,error_code=NULL,failures=4,next_poll_at=NOW()+INTERVAL '6 hours' WHERE id=$1",
          [interest.resource_id, JSON.stringify({ sourceLabel: previous })]
        );
        for (const [id, source, label, error] of [
          ['expected-football', 'football', expected, null],
          ['failed-football', 'football', expected, 'provider_unavailable'],
          ['retired-football', 'football', 'football-data.org', null],
          ['healthy-news', 'news', 'Global Voices', null],
        ] as const)
          await db.execute(
            "INSERT INTO radar_resources(id,source,target,label,snapshot,error_code,failures,next_poll_at) VALUES($1,$2,$1,$1,$3::jsonb,$4,4,NOW()+INTERVAL '6 hours')",
            [id, source, JSON.stringify({ sourceLabel: label }), error]
          );
        const expectedBefore = await db.queryOne('SELECT * FROM radar_resources WHERE id=$1', [
          'expected-football',
        ]);
        const newsBefore = await db.queryOne('SELECT * FROM radar_resources WHERE id=$1', [
          'healthy-news',
        ]);
        await publicRepo.refreshReplacedSources();
        for (const id of [interest.resource_id, 'failed-football', 'retired-football']) {
          expect(
            await db.queryOne(
              'SELECT snapshot,error_code,failures,next_poll_at<=NOW() AS due FROM radar_resources WHERE id=$1',
              [id]
            )
          ).toEqual({ snapshot: null, error_code: null, failures: 0, due: true });
        }
        expect(
          await db.queryOne('SELECT * FROM radar_resources WHERE id=$1', ['expected-football'])
        ).toEqual(expectedBefore);
        expect(
          await db.queryOne('SELECT * FROM radar_resources WHERE id=$1', ['healthy-news'])
        ).toEqual(newsBefore);
        expect(await a.preferences()).toEqual(preferences);
        expect(
          await db.queryOne('SELECT * FROM customer_radar_outbox WHERE id=$1', [job.id])
        ).toEqual(receipt);
        expect(await a.get(topic.id)).toMatchObject({
          revision: interest.revision,
          active: true,
          input: interest.input,
        });
      }
    );
    it('preserves an active resource lease while refreshing replaced football adapters', async () => {
      await db.execute(
        "INSERT INTO radar_resources(id,source,target,label,snapshot,next_poll_at,lease_token,leased_until) VALUES('leased-football','football','br:cr-vasco-da-gama','Vasco','{\"sourceLabel\":\"openfootball\"}'::jsonb,NOW()-INTERVAL '1 second','active-lease',NOW()+INTERVAL '3 minutes')"
      );
      const before = await db.queryOne('SELECT * FROM radar_resources WHERE id=$1', [
        'leased-football',
      ]);
      await publicRepo.refreshReplacedSources();
      expect(
        await db.queryOne('SELECT * FROM radar_resources WHERE id=$1', ['leased-football'])
      ).toEqual(before);
      await db.execute(
        "UPDATE radar_resources SET leased_until=NOW()-INTERVAL '1 second' WHERE id='leased-football'"
      );
      await publicRepo.refreshReplacedSources();
      expect(
        await db.queryOne(
          'SELECT snapshot,next_poll_at<=NOW() AS due FROM radar_resources WHERE id=$1',
          ['leased-football']
        )
      ).toEqual({ snapshot: null, due: true });
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
    it('rearms a cancelled matchday job only with the current topic and preference revisions', async () => {
      const next = await a.followFromChat(
        {
          source: 'football',
          target: 'br:cr-vasco-da-gama',
          delivery: 'matchday',
          notifyTime: '09:30',
          leadMinutes: 60,
        },
        'Vasco',
        '09:30'
      );
      const original = (await a.get(next.interest.id))!;
      const pref = await a.preferences();
      const key = original.id + ':matchday:vasco-match:2026-11-16';
      const payload = {
        title: 'Vasco',
        text: 'Jogo hoje',
        source: 'openfootball',
        url: '',
        itemId: 'vasco-match',
        matchDate: '2026-11-16',
      };
      const expiry = new Date(Date.now() + 3600000);
      expect(await publicRepo.queue(userA, original, pref.revision, key, payload, expiry)).toBe(
        true
      );
      const leased = (await publicRepo.claimDeliveries())[0]!;
      await a.followFromChat({ ...original.input, notifyTime: '10:30' }, 'Vasco', '10:30');
      const current = (await a.get(original.id))!;
      await a.savePreferences({ ...(await a.preferences()).preferences, time: '08:15' });
      const currentPref = await a.preferences();
      await db.execute(
        "UPDATE customer_radar_outbox SET not_before=NOW()+INTERVAL '1 hour' WHERE id=$1",
        [leased.id]
      );
      expect(
        await publicRepo.queue(userA, original, currentPref.revision, key, payload, expiry)
      ).toBe(false);
      expect(await publicRepo.queue(userA, current, pref.revision, key, payload, expiry)).toBe(
        false
      );
      expect(
        await publicRepo.queue(userB, current, currentPref.revision, key, payload, expiry)
      ).toBe(false);
      const updatedPayload = { ...payload, text: 'Aviso no novo horário' };
      expect(
        await publicRepo.queue(userA, current, currentPref.revision, key, updatedPayload, expiry)
      ).toBe(true);
      expect(
        await publicRepo.queue(userA, current, currentPref.revision, key, updatedPayload, expiry)
      ).toBe(false);
      expect(await a.history()).toHaveLength(1);
      const rearmed = (await publicRepo.claimDeliveries())[0]!;
      expect(rearmed).toMatchObject({
        id: leased.id,
        interest_revision: current.revision,
        preference_revision: currentPref.revision,
        payload: updatedPayload,
      });
      expect(rearmed.lease_token).not.toBe(leased.lease_token);
      expect(await publicRepo.beginDelivery(leased)).toBe(false);
      expect(await publicRepo.beginDelivery(rearmed)).toBe(true);
    });
    it('can rearm an unsent cancelled event after an explicit topic resume', async () => {
      const { i, row, revision, payload } = await prepare();
      const key = i.id + ':event';
      const expiry = new Date(Date.now() + 3600000);
      await a.change(i.id, { active: false });
      expect(await publicRepo.queue(userA, row, revision, key, payload, expiry)).toBe(false);
      expect(
        await publicRepo.queue(userA, (await a.get(i.id))!, revision, key, payload, expiry)
      ).toBe(false);
      await a.change(i.id, { active: true });
      expect(
        await publicRepo.queue(userA, (await a.get(i.id))!, revision, key, payload, expiry)
      ).toBe(true);
      expect(await publicRepo.claimDeliveries()).toHaveLength(1);
    });
    it('rearms the same matchday key after stale source cancellation and a fresh snapshot', async () => {
      const followed = await a.followFromChat(
        {
          source: 'football',
          target: 'br:cr-vasco-da-gama',
          delivery: 'matchday',
          notifyTime: '09:30',
          leadMinutes: 60,
        },
        'Vasco',
        '09:30'
      );
      const now = new Date('2099-11-16T13:30:00Z');
      const later = new Date('2099-11-16T13:31:00Z');
      const snapshot: RadarSnapshot = {
        items: [
          { id: 'vasco-match', title: 'Vasco × Santos', date: '2099-11-16', status: 'scheduled' },
        ],
        observedAt: now.toISOString(),
        expiresAt: '2099-11-16T13:30:30Z',
        sourceLabel: 'openfootball',
        sourceUrl: 'https://github.com/openfootball/south-america',
      };
      const original = (await a.get(followed.interest.id))!;
      await db.execute('UPDATE radar_resources SET snapshot=$2::jsonb WHERE id=$1', [
        original.resource_id,
        JSON.stringify(snapshot),
      ]);
      const interest = (await a.get(original.id))!;
      const [decision] = interestDecisions(interest, now, 'America/Campo_Grande');
      const { revision } = await a.preferences();
      expect(decision!.expiresAt.getTime()).toBeGreaterThan(later.getTime());
      expect(
        await publicRepo.queue(
          userA,
          interest,
          revision,
          decision!.key,
          decision!.payload,
          decision!.expiresAt
        )
      ).toBe(true);
      const oldJob = (await publicRepo.claimDeliveries())[0]!;
      expect(stillMatchesDelivery(interest, oldJob, later, 'America/Campo_Grande')).toBe(false);
      await publicRepo.finishDelivery(oldJob, 'cancelled');
      await db.execute('UPDATE radar_resources SET snapshot=$2::jsonb WHERE id=$1', [
        interest.resource_id,
        JSON.stringify({
          ...snapshot,
          observedAt: later.toISOString(),
          expiresAt: '2099-11-16T14:31:00Z',
        }),
      ]);
      const refreshed = (await a.get(interest.id))!;
      const [next] = interestDecisions(refreshed, later, 'America/Campo_Grande');
      expect(next!.key).toBe(decision!.key);
      expect(refreshed.revision).toBe(interest.revision);
      expect(
        await publicRepo.queue(
          userA,
          refreshed,
          revision,
          next!.key,
          next!.payload,
          next!.expiresAt
        )
      ).toBe(true);
      const rearmed = (await publicRepo.claimDeliveries())[0]!;
      expect(rearmed.id).toBe(oldJob.id);
      expect(stillMatchesDelivery(refreshed, rearmed, later, 'America/Campo_Grande')).toBe(true);
      expect(await publicRepo.beginDelivery(oldJob)).toBe(false);
      expect(await publicRepo.beginDelivery(rearmed)).toBe(true);
    });
    it.each(['sent', 'unknown'] as const)(
      'never replays a %s event after rescheduling or a preference edit',
      async (status) => {
        const { i, payload } = await prepare();
        const job = (await publicRepo.claimDeliveries())[0]!;
        expect(await publicRepo.beginDelivery(job)).toBe(true);
        await publicRepo.finishDelivery(
          job,
          status,
          status === 'sent' ? 'confirmed-receipt' : undefined
        );
        await a.change(i.id, { active: false });
        await a.change(i.id, { active: true });
        const revision = await enable();
        expect(
          await publicRepo.queue(
            userA,
            (await a.get(i.id))!,
            revision,
            job.event_key,
            payload,
            new Date(Date.now() + 3600000)
          )
        ).toBe(false);
        expect(await publicRepo.claimDeliveries()).toEqual([]);
        expect((await a.history())[0]!.status).toBe(status);
      }
    );
    it('does not reuse a cancelled event key for a different topic', async () => {
      const { i, revision, payload } = await prepare();
      await a.change(i.id, { active: false });
      const another = await a.create(
        { source: 'currency', target: 'EUR', delivery: 'digest', leadMinutes: 60 },
        'EUR'
      );
      expect(
        await publicRepo.queue(
          userA,
          (await a.get(another.id))!,
          revision,
          i.id + ':event',
          payload,
          new Date(Date.now() + 3600000)
        )
      ).toBe(false);
      expect(await publicRepo.claimDeliveries()).toEqual([]);
    });
    it('does not rearm a cancelled event with proof of any prior transmission', async () => {
      const { i, revision, payload } = await prepare();
      await a.change(i.id, { active: false });
      await a.change(i.id, { active: true });
      await db.execute(
        "UPDATE customer_radar_outbox SET payload=jsonb_set(payload,'{deliveredParts}',$1::jsonb)",
        [JSON.stringify([{ index: 0, transportId: 'confirmed-part' }])]
      );
      expect(
        await publicRepo.queue(
          userA,
          (await a.get(i.id))!,
          revision,
          i.id + ':event',
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
