import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAdapter } from '../../test-helpers.js';

const adapter = createMockAdapter();
vi.mock('../adapters/index.js', () => ({ getAdapter: async () => adapter }));
const { CustomerReceivablesRepository } = await import('./customer-receivables.js');
const user = 'receivable-user-a';
type Entry = {
  userId: string;
  amountCents: number;
  currency: string;
  type: string;
  status: string;
  deleted?: boolean;
  date?: string;
  plan?: string;
};
let ledger: Entry[];
beforeEach(() => {
  vi.clearAllMocks();
  ledger = [];
  adapter.query.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    expect(sql).toContain("transaction_type='income'");
    expect(sql).toContain("status='pending'");
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('user_id=$1');
    expect(sql).toContain('GROUP BY currency');
    expect(sql).not.toMatch(/LIMIT|OFFSET|JOIN|date\s*[<>=]/iu);
    expect(params).toHaveLength(1);
    const totals = new Map<string, { currency: string; pending_cents: string; count: string }>();
    for (const entry of ledger) {
      if (
        entry.userId !== params[0] ||
        entry.type !== 'income' ||
        entry.status !== 'pending' ||
        entry.deleted
      )
        continue;
      const old = totals.get(entry.currency);
      totals.set(entry.currency, {
        currency: entry.currency,
        pending_cents: String(Number(old?.pending_cents ?? 0) + entry.amountCents),
        count: String(Number(old?.count ?? 0) + 1),
      });
    }
    return [...totals.values()];
  });
});

describe('complete registered receivable balance', () => {
  const entry = (changes: Partial<Entry> = {}): Entry => ({
    userId: user,
    amountCents: 10000,
    currency: 'BRL',
    type: 'income',
    status: 'pending',
    ...changes,
  });
  it('uses current installment rows after editing, removal and receipt, plus standalone income', async () => {
    ledger = [
      entry({ plan: 'plan-a', amountCents: 15000 }), // Edited from the original agreed installment.
      entry({ plan: 'plan-a', deleted: true }),
      entry({ plan: 'plan-a', status: 'settled' }),
      entry({ plan: 'plan-a', type: 'expense' }),
      entry({ amountCents: 2500, date: '2030-01-01' }),
      entry({ amountCents: 3000, date: '2020-01-01' }),
      entry({ userId: 'receivable-user-b', amountCents: 9999900 }),
      entry({ currency: 'USD', amountCents: 1000 }),
    ];
    expect(await new CustomerReceivablesRepository(user).pendingTotals()).toEqual([
      { currency: 'BRL', amountCents: 20500, count: 3 },
      { currency: 'USD', amountCents: 1000, count: 1 },
    ]);
    expect(adapter.query).toHaveBeenCalledTimes(1);
    expect(adapter.execute).not.toHaveBeenCalled();
  });
  it('counts all rows beyond the separate plan list limit and keeps tenants isolated', async () => {
    ledger = Array.from({ length: 125 }, () => entry({ amountCents: 100 }));
    ledger.push(entry({ userId: 'receivable-user-b', amountCents: 8800 }));
    expect(await new CustomerReceivablesRepository(user).pendingTotals()).toEqual([
      { currency: 'BRL', amountCents: 12500, count: 125 },
    ]);
    expect(await new CustomerReceivablesRepository('receivable-user-b').pendingTotals()).toEqual([
      { currency: 'BRL', amountCents: 8800, count: 1 },
    ]);
  });
  it('does not revive a removed pending installment using the plan original total', async () => {
    // Both plan balances and the general balance use current income rows;
    // an original agreement never restores an explicitly removed installment.
    ledger = [entry({ deleted: true, plan: 'unchanged-original-plan' })];
    expect(await new CustomerReceivablesRepository(user).pendingTotals()).toEqual([]);
  });
  it('does not turn a database failure or invalid aggregate into zero', async () => {
    adapter.query.mockRejectedValueOnce(new Error('private-database-error'));
    await expect(new CustomerReceivablesRepository(user).pendingTotals()).rejects.toThrow();
    adapter.query.mockResolvedValueOnce([{ currency: 'BRL', pending_cents: 'NaN', count: '1' }]);
    await expect(new CustomerReceivablesRepository(user).pendingTotals()).rejects.toThrow(
      'Não consegui conferir'
    );
  });
  it('requires an authenticated repository identity', () => {
    expect(() => new CustomerReceivablesRepository('')).toThrow('autenticada');
  });
});

describe('current per-plan ledger balances', () => {
  const plan = {
    id: 'fixture-plan',
    borrower: 'Pessoa Sintética',
    principal_cents: '50000',
    total_cents: '70000',
    installments: 10,
    local_time: '18:00',
    time_zone: 'America/Cuiaba',
    remaining_cents: '12000',
    paid_cents: '7000',
    currency_balances: [
      { currency: 'BRL', pending_cents: '12000', paid_cents: '7000' },
      { currency: 'USD', pending_cents: '2000', paid_cents: '1000' },
    ],
  };
  it('reads current income rows by plan and currency without the former100-plan cutoff or nominal subtraction', async () => {
    adapter.query.mockResolvedValue(
      Array.from({ length: 125 }, (_, index) => ({ ...plan, id: `fixture-${index}` }))
    );
    const results = await new CustomerReceivablesRepository(user).list();
    expect(results).toHaveLength(125);
    expect(results[0]?.currency_balances).toEqual(plan.currency_balances);
    expect(results[0]?.total_cents).toBe('70000');
    const [sql, params] = adapter.query.mock.calls[0]!;
    expect(sql).toContain('owner.user_id=$1');
    expect(sql).toContain('e.user_id=owner.user_id');
    expect(sql).toContain("e.transaction_type='income'");
    expect(sql).toContain('e.deleted_at IS NULL');
    expect(sql).toContain('GROUP BY i.plan_id,e.currency');
    expect(sql).not.toMatch(/LIMIT|GREATEST|p\.total_cents\s*-/iu);
    expect(params).toEqual([user]);
  });
  it('refuses a malformed currency balance instead of presenting a false zero', async () => {
    adapter.query.mockResolvedValue([
      { ...plan, currency_balances: [{ currency: 'USD', pending_cents: 'NaN', paid_cents: '0' }] },
    ]);
    await expect(new CustomerReceivablesRepository(user).list()).rejects.toThrow('conferir');
  });
  it('does not settle an unspecified foreign-currency installment as if it were BRL', async () => {
    adapter.transaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    adapter.queryOne.mockResolvedValue(null);
    adapter.query.mockResolvedValue([{ currency: 'USD' }]);
    await expect(
      new CustomerReceivablesRepository(user).receiveNext(
        'fixture-plan',
        'a'.repeat(64),
        '2026-11-17'
      )
    ).rejects.toThrow('outra moeda');
    expect(
      adapter.execute.mock.calls.some(([sql]) => /^(?:UPDATE|INSERT|DELETE)/iu.test(String(sql)))
    ).toBe(false);
    await expect(
      new CustomerReceivablesRepository(user).receive(
        'fixture-plan',
        50,
        'b'.repeat(64),
        '2026-11-17'
      )
    ).rejects.toThrow('outra moeda');
    expect(
      adapter.execute.mock.calls.some(([sql]) => /^(?:UPDATE|INSERT|DELETE)/iu.test(String(sql)))
    ).toBe(false);
  });
});
