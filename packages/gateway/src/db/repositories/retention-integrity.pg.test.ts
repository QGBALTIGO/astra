import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { DatabaseAdapter } from '../adapters/types.js';
import { WORKFLOWS_TABLES_SQL } from '../schema/workflows.js';
import { AUTONOMOUS_TABLES_SQL } from '../schema/autonomous.js';
import { WorkflowsRepository } from './workflows/index.js';
import { TriggersRepository } from './triggers.js';

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
      for (const [source, tables] of [
        [WORKFLOWS_TABLES_SQL, ['workflows', 'workflow_logs']],
        [AUTONOMOUS_TABLES_SQL, ['triggers', 'trigger_history']],
      ] as const) {
        for (const table of tables) {
          const ddl = source.match(
            new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);')
          )?.[0];
          if (!ddl) throw new Error('Missing actual schema: ' + table);
          await client.query(ddl.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
        }
      }
      adapter = {
        isConnected: () => true,
        execute: async (sql: string, params?: unknown[]) => ({
          changes: (await client.query(sql, params)).rowCount ?? 0,
        }),
      } as unknown as DatabaseAdapter;
    });
    beforeEach(async () => {
      await client.query('TRUNCATE workflow_logs, workflows, trigger_history, triggers');
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

    it('cleans the nightly trigger history for every customer, including deleted triggers', async () => {
      await client.query(`INSERT INTO triggers(id,user_id,name,type) VALUES
      ('a','whatsapp:synthetic-a','A','schedule'), ('b','whatsapp:synthetic-b','B','schedule')`);
      await client.query(`INSERT INTO trigger_history(id,trigger_id,fired_at,status) VALUES
      ('old-a','a',NOW()-INTERVAL '40 days','success'),
      ('old-b','b',NOW()-INTERVAL '40 days','failure'),
      ('orphan','deleted-trigger',NOW()-INTERVAL '40 days','success'),
      ('recent-a','a',NOW()-INTERVAL '1 day','success')`);
      expect(await connected(new TriggersRepository('default')).cleanupAllHistory(30)).toBe(3);
      expect((await client.query('SELECT id FROM trigger_history')).rows).toEqual([
        { id: 'recent-a' },
      ]);
    });

    it('keeps ordinary user-scoped cleanup from deleting another customer’s history', async () => {
      await client.query(`INSERT INTO triggers(id,user_id,name,type) VALUES
      ('a','user-a','A','schedule'), ('b','user-b','B','schedule')`);
      await client.query(`INSERT INTO trigger_history(id,trigger_id,fired_at,status) VALUES
      ('old-a','a',NOW()-INTERVAL '40 days','success'), ('old-b','b',NOW()-INTERVAL '40 days','success')`);
      expect(await connected(new TriggersRepository('user-a')).cleanupHistory(30)).toBe(1);
      expect((await client.query('SELECT id FROM trigger_history')).rows).toEqual([
        { id: 'old-b' },
      ]);
    });
  }
);
