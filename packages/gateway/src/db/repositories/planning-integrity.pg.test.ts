import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import type { DatabaseAdapter } from '../adapters/types.js';
import { FINANCE_TABLES_SQL } from '../schema/finance.js';
import { CUSTOMER_PORTAL_TABLES_SQL } from '../schema/customer-portal.js';
import { AUTONOMOUS_TABLES_SQL } from '../schema/autonomous.js';
import { CustomerPlanningRepository } from './customer-planning.js';
import { CustomerFinanceRepository } from './customer-finance.js';
import { GoalsRepository } from './goals.js';

vi.mock('@ownpilot/core/events', () => ({ getEventSystem: () => ({ emit: vi.fn() }) }));

// Synthetic users, actual repository SQL, and connection-private PostgreSQL tables.
describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)('planning reference integrity', () => {
  let client: Client;
  let adapter: DatabaseAdapter;
  function connected<T extends object>(repo: T): T {
    return Object.assign(repo, { adapter });
  }
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
      [FINANCE_TABLES_SQL, ['customer_categories', 'expenses']],
      [CUSTOMER_PORTAL_TABLES_SQL, ['customer_plans']],
      [AUTONOMOUS_TABLES_SQL, ['goals']],
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
      query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
      queryOne: async (sql: string, params?: unknown[]) =>
        (await client.query(sql, params)).rows[0] ?? null,
      execute: async (sql: string, params?: unknown[]) => ({
        changes: (await client.query(sql, params)).rowCount ?? 0,
      }),
      transaction: async <T>(fn: () => Promise<T>) => {
        await client.query('BEGIN');
        try {
          const result = await fn();
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    } as unknown as DatabaseAdapter;
  });
  beforeEach(async () => {
    await client.query('TRUNCATE customer_plans, expenses, customer_categories, goals');
    await client.query(`INSERT INTO customer_categories(id,user_id,type,name,name_key,color,archived) VALUES
      ('food-a','user-a','expense','Mercado','mercado','#123456',false),
      ('food-b','user-b','expense','Privado','privado','#123456',false),
      ('destination-a','user-a','expense','Destino','destino','#123456',false),
      ('income-a','user-a','income','Salário','salario','#123456',false),
      ('archived-a','user-a','expense','Antiga','antiga','#123456',true)`);
  });
  afterAll(async () => {
    await client?.end();
  });

  it('round-trips goal symbols, preserves them for legacy edits and scopes them to their owner', async () => {
    const owner = connected(new CustomerPlanningRepository('user-a'));
    const other = connected(new CustomerPlanningRepository('user-b'));
    const created = await owner.create({
      kind: 'goal',
      title: 'Viagem',
      amount: 2000,
      progress: 100,
      icon: 'plane',
    });
    expect((await owner.get(created.id))?.icon).toBe('plane');
    await owner.update(created.id, {
      kind: 'goal',
      title: 'Viagem atualizada',
      amount: 2200,
      progress: 200,
    });
    expect((await owner.get(created.id))?.icon).toBe('plane');
    await owner.update(created.id, {
      kind: 'goal',
      title: 'Reserva',
      amount: 2200,
      progress: 200,
      icon: 'shield',
    });
    expect((await owner.list())[0]?.icon).toBe('shield');
    expect(await other.get(created.id)).toBeNull();
  });

  it.each(['food-b', 'missing', 'income-a', 'archived-a'])(
    'rejects an invalid budget category without inserting a plan: %s',
    async (categoryId) => {
      const repo = connected(new CustomerPlanningRepository('user-a'));
      await expect(
        repo.create({ kind: 'budget', title: 'Orçamento', amount: 100, categoryId })
      ).rejects.toThrow(/categoria/i);
      expect((await client.query('SELECT count(*)::int AS n FROM customer_plans')).rows[0]?.n).toBe(
        0
      );
    }
  );

  it('rejects changing an owned plan to a category belonging to another user', async () => {
    const repo = connected(new CustomerPlanningRepository('user-a'));
    const plan = await repo.create({
      kind: 'budget',
      title: 'Mercado',
      amount: 100,
      categoryId: 'food-a',
    });
    await expect(
      repo.update(plan.id, { kind: 'budget', title: 'Mercado', amount: 100, categoryId: 'food-b' })
    ).rejects.toThrow(/categoria/i);
    expect((await repo.get(plan.id))?.categoryId).toBe('food-a');
  });

  it('preserves a budget reference when its category is removed without a transfer', async () => {
    const plans = connected(new CustomerPlanningRepository('user-a'));
    await plans.create({ kind: 'budget', title: 'Mercado', amount: 100, categoryId: 'food-a' });
    const finance = connected(new CustomerFinanceRepository('user-a'));
    expect(await finance.deleteCategory('food-a')).toEqual({ deleted: false, archived: true });
    expect(
      (await client.query("SELECT archived FROM customer_categories WHERE id='food-a'")).rows
    ).toEqual([{ archived: true }]);
  });

  it('does not attach a new goal to another user’s parent', async () => {
    const a = connected(new GoalsRepository('user-a'));
    const b = connected(new GoalsRepository('user-b'));
    const parent = await b.create({ title: 'Objetivo privado' });
    await expect(a.create({ title: 'Novo objetivo', parentId: parent.id })).rejects.toThrow(
      /parent|pai|meta|goal/i
    );
    expect(
      (await client.query("SELECT count(*)::int AS n FROM goals WHERE user_id='user-a'")).rows[0]?.n
    ).toBe(0);
  });

  it('allows editing an existing budget after its category is archived', async () => {
    const repo = connected(new CustomerPlanningRepository('user-a'));
    const plan = await repo.create({
      kind: 'budget',
      title: 'Mercado',
      amount: 100,
      categoryId: 'food-a',
    });
    await client.query("UPDATE customer_categories SET archived=true WHERE id='food-a'");
    expect(
      await repo.update(plan.id, {
        kind: 'budget',
        title: 'Novo nome',
        amount: 150,
        categoryId: 'food-a',
      })
    ).toMatchObject({ title: 'Novo nome', amount: 150, categoryId: 'food-a' });
  });

  it('transfers a budget to the chosen owned category before removing its old category', async () => {
    const plans = connected(new CustomerPlanningRepository('user-a'));
    const plan = await plans.create({
      kind: 'budget',
      title: 'Mercado',
      amount: 100,
      categoryId: 'food-a',
    });
    const b = connected(new CustomerPlanningRepository('user-b'));
    const foreign = await b.create({
      kind: 'budget',
      title: 'Privado',
      amount: 90,
      categoryId: 'food-b',
    });
    const finance = connected(new CustomerFinanceRepository('user-a'));
    expect(await finance.deleteCategory('food-a', 'destination-a')).toEqual({
      deleted: true,
      archived: false,
    });
    expect((await plans.get(plan.id))?.categoryId).toBe('destination-a');
    expect((await b.get(foreign.id))?.categoryId).toBe('food-b');
  });

  it('never reads, updates or deletes another user’s plan by its identifier', async () => {
    const a = connected(new CustomerPlanningRepository('user-a'));
    const b = connected(new CustomerPlanningRepository('user-b'));
    const plan = await b.create({
      kind: 'budget',
      title: 'Privado',
      amount: 90,
      categoryId: 'food-b',
    });
    expect(await a.get(plan.id)).toBeNull();
    expect(
      await a.update(plan.id, {
        kind: 'budget',
        title: 'Alterado',
        amount: 100,
        categoryId: 'food-a',
      })
    ).toBeNull();
    expect(await a.delete(plan.id)).toBe(false);
    expect(await b.get(plan.id)).toMatchObject({
      title: 'Privado',
      amount: 90,
      categoryId: 'food-b',
    });
  });

  it('permits an owned parent and prevents reading or deleting someone else’s goal', async () => {
    const a = connected(new GoalsRepository('user-a'));
    const b = connected(new GoalsRepository('user-b'));
    const parent = await a.create({ title: 'Objetivo' });
    const child = await a.create({ title: 'Etapa', parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    expect(await b.get(parent.id)).toBeNull();
    expect(await b.delete(parent.id)).toBe(false);
    expect((await a.get(child.id))?.parentId).toBe(parent.id);
  });
});
