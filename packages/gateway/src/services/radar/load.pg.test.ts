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
import { evaluateRadar } from './worker.js';
import { RADAR_DEFAULT_PREFERENCES } from './contracts.js';

/** Opt-in synthetic component benchmark. Never calls a provider or a messaging transport. */
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
  }
);
