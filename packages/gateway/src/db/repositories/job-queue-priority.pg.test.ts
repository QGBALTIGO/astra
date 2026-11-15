import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../adapters/types.js';
import { CORE_TABLES_SQL } from '../schema/core.js';
import { getJobsRepository } from './jobs.js';

describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)('job priorities in real PostgreSQL', () => {
  const schema = 'queue_' + randomUUID().replaceAll('-', '');
  let admin: Client;
  let pool: Pool;
  const repo = getJobsRepository();
  beforeAll(async () => {
    const config = {
      host: '127.0.0.1',
      port: Number(process.env.ASTRA_REVIEW_PG_PORT),
      user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
      database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
      password: process.env.ASTRA_REVIEW_PG_PASSWORD,
    };
    admin = new Client(config);
    await admin.connect();
    await admin.query('CREATE SCHEMA ' + schema);
    pool = new Pool({ ...config, max: 4, options: '-c search_path=' + schema });
    const ddl = CORE_TABLES_SQL.match(/CREATE TABLE IF NOT EXISTS jobs \([\s\S]*?\n\);/)?.[0];
    if (!ddl) throw new Error('Missing real job schema');
    await pool.query(ddl);
    Object.assign(repo, {
      adapter: {
        isConnected: () => true,
        query: async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows,
        queryOne: async (sql: string, params?: unknown[]) =>
          (await pool.query(sql, params)).rows[0] ?? null,
        execute: async (sql: string, params?: unknown[]) => ({
          changes: (await pool.query(sql, params)).rowCount ?? 0,
        }),
      } as unknown as DatabaseAdapter,
    });
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE jobs');
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await admin.end();
    }
  });
  const create = (
    id: string,
    priority: number,
    queue = 'test',
    runAfter = new Date('2020-01-01')
  ) => repo.create({ id, name: 'synthetic', queue, priority, runAfter });

  it('claims high, normal and low priorities in order without starving positive priorities', async () => {
    await create('low', -5);
    await create('normal', 0);
    await create('high', 100);
    expect((await repo.claimJob('test'))?.id).toBe('high');
    expect((await repo.claimJob('test'))?.id).toBe('normal');
    expect((await repo.claimJob('test'))?.id).toBe('low');
  });

  it('preserves an explicit maximum priority and does not consume another queue', async () => {
    await create('normal', 0);
    await create('high', 100);
    await create('foreign', 0, 'other');
    expect((await repo.claimJob('test', 0))?.id).toBe('normal');
    expect(await repo.claimJob('test', 0)).toBeNull();
    expect((await repo.getById('foreign'))?.status).toBe('available');
  });

  it('claims concurrent high-priority jobs exactly once across separate database connections', async () => {
    await Promise.all(Array.from({ length: 16 }, (_, i) => create('job-' + i, i + 1)));
    const claimed = await Promise.all(Array.from({ length: 16 }, () => repo.claimJob('test')));
    expect(claimed.every(Boolean)).toBe(true);
    expect(new Set(claimed.map((x) => x?.id)).size).toBe(16);
    expect(await repo.claimJob('test')).toBeNull();
  });

  it('does not execute a future high-priority job early', async () => {
    await create('future', 100, 'test', new Date('2100-01-01'));
    expect(await repo.claimJob('test')).toBeNull();
    expect((await repo.getById('future'))?.status).toBe('available');
  });

  it('reserves a recurring execution exactly once under concurrent enqueue retries', async () => {
    const input = {
      id: 'daily-run',
      name: 'nightly_retention_cleanup',
      queue: 'system',
      priority: 100,
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.create(input, true)));
    expect(results.every((x) => x.id === 'daily-run')).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM jobs')).rows[0]?.n).toBe(1);
  });

  it('allows new versioned priorities while holding the legacy backlog for reconciliation', async () => {
    await create('legacy', 100);
    await repo.create({
      id: 'new',
      name: 'synthetic',
      queue: 'test',
      priority: 50,
      payload: { _astraQueueVersion: 1 },
    });
    expect((await repo.claimJob('test', 0, true))?.id).toBe('new');
    expect(await repo.claimJob('test', 0, true)).toBeNull();
    expect((await repo.getById('legacy'))?.status).toBe('available');
  });

  it('rejects a changed request reusing an existing recurring reservation', async () => {
    const input = { id: 'daily', name: 'daily', queue: 'system', payload: { day: '2090-01-01' } };
    await repo.create(input, true);
    await expect(repo.create({ ...input, payload: { day: '2090-01-02' } }, true)).rejects.toThrow(
      'reservation conflict'
    );
    expect((await repo.getById('daily'))?.payload).toEqual(input.payload);
  });

  it('lets a typed worker claim only its own job name from a shared queue', async () => {
    await repo.create({
      id: 'other',
      name: 'other',
      queue: 'system',
      priority: 200,
      payload: { _astraQueueVersion: 1 },
    });
    await repo.create({
      id: 'daily',
      name: 'nightly_retention_cleanup',
      queue: 'system',
      priority: 100,
      payload: { _astraQueueVersion: 1 },
    });
    expect((await repo.claimJob('system', 0, true, 'nightly_retention_cleanup'))?.id).toBe('daily');
    expect((await repo.getById('other'))?.status).toBe('available');
  });
});
