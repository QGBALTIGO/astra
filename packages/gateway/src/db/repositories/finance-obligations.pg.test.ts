import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresAdapter } from '../adapters/postgres-adapter.js';

const db = vi.hoisted(() => ({ adapter: null as PostgresAdapter | null }));
vi.mock('../adapters/index.js', () => ({ getAdapter: async () => db.adapter }));

import { radarTestDatabase, seedRadarAccounts } from './radar-pg-fixture.js';
import { FINANCE_TABLES_SQL } from '../schema/finance.js';
import { FinanceObligationsRepository } from './finance-obligations.js';
import { CustomerFinanceRepository } from './customer-finance.js';
import { channelFinanceCreateIdentity } from '../../channels/finance-create-identity.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'financing payment isolation and atomicity in actual PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    const user = 'whatsapp:5567999991111';
    const otherUser = 'whatsapp:5567999992222';
    const repo = () => new FinanceObligationsRepository(user);

    beforeAll(async () => {
      fixture = await radarTestDatabase();
      db.adapter = fixture.adapter;
      await fixture.adapter.exec(FINANCE_TABLES_SQL);
      await seedRadarAccounts(fixture.adapter);
    });
    beforeEach(async () => {
      await fixture.adapter.exec(
        'TRUNCATE finance_obligation_payments, finance_obligations, expenses CASCADE'
      );
      await repo().createOrFind('carro', 7_200_000, 2_800_000);
      await repo().createOrFind('moto', 2_000_000, 0);
    });
    afterAll(async () => {
      db.adapter = null;
      await fixture?.close();
    });

    async function counts() {
      return fixture.adapter.queryOne<{ expenses: number; payments: number }>(
        'SELECT (SELECT count(*)::int FROM expenses) AS expenses, (SELECT count(*)::int FROM finance_obligation_payments) AS payments'
      );
    }

    async function waitForBlockedPayment() {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const row = await fixture.adapter.queryOne<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS blocked"
        );
        if (row?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('Expected the replay to wait for the actual customer ledger lock');
    }

    it('keeps historical opening balances out of expenses', async () => {
      expect(await repo().find('carro')).toMatchObject({
        paidCents: 2_800_000,
        remainingCents: 4_400_000,
      });
      expect(await counts()).toEqual({ expenses: 0, payments: 0 });
    });

    it('commits exactly one payment and one expense for concurrent identical retries', async () => {
      const [a, b] = await Promise.all([
        repo().recordPayment('carro', 50_000, 'a'.repeat(64)),
        repo().recordPayment('carro', 50_000, 'a'.repeat(64)),
      ]);
      expect([a.status, b.status].sort()).toEqual(['duplicate', 'recorded']);
      if (!('payment' in a) || !('payment' in b)) throw new Error('Missing persisted receipt');
      expect(a.payment).toEqual(b.payment);
      expect(a.payment.amountCents).toBe(50_000);
      const stored = await fixture.adapter.queryOne<{ id: string; amount: string }>(
        'SELECT id, amount FROM expenses WHERE id = $1 AND user_id = $2',
        [a.payment.expenseId, user]
      );
      expect(stored).toEqual({ id: a.payment.expenseId, amount: '500.00' });
      expect(await counts()).toEqual({ expenses: 1, payments: 1 });
      expect(await repo().find('carro')).toMatchObject({ paidCents: 2_850_000 });
    });

    it('serializes a concurrent replay targeting another financing and rejects its changed payload', async () => {
      const locked = deferred();
      const release = deferred();
      const originalExecute = fixture.adapter.execute.bind(fixture.adapter);
      let held = false;
      const spy = vi.spyOn(fixture.adapter, 'execute').mockImplementation(async (sql, params) => {
        const result = await originalExecute(sql, params);
        if (!held && sql.includes('pg_advisory_xact_lock')) {
          held = true;
          locked.resolve();
          await release.promise;
        }
        return result;
      });
      const first = repo().recordPayment('carro', 50_000, 'b'.repeat(64));
      await locked.promise;
      const second = repo().recordPayment('moto', 70_000, 'b'.repeat(64));
      const outcomes = Promise.allSettled([first, second]);
      try {
        await waitForBlockedPayment();
      } finally {
        release.resolve();
        spy.mockRestore();
      }
      const [a, b] = await outcomes;
      expect(a).toMatchObject({ status: 'fulfilled', value: { status: 'recorded' } });
      expect(b).toMatchObject({ status: 'fulfilled', value: { status: 'conflict' } });
      expect(await counts()).toEqual({ expenses: 1, payments: 1 });
      expect(await repo().find('carro')).toMatchObject({ paidCents: 2_850_000 });
      expect(await repo().find('moto')).toMatchObject({ paidCents: 0 });
    });

    it('prevents two distinct concurrent payments from exceeding the remaining balance', async () => {
      await repo().createOrFind('saldo pequeno', 10_000, 0);
      const outcomes = await Promise.all([
        repo().recordPayment('saldo pequeno', 8_000, 'c'.repeat(64)),
        repo().recordPayment('saldo pequeno', 8_000, 'd'.repeat(64)),
      ]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['exceeds', 'recorded']);
      expect(await counts()).toEqual({ expenses: 1, payments: 1 });
      expect(await repo().find('saldo pequeno')).toMatchObject({
        paidCents: 8_000,
        remainingCents: 2_000,
      });
    });

    it('rolls back the expense if the payment ledger insert fails after it', async () => {
      await fixture.adapter.exec(`
        CREATE FUNCTION reject_synthetic_payment() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic payment insert failure'; END $$;
        CREATE TRIGGER reject_synthetic_payment BEFORE INSERT ON finance_obligation_payments
        FOR EACH ROW EXECUTE FUNCTION reject_synthetic_payment();
      `);
      try {
        await expect(repo().recordPayment('carro', 50_000, 'e'.repeat(64))).rejects.toThrow(
          'synthetic payment insert failure'
        );
        expect(await counts()).toEqual({ expenses: 0, payments: 0 });
        expect(await repo().find('carro')).toMatchObject({ paidCents: 2_800_000 });
      } finally {
        await fixture.adapter.exec(
          'DROP TRIGGER reject_synthetic_payment ON finance_obligation_payments; DROP FUNCTION reject_synthetic_payment()'
        );
      }
    });

    it('preserves the received local date and cannot read or pay another customer debt', async () => {
      const outcome = await repo().recordPayment(
        'carro',
        50_000,
        'f'.repeat(64),
        new Date('2026-11-20T03:59:00Z')
      );
      expect(outcome.status).toBe('recorded');
      expect(
        await fixture.adapter.queryOne<{ date: string }>(
          'SELECT date FROM expenses WHERE user_id=$1',
          [user]
        )
      ).toEqual({ date: '2026-11-19' });
      expect(
        await fixture.adapter.queryOne<{ paid_at: Date }>(
          'SELECT paid_at FROM finance_obligation_payments WHERE user_id=$1',
          [user]
        )
      ).toEqual({ paid_at: new Date('2026-11-20T03:59:00Z') });
      const other = new FinanceObligationsRepository(otherUser);
      expect(await other.find('carro')).toBeNull();
      expect(await other.recordPayment('carro', 50_000, '1'.repeat(64))).toEqual({
        status: 'missing',
      });
      expect(await counts()).toEqual({ expenses: 1, payments: 1 });
    });

    it('shares the same creation identity across a model retry that renames one expense', async () => {
      const finance = new CustomerFinanceRepository(user);
      const category = (await finance.listCategories()).find(
        (item) => item.type === 'expense' && item.legacyKey === 'food'
      )!;
      expect(category).toBeDefined();
      const scope = {
        userId: user,
        channelPluginId: 'channel.whatsapp',
        platformChatId: 'synthetic-private-chat',
        channelMessageId: 'expense-retry-one',
        requestText: 'Gastei 20 reais com café',
      };
      const first = channelFinanceCreateIdentity(scope, { amount: 20, description: 'Café' });
      const renamed = channelFinanceCreateIdentity(scope, {
        amount: 20,
        description: 'Lanche no café',
      });
      if (!first.ok || !renamed.ok) throw new Error('Expected one authorized message identity');
      expect(first.key).toBe(renamed.key);
      const input = {
        type: 'expense' as const,
        status: 'settled' as const,
        amount: 20,
        description: 'Café',
        date: '2026-11-19',
        categoryId: category.id,
      };
      await finance.createTransaction(input, first.key);
      await expect(
        finance.createTransaction({ ...input, description: 'Lanche no café' }, renamed.key)
      ).rejects.toMatchObject({ status: 409 });
      expect(await counts()).toEqual({ expenses: 1, payments: 0 });
      expect(await finance.listTransactions()).toMatchObject({ total: 1 });
    });
  }
);
