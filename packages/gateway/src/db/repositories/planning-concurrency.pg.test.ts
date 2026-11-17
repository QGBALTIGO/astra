import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../adapters/types.js';
import { FINANCE_TABLES_SQL } from '../schema/finance.js';
import { CUSTOMER_PORTAL_TABLES_SQL } from '../schema/customer-portal.js';
import { CustomerFinanceRepository } from './customer-finance.js';
import { CustomerPlanningRepository } from './customer-planning.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)('planning and category concurrency', () => {
  const schema = 'aud015_' + randomUUID().replaceAll('-', '');
  const clients: Client[] = [];
  let plans: CustomerPlanningRepository;
  let finance: CustomerFinanceRepository;
  let afterCategoryLock: (() => Promise<void>) | undefined;

  function adapter(client: Client, onQuery?: (sql: string) => Promise<void>): DatabaseAdapter {
    let inTransaction = false;
    const query = async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      await onQuery?.(sql);
      return result;
    };
    return {
      isConnected: () => true,
      query: async (sql: string, params?: unknown[]) => (await query(sql, params)).rows,
      queryOne: async (sql: string, params?: unknown[]) =>
        (await query(sql, params)).rows[0] ?? null,
      execute: async (sql: string, params?: unknown[]) => ({
        changes: (await query(sql, params)).rowCount ?? 0,
      }),
      transaction: async <T>(fn: () => Promise<T>) => {
        if (inTransaction) throw new Error('Unexpected nested planning transaction');
        inTransaction = true;
        await client.query('BEGIN');
        try {
          const result = await fn();
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          inTransaction = false;
        }
      },
    } as unknown as DatabaseAdapter;
  }

  async function waitUntilBlocked(client: Client) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await clients[2]!.query(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [(client as Client & { processID: number }).processID]
      );
      if (result.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Expected concurrent operation to wait for a database lock');
  }

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const client = new Client({
        host: '127.0.0.1',
        port: Number(process.env.ASTRA_REVIEW_PG_PORT),
        user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
        database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
        password: process.env.ASTRA_REVIEW_PG_PASSWORD,
      });
      await client.connect();
      clients.push(client);
      await client.query('SET statement_timeout=5000');
      await client.query('SET deadlock_timeout=50');
    }
    await clients[0]!.query('CREATE SCHEMA ' + schema);
    for (const client of clients) await client.query('SET search_path TO ' + schema);
    for (const [source, tables] of [
      [FINANCE_TABLES_SQL, ['customer_categories', 'expenses']],
      [
        CUSTOMER_PORTAL_TABLES_SQL,
        ['customer_plans', 'customer_subscription_requests', 'customer_planning_requests'],
      ],
    ] as const) {
      for (const table of tables) {
        const ddl = source.match(
          new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);')
        )?.[0];
        if (!ddl) throw new Error('Missing actual schema: ' + table);
        await clients[0]!.query(ddl);
      }
    }
  });
  beforeEach(async () => {
    afterCategoryLock = undefined;
    await clients[0]!.query(
      'TRUNCATE customer_plans, customer_categories, expenses, customer_subscription_requests, customer_planning_requests'
    );
    plans = Object.assign(new CustomerPlanningRepository('user-a'), {
      adapter: adapter(clients[0]!),
    });
    finance = Object.assign(new CustomerFinanceRepository('user-a'), {
      adapter: adapter(clients[1]!, async (sql) => {
        if (sql.includes('SELECT * FROM customer_categories') && sql.includes('FOR UPDATE'))
          await afterCategoryLock?.();
      }),
    });
    await finance.listCategories();
    await clients[0]!
      .query(`INSERT INTO customer_categories(id,user_id,type,name,name_key,color) VALUES
      ('old-a','user-a','expense','Antiga','antiga','#123456'), ('dest-a','user-a','expense','Destino','destino','#123456'),
      ('private-b','user-b','expense','Privada','privada','#123456')`);
    await clients[0]!
      .query(`INSERT INTO customer_plans(id,user_id,kind,title,amount_cents,category_id,next_due_date) VALUES
      ('sub-a','user-a','subscription','Internet',1000,'old-a','2026-12-01'),
      ('sub-b','user-b','subscription','Privada',9000,'private-b','2026-12-01')`);
  });
  afterAll(async () => {
    if (clients[2]) await clients[2].query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await Promise.all(clients.map((client) => client.end()));
  });

  async function verifyResults(results: PromiseSettledResult<unknown>[]) {
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await plans.get('sub-a')).toMatchObject({ amount: 12, categoryId: 'dest-a' });
    const foreign = await clients[2]!.query(
      "SELECT amount_cents, category_id FROM customer_plans WHERE id='sub-b'"
    );
    expect(foreign.rows).toEqual([{ amount_cents: '9000', category_id: 'private-b' }]);
    expect(
      (
        await clients[2]!.query(
          "SELECT count(*)::int AS n FROM customer_subscription_requests WHERE user_id='user-a'"
        )
      ).rows[0]?.n
    ).toBe(1);
  }

  it('finishes an edit before a competing category transfer without a deadlock', async () => {
    const locked = deferred();
    const release = deferred();
    const edit = plans.changeSubscription(
      'edit-first',
      { action: 'update', title: 'Internet', amount: 12 },
      async () => {
        locked.resolve();
        await release.promise;
        return true;
      }
    );
    await locked.promise;
    const transfer = finance.deleteCategory('old-a', 'dest-a');
    const results = Promise.allSettled([edit, transfer]);
    try {
      await waitUntilBlocked(clients[1]!);
    } finally {
      release.resolve();
    }
    await verifyResults(await results);
  });

  it('reads the transferred category when a competing transfer started first', async () => {
    const locked = deferred();
    const release = deferred();
    afterCategoryLock = async () => {
      locked.resolve();
      await release.promise;
    };
    const transfer = finance.deleteCategory('old-a', 'dest-a');
    await locked.promise;
    const edit = plans.changeSubscription(
      'transfer-first',
      { action: 'update', title: 'Internet', amount: 12 },
      async () => true
    );
    const results = Promise.allSettled([edit, transfer]);
    try {
      await waitUntilBlocked(clients[0]!);
    } finally {
      release.resolve();
    }
    await verifyResults(await results);
  });

  it('allows another account to write while the first account holds its locks', async () => {
    const locked = deferred();
    const release = deferred();
    const edit = plans.changeSubscription(
      'own-edit',
      { action: 'update', title: 'Internet', amount: 12 },
      async () => {
        locked.resolve();
        await release.promise;
        return true;
      }
    );
    await locked.promise;
    try {
      const other = Object.assign(new CustomerPlanningRepository('user-b'), {
        adapter: adapter(clients[1]!),
      });
      expect(
        await other.update('sub-b', {
          kind: 'subscription',
          title: 'Privada',
          amount: 95,
          categoryId: 'private-b',
        })
      ).toMatchObject({ amount: 95 });
      expect(await other.get('sub-a')).toBeNull();
      expect(
        await other.update('sub-a', {
          kind: 'subscription',
          title: 'Tentativa',
          amount: 50,
          categoryId: 'private-b',
        })
      ).toBeNull();
    } finally {
      release.resolve();
      await edit;
    }
  });
});
