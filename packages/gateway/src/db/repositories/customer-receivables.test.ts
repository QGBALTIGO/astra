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
    // list() still derives remaining from original plan total minus settled rows.
    // This balance deliberately reads only the current ledger, not that historical formula.
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
