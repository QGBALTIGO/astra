import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapters/types.js';
const state = vi.hoisted(() => ({ adapter: null as DatabaseAdapter | null }));
vi.mock('../../db/adapters/index.js', () => ({
  getAdapter: async () => {
    if (!state.adapter) throw Error('No lab DB');
    return state.adapter;
  },
}));
import { radarTestDatabase } from '../../db/repositories/radar-pg-fixture.js';
import { collectRadar, evaluateRadar } from './worker.js';
import { RADAR_DEFAULT_PREFERENCES } from './contracts.js';
import { BRAZIL_TEAMS } from './football.js';

/** Opt-in synthetic component benchmark. No external network or messaging transport. */
describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT || process.env.ASTRA_RADAR_LOAD_TEST !== 'true')(
  'Radar isolated database/evaluator capacity scenarios',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    beforeAll(async () => {
      fixture = await radarTestDatabase();
      state.adapter = fixture.adapter;
    });
    afterAll(async () => {
      state.adapter = null;
      await fixture?.close();
    });
    it.each([500, 2000, 5000, 10000])(
      'evaluates %i synthetic accounts sharing 3 public resources',
      async (count) => {
        const db = fixture.adapter;
        await db.exec(
          'TRUNCATE customer_radar_outbox,customer_radar_interests,customer_radar_preferences,radar_resources,customer_accounts,channel_users CASCADE'
        );
        await db.execute(
          `INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,is_verified,status,access_expires_at)
   SELECT 'load-channel-'||n,'whatsapp:5599000'||LPAD(n::text,5,'0'),'whatsapp','5599000'||LPAD(n::text,5,'0'),TRUE,'active',NOW()+INTERVAL '3 days' FROM generate_series(1,$1::integer) n`,
          [count]
        );
        await db.execute(
          `INSERT INTO customer_accounts(id,channel_user_id,data_user_id,current_phone,time_zone,time_zone_source)
   SELECT 'load-account-'||n,'load-channel-'||n,'whatsapp:5599000'||LPAD(n::text,5,'0'),'5599000'||LPAD(n::text,5,'0'),'America/Campo_Grande','manual' FROM generate_series(1,$1::integer)n`,
          [count]
        );
        await db.execute(
          `INSERT INTO customer_radar_preferences(user_id,preferences) SELECT data_user_id,$1::jsonb FROM customer_accounts`,
          [JSON.stringify({ ...RADAR_DEFAULT_PREFERENCES, enabled: true })]
        );
        const now = new Date();
        now.setUTCHours(11, 0, 0, 0);
        const snapshot = {
          items: [
            { id: 'reference', title: 'Referência pública', text: 'Dado sintético de laboratório' },
          ],
          observedAt: new Date(now.getTime() - 60000).toISOString(),
          expiresAt: new Date(now.getTime() + 86400000).toISOString(),
          sourceLabel: 'Fonte sintética',
          sourceUrl: 'https://example.com/',
        };
        for (const [source, target] of [
          ['currency', 'USD'],
          ['ptax', 'EUR'],
          ['news', 'tecnologia'],
        ]) {
          const id = source + '-shared';
          await db.execute(
            'INSERT INTO radar_resources(id,source,target,label,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)',
            [id, source, target, target, JSON.stringify(snapshot)]
          );
          await db.execute(
            `INSERT INTO customer_radar_interests(id,user_id,resource_id,input,label) SELECT data_user_id||$1,data_user_id,$1,$2::jsonb,$1 FROM customer_accounts`,
            [id, JSON.stringify({ source, target, delivery: 'digest', leadMinutes: 60 })]
          );
        }
        const batches: number[] = [];
        const start = performance.now();
        let queued = 0;
        // One extra call resets the worker's pagination cursor; no sending loop is started.
        for (let n = 0; n < Math.ceil(count / 100) + 1; n++) {
          const t = performance.now();
          queued += await evaluateRadar(now);
          batches.push(performance.now() - t);
        }
        const elapsedMs = performance.now() - start;
        const actual = Number(
          (await db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM customer_radar_outbox'))!.n
        );
        expect(queued).toBe(count);
        expect(actual).toBe(count);
        expect(
          Number((await db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM radar_resources'))!.n)
        ).toBe(3);
        const repeat = await evaluateRadar(now);
        expect(repeat).toBe(0);
        // Finish pagination after the duplicate check so the next scenario starts from the beginning.
        for (let n = 1; n < Math.ceil(count / 100) + 1; n++) await evaluateRadar(now);
        batches.sort((a, b) => a - b);
        const percentile = (p: number) =>
          Math.round(
            batches[Math.min(batches.length - 1, Math.ceil(batches.length * p) - 1)]! * 100
          ) / 100;
        console.log(
          'RADAR_COMPONENT_BENCHMARK ' +
            JSON.stringify({
              accounts: count,
              follows: count * 3,
              resources: 3,
              queued,
              errorCount: count - actual,
              elapsedMs: Math.round(elapsedMs),
              accountsPerSecond: Math.round((count / elapsedMs) * 1000),
              batch100: {
                p50Ms: percentile(0.5),
                p95Ms: percentile(0.95),
                p99Ms: percentile(0.99),
              },
              nodeHeapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
              note: 'local PostgreSQL/evaluator only; no API/WhatsApp/production capacity claim',
            })
        );
      },
      120000
    );
    it('shares three public reads across 500 kickoff subscriptions for 20 teams without crossing accounts or replaying jobs', async () => {
      const db = fixture.adapter;
      const now = new Date();
      const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
        .format(now)
        .slice(0, 4);
      const competition = {
        id: 'cp_000000000001',
        name: 'Brasileirão Série A',
        country_code: 'BRA',
        current_season: year,
      };
      const teams = BRAZIL_TEAMS.map((team, index) => ({
        id: 'tm_' + String(index + 1).padStart(12, '0'),
        name: team[2],
        short_name: team[1],
      }));
      const matches = Array.from({ length: 10 }, (_, index) => ({
        id: 'mt_' + String(index + 1).padStart(12, '0'),
        competition: { id: competition.id, name: competition.name },
        season: year,
        round: '35',
        status: 'scheduled',
        kickoff_at: new Date(now.getTime() + 30 * 60000).toISOString(),
        home_team: teams[index * 2]!,
        away_team: teams[index * 2 + 1]!,
      }));
      const expectedMatchByTeam = new Map(
        BRAZIL_TEAMS.map((team, index) => ['br:' + team[0], matches[Math.floor(index / 2)]!.id])
      );
      const fetchMock = vi.fn(async (raw: string, options?: RequestInit) => {
        const url = new URL(raw);
        expect(url.origin).toBe('https://futapi.p.rapidapi.com');
        expect(url.searchParams.has('team')).toBe(false);
        expect(options?.headers).toMatchObject({
          'x-rapidapi-host': 'futapi.p.rapidapi.com',
          'x-rapidapi-key': 'synthetic-load-football-key',
        });
        let data: unknown;
        if (url.pathname === '/v1/competitions') data = [competition];
        else if (url.pathname === '/v1/competitions/' + competition.id + '/teams') data = teams;
        else if (url.pathname === '/v1/competitions/' + competition.id + '/matches') data = matches;
        else throw Error('Unexpected synthetic provider route');
        return new Response(JSON.stringify({ data, paging: null, meta: null }));
      });
      vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-load-football-key');
      vi.stubGlobal('fetch', fetchMock);
      // Freeze only Date: real PG and streaming/microtasks keep running, while
      // one collection cannot change its public URL at Brazilian midnight.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      try {
        await db.exec(
          'TRUNCATE customer_radar_outbox,customer_radar_interests,customer_radar_preferences,radar_resources,radar_http_cache,radar_provider_limits,customer_accounts,channel_users CASCADE'
        );
        await db.execute(`INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,is_verified,status,access_expires_at)
          SELECT 'kickoff-channel-'||n,'whatsapp:5599000'||LPAD(n::text,5,'0'),'whatsapp','5599000'||LPAD(n::text,5,'0'),TRUE,'active',NOW()+INTERVAL '3 days' FROM generate_series(1,500)n`);
        await db.execute(`INSERT INTO customer_accounts(id,channel_user_id,data_user_id,current_phone,time_zone,time_zone_source)
          SELECT 'kickoff-account-'||n,'kickoff-channel-'||n,'whatsapp:5599000'||LPAD(n::text,5,'0'),'5599000'||LPAD(n::text,5,'0'),
          CASE WHEN n%2=0 THEN 'America/Cuiaba' ELSE 'Asia/Tokyo' END,'manual' FROM generate_series(1,500)n`);
        await db.execute(
          'INSERT INTO customer_radar_preferences(user_id,preferences) SELECT data_user_id,$1::jsonb FROM customer_accounts',
          [
            JSON.stringify({
              ...RADAR_DEFAULT_PREFERENCES,
              enabled: true,
              quietStart: '00:00',
              quietEnd: '00:00',
            }),
          ]
        );
        for (const [index, team] of BRAZIL_TEAMS.entries()) {
          const resource = 'kickoff-shared-' + index;
          const target = 'br:' + team[0];
          await db.execute(
            "INSERT INTO radar_resources(id,source,target,label) VALUES($1,'football',$2,$3)",
            [resource, target, team[1]]
          );
          await db.execute(
            `INSERT INTO customer_radar_interests(id,user_id,resource_id,input,label)
            SELECT data_user_id||':before:'||$1,data_user_id,$1,$2::jsonb,$3 FROM customer_accounts
            WHERE ((RIGHT(current_phone,5)::integer-1)%20)=$4`,
            [
              resource,
              JSON.stringify({ source: 'football', target, delivery: 'before', leadMinutes: 60 }),
              team[1],
              index,
            ]
          );
        }
        let collected = 0;
        for (let batch = 0; batch < 5; batch++) collected += await collectRadar();
        expect(collected).toBe(20);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls.map(([raw]) => new URL(raw).pathname).sort()).toEqual(
          [
            '/v1/competitions',
            '/v1/competitions/' + competition.id + '/matches',
            '/v1/competitions/' + competition.id + '/teams',
          ].sort()
        );
        const quota = await db.queryOne<{ n: string }>(
          "SELECT SUM(body::integer)::text AS n FROM radar_http_cache WHERE key LIKE 'budget:futapi:%'"
        );
        expect(quota!.n).toBe('3');
        let queued = 0;
        for (let batch = 0; batch < 6; batch++) queued += await evaluateRadar(now);
        expect(queued).toBe(500);
        const jobs = await db.query<{
          user_id: string;
          interest_user: string;
          phone: string;
          target: string;
          provider_match: string;
          provider: string;
          title: string;
        }>(
          `SELECT o.user_id,i.user_id AS interest_user,a.current_phone AS phone,i.input->>'target' AS target,
          o.payload->>'providerMatchId' AS provider_match,o.payload->>'provider' AS provider,o.payload->>'title' AS title
          FROM customer_radar_outbox o JOIN customer_radar_interests i ON i.id=o.interest_id
          JOIN customer_accounts a ON a.data_user_id=o.user_id`
        );
        expect(jobs).toHaveLength(500);
        expect(new Set(jobs.map((job) => job.user_id)).size).toBe(500);
        for (const job of jobs) {
          const teamIndex = (Number(job.phone.slice(-5)) - 1) % 20;
          expect(job.user_id).toBe(job.interest_user);
          expect(job.user_id).toBe('whatsapp:' + job.phone);
          expect(job.target).toBe('br:' + BRAZIL_TEAMS[teamIndex]![0]);
          expect(job.provider_match).toBe(expectedMatchByTeam.get(job.target));
          expect(job.provider).toBe('football-data');
          expect(job.title).toContain(BRAZIL_TEAMS[teamIndex]![1]);
        }
        expect(
          (await db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM radar_resources'))!.n
        ).toBe('20');
        let repeated = 0;
        for (let batch = 0; batch < 6; batch++) repeated += await evaluateRadar(now);
        expect(repeated).toBe(0);
        expect(
          (await db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM customer_radar_outbox'))!.n
        ).toBe('500');
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    }, 120000);
  }
);
