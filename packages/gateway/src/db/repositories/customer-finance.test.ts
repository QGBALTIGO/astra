import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAdapter } from '../../test-helpers.js';
import { createHash } from 'node:crypto';

const adapter = createMockAdapter();
vi.mock('../adapters/index.js', () => ({
  getAdapter: async () => adapter,
  getAdapterSync: () => adapter,
}));
const {
  CustomerFinanceRepository,
  CustomerFinanceError,
  customerMoneyCents,
  validateCustomerFinanceDate,
} = await import('./customer-finance.js');

const user = 'whatsapp:5511999990101';
const otherUser = 'whatsapp:5511999990102';
const now = '2026-11-10T12:00:00.000Z';
const category = {
  id: 'cat-food',
  user_id: user,
  name: 'Alimentação',
  name_key: 'alimentacao',
  type: 'expense',
  color: '#2563EB',
  archived: false,
  legacy_key: 'food',
};
const incomeCategory = {
  ...category,
  id: 'cat-salary',
  name: 'Salário',
  name_key: 'salario',
  type: 'income',
  legacy_key: 'salary',
};
const input = {
  description: 'Almoço',
  amount: 36.39,
  type: 'expense' as const,
  status: 'settled' as const,
  categoryId: category.id,
  date: '2026-11-10',
};
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'expense-1',
  user_id: user,
  description: 'Almoço',
  amount: '36.39',
  currency: 'BRL',
  transaction_type: 'expense',
  status: 'settled',
  category_id: category.id,
  category_name: category.name,
  category_color: category.color,
  category: 'food',
  date: '2026-11-10',
  notes: null,
  source: 'channel',
  created_at: now,
  updated_at: now,
  request_fingerprint: null as string | null,
  deleted_at: null as string | null,
  ...overrides,
});
type Stored = ReturnType<typeof row>;
let ledger: Map<string, Stored>;
let categories: Array<typeof category>;
let operations: Map<string, string>;
let linked: Set<string>;
let repo: InstanceType<typeof CustomerFinanceRepository>;

beforeEach(() => {
  vi.clearAllMocks();
  ledger = new Map();
  categories = [{ ...category }, { ...incomeCategory }];
  operations = new Map();
  linked = new Set();
  repo = new CustomerFinanceRepository(user);
  adapter.transaction.mockReset().mockImplementation(async (fn: () => Promise<unknown>) => fn());
  adapter.query.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT DISTINCT category')) return [];
    if (
      sql.startsWith('SELECT * FROM customer_categories') ||
      sql.startsWith('SELECT COUNT(*)::text AS count FROM customer_categories')
    )
      return categories.filter((item) => item.user_id === params[0]);
    if (sql.startsWith('SELECT id FROM expenses'))
      return [...ledger.values()]
        .filter(
          (item) =>
            item.user_id === params[0] &&
            item.transaction_type === params[1] &&
            item.status === 'pending' &&
            !item.deleted_at &&
            item.description.toLowerCase() === String(params[2]).toLowerCase()
        )
        .slice(0, 2)
        .map(({ id }) => ({ id }));
    return [];
  });
  adapter.queryOne.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM finance_obligation_payments'))
      return linked.has(String(params[1])) ? { id: 'payment-1' } : null;
    if (sql.includes('FROM customer_finance_operations')) {
      const id = operations.get(`${params[0]}:${params[1]}`);
      return id ? { transaction_id: id } : null;
    }
    if (
      sql.startsWith('SELECT * FROM customer_categories') ||
      sql.startsWith('SELECT COUNT(*)::text AS count FROM customer_categories')
    ) {
      if (sql.includes('COUNT(*)')) return { count: '2' };
      if (sql.includes('legacy_key IN'))
        return (
          categories.find(
            (item) =>
              item.user_id === params[0] && item.type === params[1] && item.legacy_key === params[2]
          ) ?? null
        );
      return categories.find((item) => item.user_id === params[0] && item.id === params[1]) ?? null;
    }
    if (sql.includes('FROM expenses AS e')) {
      const found = ledger.get(String(params[1]));
      if (
        !found ||
        found.user_id !== params[0] ||
        (sql.includes('e.deleted_at IS NULL') && found.deleted_at)
      )
        return null;
      return found;
    }
    return null;
  });
  adapter.execute.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('INSERT INTO expenses')) {
      const id = String(params[0]);
      if (ledger.has(id)) return { changes: 0 };
      const cat = categories.find((item) => item.id === params[5])!;
      ledger.set(
        id,
        row({
          id,
          user_id: params[1],
          date: params[2],
          amount: params[3],
          category: params[4],
          category_id: params[5],
          description: params[6],
          notes: params[7],
          transaction_type: params[8],
          status: params[9],
          request_fingerprint: params[10] ?? null,
          category_name: cat.name,
          category_color: cat.color,
          source: sql.includes("'customer'") ? 'customer' : 'channel',
        })
      );
      return { changes: 1 };
    }
    if (sql.startsWith('UPDATE expenses SET deleted_at')) {
      const existing = ledger.get(String(params[1]));
      if (!existing || existing.user_id !== params[0] || existing.deleted_at) return { changes: 0 };
      existing.deleted_at = now;
      return { changes: 1 };
    }
    if (sql.startsWith('UPDATE expenses SET status')) {
      const existing = ledger.get(String(params[1]));
      if (existing && existing.user_id === params[0]) {
        existing.status = 'settled';
        existing.date = String(params[2]);
      }
      return { changes: existing ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE expenses SET date')) {
      const existing = ledger.get(String(params[1]));
      if (!existing || existing.user_id !== params[0]) return { changes: 0 };
      Object.assign(existing, {
        date: params[2],
        amount: params[3],
        description: params[4],
        notes: params[5],
        transaction_type: params[6],
        status: params[7],
        category_id: params[8],
        category: params[9],
      });
      return { changes: 1 };
    }
    if (sql.startsWith('INSERT INTO customer_finance_operations'))
      operations.set(`${params[0]}:${params[1]}`, String(params[2]));
    return { changes: 1 };
  });
});

