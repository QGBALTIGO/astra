import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  ctx: {
    channelPluginId: 'channel.whatsapp',
    platformChatId: 'synthetic-chat',
    channelMessageId: 'synthetic-message',
    channelMessageTimestamp: Date.parse('2026-11-11T02:00:00Z'),
  },
  account: vi.fn(),
  owner: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  summary: vi.fn(),
  categories: vi.fn(),
}));
vi.mock('@ownpilot/core/agent', () => ({ getExecContext: () => f.ctx }));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: f.account },
}));
vi.mock('../db/repositories/customer-finance.js', async (original) => ({
  ...(await original<typeof import('../db/repositories/customer-finance.js')>()),
  CustomerFinanceRepository: class {
    constructor(userId: string) {
      f.owner(userId);
    }
    createTransaction = f.create;
    listTransactions = f.list;
    getTransaction = f.get;
    updateTransaction = f.update;
    deleteTransaction = f.remove;
    summary = f.summary;
    listCategories = f.categories;
  },
}));
import { CUSTOMER_FINANCE_TOOLS, executeCustomerFinanceTool } from './customer-finance-tools.js';
const data = {
  description: 'Recebimento Cakto',
  amount: 770,
  type: 'income',
  status: 'pending',
  date: '2026-11-20',
};
beforeEach(() => {
  vi.clearAllMocks();
  f.ctx.channelMessageId = 'synthetic-message';
  f.ctx.channelMessageTimestamp = Date.parse('2026-11-11T02:00:00Z');
  f.account.mockResolvedValue({ timeZone: 'America/Campo_Grande' });
  f.categories.mockResolvedValue([
    { id: 'in', name: 'Outras entradas', type: 'income', archived: false },
    { id: 'out', name: 'Outros', type: 'expense', archived: false },
  ]);
  f.create.mockImplementation(async (value) => ({ id: 'saved', ...value }));
  f.get.mockResolvedValue({
    id: 'saved',
    type: 'expense',
    status: 'settled',
    categoryId: 'out',
    date: '2026-11-10',
  });
  f.update.mockImplementation(async (id, value) => ({ id, ...value }));
  f.remove.mockResolvedValue(true);
});
describe('same-ledger finance tools', () => {
  it('exposes complete typed CRUD and summary', () =>
    expect(CUSTOMER_FINANCE_TOOLS.map((t) => t.name)).toEqual([
      'record_transaction',
      'list_transactions',
      'update_transaction',
      'delete_transaction',
      'financial_summary',
    ]));
  it('records R$770 to receive as pending income, in the authenticated ledger', async () => {
    const result = await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, userId: 'another-tenant' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(true);
    expect(f.owner).toHaveBeenCalledWith('whatsapp:synthetic-a');
    expect(f.create).toHaveBeenCalledWith(
      { ...data, categoryId: 'in' },
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
  });
  it('uses the same idempotency key for a message replay', async () => {
    await executeCustomerFinanceTool('record_transaction', data, 'user-a');
    await executeCustomerFinanceTool('record_transaction', data, 'user-a');
    expect(f.create.mock.calls[0]![1]).toBe(f.create.mock.calls[1]![1]);
    await executeCustomerFinanceTool('record_transaction', data, 'user-b');
    expect(f.create.mock.calls[2]![1]).not.toBe(f.create.mock.calls[0]![1]);
  });
  it('does not create without an authenticated incoming message', async () => {
    f.ctx.channelMessageId = '';
    expect((await executeCustomerFinanceTool('record_transaction', data, 'user-a')).success).toBe(
      false
    );
    expect(f.create).not.toHaveBeenCalled();
  });
  it('does not treat an expected future income as already received', async () => {
    const result = await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, status: 'settled' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Valores previstos devem ficar pendentes');
    expect(f.create).not.toHaveBeenCalled();
  });
  it('checks the customer local calendar day instead of UTC for settlement', async () => {
    const result = await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, status: 'settled', date: '2026-11-11' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(false);
    expect(f.account).toHaveBeenCalledWith('whatsapp:synthetic-a');
    expect(f.create).not.toHaveBeenCalled();
    const local = await executeCustomerFinanceTool(
      'record_transaction',
      { ...data, status: 'settled', date: '2026-11-10' },
      'whatsapp:synthetic-a'
    );
    expect(local.success).toBe(true);
  });
  it.each(['type', 'status', 'date', 'description', 'amount'])(
    'requires %s rather than inventing it',
    async (key) => {
      const args: Record<string, unknown> = { ...data };
      delete args[key];
      expect((await executeCustomerFinanceTool('record_transaction', args, 'user-a')).success).toBe(
        false
      );
      expect(f.create).not.toHaveBeenCalled();
    }
  );
  it('corrects a mistaken expense to income on the same ID, without creating or deleting', async () => {
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', type: 'income' },
      'user-a'
    );
    expect(result.success).toBe(true);
    expect(f.update).toHaveBeenCalledWith('saved', { type: 'income', categoryId: 'in' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('does not alter a missing/foreign record', async () => {
    f.get.mockResolvedValueOnce(null);
    expect(
      (
        await executeCustomerFinanceTool(
          'update_transaction',
          { transaction_id: 'foreign', type: 'income' },
          'user-a'
        )
      ).success
    ).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('does not confirm an update if the record was removed after the lookup', async () => {
    f.update.mockResolvedValueOnce(null);
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', type: 'income' },
      'user-a'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('A alteração não foi salva');
    expect(result.result).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('preserves a pending amount when correcting an expense to income', async () => {
    f.get.mockResolvedValueOnce({
      id: 'saved',
      type: 'expense',
      status: 'pending',
      categoryId: 'out',
      date: '2026-11-20',
    });
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', type: 'income' },
      'user-a'
    );
    expect(result.success).toBe(true);
    expect(f.update).toHaveBeenCalledWith('saved', { type: 'income', categoryId: 'in' });
    expect(f.update.mock.calls[0]![1]).not.toHaveProperty('status');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('does not mark a future pending income as received without an actual receipt date', async () => {
    f.get.mockResolvedValueOnce({
      id: 'saved',
      type: 'income',
      status: 'pending',
      categoryId: 'in',
      date: '2026-11-20',
    });
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', status: 'settled' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('can receive a previously pending income on the actual local day', async () => {
    f.get.mockResolvedValueOnce({
      id: 'saved',
      type: 'income',
      status: 'pending',
      categoryId: 'in',
      date: '2026-11-20',
    });
    const result = await executeCustomerFinanceTool(
      'update_transaction',
      { transaction_id: 'saved', status: 'settled', date: '2026-11-10' },
      'whatsapp:synthetic-a'
    );
    expect(result.success).toBe(true);
    expect(f.update).toHaveBeenCalledWith('saved', { status: 'settled', date: '2026-11-10' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('does not convert category to one belonging to the wrong transaction type', async () => {
    f.categories.mockResolvedValueOnce([{ id: 'out', type: 'expense', archived: false }]);
    expect(
      (
        await executeCustomerFinanceTool(
          'update_transaction',
          { transaction_id: 'saved', type: 'income' },
          'user-a'
        )
      ).success
    ).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('uses the existing soft-delete repository operation', async () => {
    expect(
      (
        await executeCustomerFinanceTool(
          'delete_transaction',
          { transaction_id: 'saved' },
          'user-a'
        )
      ).success
    ).toBe(true);
    expect(f.remove).toHaveBeenCalledWith('saved');
    expect(f.create).not.toHaveBeenCalled();
  });
  it('does not confirm deletion of a missing or foreign record', async () => {
    f.remove.mockResolvedValueOnce(false);
    const result = await executeCustomerFinanceTool(
      'delete_transaction',
      { transaction_id: 'foreign' },
      'user-a'
    );
    expect(result.success).toBe(false);
    expect(result.result).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('lists scoped IDs and filters rather than making them up', async () => {
    f.list.mockResolvedValueOnce({ transactions: [{ id: 'saved' }], total: 1 });
    const result = await executeCustomerFinanceTool(
      'list_transactions',
      { search: 'Cakto', type: 'income', status: 'pending' },
      'user-a'
    );
    expect(result.success).toBe(true);
    expect(f.list).toHaveBeenCalledWith({
      pageSize: 20,
      search: 'Cakto',
      type: 'income',
      status: 'pending',
    });
  });
  it('preserves actual/pending totals returned by the shared ledger', async () => {
    const totals = {
      income: 100,
      expenses: 20,
      result: 80,
      pendingIncome: 770,
      pendingExpenses: 50,
    };
    f.summary.mockResolvedValueOnce(totals);
    expect(
      (
        await executeCustomerFinanceTool(
          'financial_summary',
          { from: '2026-11-01', to: '2026-11-30' },
          'user-a'
        )
      ).result
    ).toEqual(totals);
  });
  it('does not expose database internals on error or invent successful persistence', async () => {
    f.create.mockRejectedValueOnce(new Error('password=secret SQL error'));
    const result = await executeCustomerFinanceTool('record_transaction', data, 'user-a');
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('secret');
  });
});
