import { beforeEach, describe, expect, it, vi } from 'vitest';
const mockAccount = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('./customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mockAccount },
}));

const mockAdapter = vi.hoisted(() => ({
  type: 'postgres' as const,
  isConnected: vi.fn(() => true),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn(),
  execute: vi.fn().mockResolvedValue({ changes: 1 }),
  exec: vi.fn(),
  transaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  now: vi.fn(() => 'NOW()'),
  date: vi.fn(),
  dateSubtract: vi.fn(),
  placeholder: vi.fn((i: number) => '$' + i),
  boolean: vi.fn((v: boolean) => v),
  parseBoolean: vi.fn((v: unknown) => Boolean(v)),
  close: vi.fn(),
}));

vi.mock('../adapters/index.js', () => ({
  getAdapter: vi.fn(async () => mockAdapter),
  getAdapterSync: vi.fn(() => mockAdapter),
}));

import { FinanceObligationsRepository, financeNameKey } from './finance-obligations.js';

const dbRow = {
  id: 'fin-1',
  name: 'carro',
  user_id: 'whatsapp:5521997557364',
  name_key: 'carro',
  principal_cents: '7200000',
  opening_paid_cents: '93000',
  additional_paid_cents: '0',
};

describe('Financing repository: separate user balances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.queryOne.mockResolvedValue(null);
  });

  it('normalizes accent and whitespace consistently', () => {
    expect(financeNameKey('  Carro   Elétrico ')).toBe('carro eletrico');
  });

  it('creates the opening balance without creating an expense', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce({ id: 'fin-1' }).mockResolvedValueOnce(dbRow);
    const repo = new FinanceObligationsRepository('whatsapp:5521997557364');
    const result = await repo.createOrFind('carro', 7_200_000, 93_000);

    expect(result.created).toBe(true);
    expect(result.balance.remainingCents).toBe(7_107_000);
    expect(mockAdapter.queryOne.mock.calls[0]![0]).toContain('ON CONFLICT');
    expect(mockAdapter.queryOne.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(['whatsapp:5521997557364', 'carro', 7_200_000, 93_000])
    );
    expect(mockAdapter.queryOne.mock.calls[1]![0]).toContain('o.user_id = $1');
    expect(mockAdapter.queryOne.mock.calls[1]![1]).toEqual(['whatsapp:5521997557364', 'carro']);
    expect(
      mockAdapter.execute.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))
    ).toHaveLength(0);
  });

  it('does not overwrite an existing financing on repeated setup', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(dbRow);
    const result = await new FinanceObligationsRepository('whatsapp:5521997557364').createOrFind(
      'carro',
      7_200_000,
      93_000
    );
    expect(result.created).toBe(false);
    expect(result.balance.paidCents).toBe(93_000);
  });

  it('does not let a user query another customer financing', async () => {
    await new FinanceObligationsRepository('whatsapp:5511987654321').find('carro');
    expect(mockAdapter.queryOne.mock.calls[0]![1]).toEqual(['whatsapp:5511987654321', 'carro']);
  });

  it('rejects financing with an opening balance above the principal', async () => {
    await expect(
      new FinanceObligationsRepository('whatsapp:user').createOrFind('carro', 100_000, 200_000)
    ).rejects.toThrow('Invalid financing');
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('rejects payment without an account, without recording an expense', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce(null);
    const result = await new FinanceObligationsRepository('whatsapp:user').recordPayment(
      'carro',
      47_000,
      'a'.repeat(64)
    );
    expect(result).toEqual({ status: 'missing' });
    expect(mockAdapter.transaction).toHaveBeenCalledTimes(1);
    expect(mockAdapter.queryOne.mock.calls[0]![0]).toContain('FOR UPDATE');
    expect(
      mockAdapter.execute.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))
    ).toHaveLength(0);
  });

  it('deduplicates before writing an expense or a payment', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce(dbRow)
      .mockResolvedValueOnce({
        id: 'already-paid',
        obligation_id: dbRow.id,
        amount_cents: '47000',
        expense_id: 'expense-original',
      })
      .mockResolvedValueOnce(dbRow);
    const result = await new FinanceObligationsRepository('whatsapp:5521997557364').recordPayment(
      'carro',
      47_000,
      'b'.repeat(64)
    );
    expect(result.status).toBe('duplicate');
    expect(result).toMatchObject({
      payment: { id: 'already-paid', amountCents: 47_000, expenseId: 'expense-original' },
    });
    expect(
      mockAdapter.execute.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))
    ).toHaveLength(0);
  });

  it('prevents overpaying the balance under the account lock', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce(dbRow)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(dbRow);
    const result = await new FinanceObligationsRepository('whatsapp:5521997557364').recordPayment(
      'carro',
      7_200_000,
      'c'.repeat(64)
    );
    expect(result.status).toBe('exceeds');
    expect(
      mockAdapter.execute.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))
    ).toHaveLength(0);
  });

  it('rolls back an expense failure without confirming payment', async () => {
    mockAdapter.queryOne
      .mockResolvedValueOnce(dbRow)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(dbRow)
      .mockRejectedValueOnce(new Error('INSERT expense failed'));
    await expect(
      new FinanceObligationsRepository('whatsapp:5521997557364').recordPayment(
        'carro',
        47_000,
        'd'.repeat(64)
      )
    ).rejects.toThrow('INSERT expense failed');
    expect(mockAdapter.transaction).toHaveBeenCalledTimes(1);
    expect(
      mockAdapter.execute.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))
    ).toHaveLength(0);
  });

  it('records a payment on the customer local day and uses the same scoped expense ledger', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T02:00:00Z'));
    mockAccount.mockResolvedValueOnce({ timeZone: 'America/Campo_Grande' });
    mockAdapter.queryOne
      .mockResolvedValueOnce(dbRow)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(dbRow)
      .mockResolvedValueOnce({
        id: 'exp-payment',
        user_id: dbRow.user_id,
        date: '2026-11-10',
        amount: '470.00',
        category: 'transport',
        currency: 'BRL',
        description: 'Pagamento de carro',
        tags: [],
        source: 'financing',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .mockResolvedValueOnce({ ...dbRow, additional_paid_cents: '47000' });
    try {
      const outcome = await new FinanceObligationsRepository(dbRow.user_id).recordPayment(
        'carro',
        47_000,
        'e'.repeat(64)
      );
      expect(outcome).toMatchObject({ status: 'recorded', balance: { paidCents: 140_000 } });
      expect(outcome).toMatchObject({
        payment: { id: expect.any(String), amountCents: 47_000, expenseId: 'exp-payment' },
      });
      const insert = mockAdapter.queryOne.mock.calls.find(([sql]) =>
        String(sql).startsWith('INSERT INTO expenses')
      )!;
      expect(insert[1]).toEqual(expect.arrayContaining([dbRow.user_id, '2026-11-10', 470]));
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO finance_obligation_payments'),
        expect.arrayContaining([dbRow.user_id, 'exp-payment'])
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { obligation_id: 'other-financing', amount_cents: '47000' },
    { obligation_id: dbRow.id, amount_cents: '2800000' },
  ])('rejects a message replay with a different target or amount: %j', async (original) => {
    mockAdapter.queryOne
      .mockResolvedValueOnce(dbRow)
      .mockResolvedValueOnce({
        id: 'original-payment',
        expense_id: 'original-expense',
        ...original,
      })
      .mockResolvedValueOnce(dbRow);
    const outcome = await new FinanceObligationsRepository(dbRow.user_id).recordPayment(
      'carro',
      47_000,
      'f'.repeat(64)
    );
    expect(outcome.status).toBe('conflict');
    expect(
      mockAdapter.execute.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))
    ).toHaveLength(0);
    expect(
      mockAdapter.queryOne.mock.calls.some(([sql]) => /^INSERT INTO expenses\b/.test(sql))
    ).toBe(false);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      ['customer-finance:' + dbRow.user_id]
    );
    expect(mockAdapter.execute.mock.invocationCallOrder[0]).toBeLessThan(
      mockAdapter.queryOne.mock.invocationCallOrder[0]!
    );
  });

  it('keeps the customer receive date when a queued payment crosses midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T04:05:00Z'));
    mockAccount.mockResolvedValueOnce({ timeZone: 'America/Campo_Grande' });
    mockAdapter.queryOne
      .mockResolvedValueOnce(dbRow)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(dbRow)
      .mockResolvedValueOnce({
        id: 'expense-received-yesterday',
        user_id: dbRow.user_id,
        date: '2026-11-19',
        amount: '470.00',
        category: 'transport',
        currency: 'BRL',
        description: 'Pagamento de carro',
        tags: [],
        source: 'financing',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .mockResolvedValueOnce({ ...dbRow, additional_paid_cents: '47000' });
    try {
      const outcome = await new FinanceObligationsRepository(dbRow.user_id).recordPayment(
        'carro',
        47_000,
        'a'.repeat(64),
        new Date('2026-11-20T03:59:00Z')
      );
      expect(outcome.status).toBe('recorded');
      const insert = mockAdapter.queryOne.mock.calls.find(([sql]) =>
        /^INSERT INTO expenses\b/.test(sql)
      )!;
      expect(insert[1]).toEqual(expect.arrayContaining(['2026-11-19']));
    } finally {
      vi.useRealTimers();
    }
  });
});