describe('customer money and dates', () => {
  it.each([
    [0.01, 1],
    [0.29, 29],
    [36.39, 3639],
    [9_999_999_999.97, 999_999_999_997],
    [9_999_999_999.99, 999_999_999_999],
  ])('preserves exact cents for %s', (amount, cents) =>
    expect(customerMoneyCents(amount!)).toBe(cents)
  );
  it.each([0, -1, 1.001, 0.1 + 0.2, NaN, Infinity, 10_000_000_000])(
    'rejects %s without silently rounding',
    (amount) => expect(() => customerMoneyCents(amount)).toThrow(CustomerFinanceError)
  );
  it.each(['2026-02-29', '2026-04-31', '2026-11-10T12:00:00Z', '10/11/2026', 'not-a-date'])(
    'rejects invalid calendar day %s',
    (date) => expect(() => validateCustomerFinanceDate(date)).toThrow()
  );
  it('accepts a real leap day', () =>
    expect(validateCustomerFinanceDate('2028-02-29')).toBe('2028-02-29'));
  it('never substitutes the owner for an empty data identity', () =>
    expect(() => new CustomerFinanceRepository(' ')).toThrow());
});

describe('shared customer finance ledger', () => {
  it('creates in expenses with one server scope and preserves the same id across reads', async () => {
    const created = await repo.createTransaction(input);
    expect(created).toMatchObject({
      amount: 36.39,
      type: 'expense',
      status: 'settled',
      categoryName: 'Alimentação',
    });
    expect(await repo.getTransaction(created.id)).toEqual(created);
    const insertion = adapter.execute.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT INTO expenses')
    )!;
    expect(insertion[1]).toEqual(expect.arrayContaining([user, '36.39', 'expense', 'settled']));
    expect(insertion[0]).toContain('category_id');
    expect(insertion[0]).not.toContain('INSERT INTO customer_transactions');
  });

  it('reuses the same idempotent transaction but allows a second deliberate key', async () => {
    const first = await repo.createTransaction(input, 'draft-unique-1');
    const replay = await new CustomerFinanceRepository(user).createTransaction(
      input,
      'draft-unique-1'
    );
    const different = await repo.createTransaction(input, 'draft-unique-2');
    expect(replay.id).toBe(first.id);
    expect(different.id).not.toBe(first.id);
    expect(ledger.size).toBe(2);
  });

  it('rejects reuse of an idempotency key for a changed payload', async () => {
    await repo.createTransaction(input, 'draft-unique-1');
    await expect(
      repo.createTransaction({ ...input, amount: 40 }, 'draft-unique-1')
    ).rejects.toMatchObject({ status: 409 });
    expect(ledger.size).toBe(1);
    expect([...ledger.values()][0]!.amount).toBe('36.39');
  });

  it('uses independent ids and categories for another authenticated user', async () => {
    categories.push({ ...category, id: 'other-food', user_id: otherUser });
    const first = await repo.createTransaction(input, 'draft-unique-1');
    const other = await new CustomerFinanceRepository(otherUser).createTransaction(
      { ...input, categoryId: 'other-food' },
      'draft-unique-1'
    );
    expect(first.id).not.toBe(other.id);
    expect(await repo.getTransaction(other.id)).toBeNull();
    expect(await repo.updateTransaction(other.id, { amount: 90 })).toBeNull();
    expect(await repo.deleteTransaction(other.id)).toBe(false);
    expect(ledger.get(other.id)!.amount).toBe('36.39');
  });

  it.each(['other-user-category', 'archived-category', 'wrong-type'])(
    'refuses invalid category binding: %s',
    async (scenario) => {
      if (scenario === 'archived-category') categories[0]!.archived = true;
      const next =
        scenario === 'wrong-type'
          ? { ...input, type: 'income' as const }
          : scenario === 'other-user-category'
            ? { ...input, categoryId: 'foreign-cat' }
            : input;
      await expect(repo.createTransaction(next)).rejects.toMatchObject({ status: 409 });
      expect(ledger.size).toBe(0);
    }
  );

  it('changes pending to settled on the same record', async () => {
    const created = await repo.createTransaction({ ...input, status: 'pending' });
    const updated = await repo.updateTransaction(created.id, { status: 'settled' });
    expect(updated).toMatchObject({ id: created.id, status: 'settled', amount: 36.39 });
    expect(ledger.size).toBe(1);
  });

  it('retains a deleted id so a lost-response retry cannot resurrect it', async () => {
    const created = await repo.createTransaction(input, 'draft-unique-1');
    expect(await repo.deleteTransaction(created.id)).toBe(true);
    expect(await repo.getTransaction(created.id)).toBeNull();
    await expect(repo.createTransaction(input, 'draft-unique-1')).rejects.toMatchObject({
      status: 409,
    });
    expect(ledger.size).toBe(1);
    expect(ledger.get(created.id)!.deleted_at).toBeTruthy();
  });

  it('retains provider-id idempotency and user isolation for income and pending records', async () => {
    const channelInput = {
      description: 'Salário',
      amount: 2000.01,
      type: 'income' as const,
      status: 'pending' as const,
      categoryKey: 'salary',
      date: '2026-11-12',
    };
    const sourceKey = createHash('sha256').update('provider-message').digest('hex');
    const first = await repo.createFromChannel(channelInput, sourceKey);
    const replay = await repo.createFromChannel(channelInput, sourceKey);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction).toMatchObject({
      amount: 2000.01,
      type: 'income',
      status: 'pending',
    });
    expect(first.transaction.id).toBe(
      `exp_ch_${createHash('sha256')
        .update(JSON.stringify([user, sourceKey]))
        .digest('hex')}`
    );
  });

  it('does not confirm an ambiguous write error or retry the insert', async () => {
    const error = new Error('connection lost after write');
    const execute = adapter.execute.getMockImplementation()!;
    adapter.execute.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('INSERT INTO expenses')) throw error;
      return execute(sql, params);
    });
    await expect(repo.createTransaction(input, 'draft-unique-1')).rejects.toBe(error);
    expect(
      adapter.execute.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO expenses'))
    ).toHaveLength(1);
    expect(adapter.transaction).toHaveBeenCalled();
  });

  it('protects a linked financing payment against a detached amount edit or deletion', async () => {
    const created = await repo.createTransaction(input);
    linked.add(created.id);
    await expect(repo.updateTransaction(created.id, { amount: 10 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(repo.deleteTransaction(created.id)).rejects.toMatchObject({ status: 409 });
    expect(ledger.get(created.id)!.amount).toBe('36.39');
  });
});

describe('financial reports and pending settlement', () => {
  it('uses one repeatable-read snapshot and integer cents for totals, series and category percentages', async () => {
    adapter.queryOne.mockResolvedValueOnce({
      income: '100030.00',
      expenses: '30.00',
      pending_income: '50000.00',
      pending_expenses: '1000.00',
    });
    adapter.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ date: '2026-11-10', income: '100030.00', expenses: '30.00' }])
      .mockResolvedValueOnce([
        { id: category.id, name: category.name, color: category.color, total: '30.00' },
      ])
      .mockResolvedValueOnce([]);
    const summary = await repo.summary('2026-11-10', '2026-11-11');
    expect(summary).toMatchObject({
      income: 1000.3,
      expenses: 0.3,
      result: 1000,
      pendingIncome: 500,
      pendingExpenses: 10,
      categories: [{ id: category.id, total: 0.3, percentage: 100 }],
    });
    expect(summary.series).toEqual([
      { date: '2026-11-10', income: 1000.3, expenses: 0.3 },
      { date: '2026-11-11', income: 0, expenses: 0 },
    ]);
    const totalQuery = adapter.queryOne.mock.calls.find(([sql]) => String(sql).includes('FILTER'))!;
    expect(totalQuery[0]).toContain("transaction_type = 'income' AND status = 'settled'");
    expect(totalQuery[0]).toContain("transaction_type = 'expense' AND status = 'pending'");
    expect(totalQuery[0]).toContain("e.currency = 'BRL' AND e.deleted_at IS NULL");
    expect(totalQuery[1]).toEqual([user, '2026-11-10', '2026-11-11']);
    expect(adapter.execute).toHaveBeenCalledWith(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      undefined
    );
  });

  it('binds pagination/filter parameters and escapes a literal wildcard search', async () => {
    adapter.queryOne.mockResolvedValueOnce({ total: '0' });
    await repo.listTransactions({
      from: '2026-11-01',
      to: '2026-11-30',
      type: 'income',
      status: 'pending',
      categoryId: 'cat-salary',
      search: '50%_off',
      page: 2,
      pageSize: 10,
    });
    const list = adapter.query.mock.calls.find(([sql]) => String(sql).includes('LIMIT $'))!;
    expect(list[1]).toEqual([
      user,
      '2026-11-01',
      '2026-11-30',
      'income',
      'pending',
      'cat-salary',
      '%50\\%\\_off%',
      10,
      10,
    ]);
    expect(list[0]).toContain('c.user_id = e.user_id');
  });

  it('exports all nondeleted scoped records without a pagination cap', async () => {
    await repo.exportTransactions();
    const query = adapter.query.mock.calls.find(([sql]) => String(sql).includes('SELECT e.*'))!;
    expect(query[0]).toContain('e.user_id = $1');
    expect(query[0]).toContain('e.deleted_at IS NULL');
    expect(query[0]).not.toMatch(/LIMIT|OFFSET/);
    expect(query[1]).toEqual([user]);
  });

  it('settles one pending record once across new repository instances', async () => {
    const created = await repo.createTransaction({ ...input, status: 'pending' });
    const request = {
      description: input.description,
      type: 'expense' as const,
      date: '2026-11-12',
      sourceKey: 'a'.repeat(64),
    };
    expect(await repo.settleFromChannel(request)).toMatchObject({
      outcome: 'settled',
      transaction: { id: created.id, status: 'settled' },
    });
    expect(await new CustomerFinanceRepository(user).settleFromChannel(request)).toMatchObject({
      outcome: 'duplicate',
      transaction: { id: created.id },
    });
    expect(ledger.size).toBe(1);
    expect(operations.size).toBe(1);
  });

  it('refuses to guess between two identically named pending records', async () => {
    await repo.createTransaction({ ...input, status: 'pending' });
    await repo.createTransaction({ ...input, status: 'pending', amount: 40 });
    expect(
      await repo.settleFromChannel({
        description: input.description,
        type: 'expense',
        date: '2026-11-12',
        sourceKey: 'a'.repeat(64),
      })
    ).toEqual({ outcome: 'ambiguous' });
    expect([...ledger.values()].every((item) => item.status === 'pending')).toBe(true);
    expect(operations.size).toBe(0);
  });

  it('validates the report window instead of returning fabricated zero totals', async () => {
    await expect(repo.summary('2026-12-01', '2026-11-01')).rejects.toThrow();
    await expect(repo.summary('2026-02-30', '2026-11-01')).rejects.toThrow();
    expect(adapter.queryOne).not.toHaveBeenCalled();
  });
});
