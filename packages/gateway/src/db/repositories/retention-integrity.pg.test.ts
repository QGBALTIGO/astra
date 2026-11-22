import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { DatabaseAdapter } from '../adapters/types.js';
import { WORKFLOWS_TABLES_SQL } from '../schema/workflows.js';
import { WorkflowsRepository } from './workflows/index.js';

describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)(
  'retention against the actual PostgreSQL schema',
  () => {
    let client: Client;
    let adapter: DatabaseAdapter;
    const connected = <T extends object>(repo: T): T => Object.assign(repo, { adapter });
    beforeAll(async () => {
      client = new Client({
        host: '127.0.0.1',
        port: Number(process.env.ASTRA_REVIEW_PG_PORT),
        user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
        database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
        password: process.env.ASTRA_REVIEW_PG_PASSWORD,
      });
      await client.connect();
      await client.query('SET search_path TO pg_temp');
      for (const table of ['workflows', 'workflow_logs']) {
        const ddl = WORKFLOWS_TABLES_SQL.match(
          new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);')
        )?.[0];
        if (!ddl) throw new Error('Missing actual schema: ' + table);
        await client.query(ddl.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
      }
      adapter = {
        isConnected: () => true,
        execute: async (sql: string, params?: unknown[]) => ({
          changes: (await client.query(sql, params)).rowCount ?? 0,
        }),
      } as unknown as DatabaseAdapter;
    });
    beforeEach(async () => {
      await client.query('TRUNCATE workflow_logs, workflows');
    });
    afterAll(async () => {
      await client?.end();
    });

    it('removes only old terminal workflows, preserving recent completion and active approval waits', async () => {
      await client.query(`INSERT INTO workflow_logs(id,status,started_at,completed_at) VALUES
      ('old-completed','completed',NOW()-INTERVAL '120 days',NOW()-INTERVAL '100 days'),
      ('old-failed','failed',NOW()-INTERVAL '120 days',NULL),
      ('old-cancelled','cancelled',NOW()-INTERVAL '120 days',NOW()-INTERVAL '100 days'),
      ('recent-completed','completed',NOW()-INTERVAL '120 days',NOW()-INTERVAL '1 day'),
      ('running','running',NOW()-INTERVAL '120 days',NULL),
      ('waiting','awaiting_approval',NOW()-INTERVAL '120 days',NULL)`);
      expect(await connected(new WorkflowsRepository('default')).cleanupOldWorkflowLogs(90)).toBe(
        3
      );
      expect(
        (await client.query('SELECT id FROM workflow_logs ORDER BY id')).rows.map((row) => row.id)
      ).toEqual(['recent-completed', 'running', 'waiting']);
    });

    it('cleans thousands of expired rows once and preserves recent and active rows', async () => {
      await client.query(`INSERT INTO workflow_logs (id, status, started_at, completed_at)
        SELECT 'old-' || n, 'completed', NOW() - INTERVAL '120 days', NOW() - INTERVAL '100 days'
        FROM generate_series(1, 10000) n`);
      await client.query(`INSERT INTO workflow_logs (id, status, started_at, completed_at)
        SELECT 'running-' || n, 'running', NOW() - INTERVAL '120 days', NULL
        FROM generate_series(1, 1000) n`);
      const repo = connected(new WorkflowsRepository('default'));
      expect(await repo.cleanupOldWorkflowLogs(90)).toBe(10000);
      expect(await repo.cleanupOldWorkflowLogs(90)).toBe(0);
      expect((await client.query('SELECT count(*)::int AS n FROM workflow_logs')).rows[0]?.n).toBe(
        1000
      );
    });
  }
);
