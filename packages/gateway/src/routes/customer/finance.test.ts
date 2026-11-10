import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';

const { methods, scope } = vi.hoisted(() => ({
  scope: vi.fn(),
  methods: {
    summary: vi.fn(),
    listTransactions: vi.fn(),
    getTransaction: vi.fn(),
    createTransaction: vi.fn(),
    updateTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
    listCategories: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    deleteCategory: vi.fn(),
  },
}));
vi.mock('../../db/repositories/customer-finance.js', async (original) => ({
  ...(await original<typeof import('../../db/repositories/customer-finance.js')>()),
  CustomerFinanceRepository: class {
    constructor(userId: string) {
      scope(userId);
    }
    summary = methods.summary;
    listTransactions = methods.listTransactions;
    getTransaction = methods.getTransaction;
    createTransaction = methods.createTransaction;
    updateTransaction = methods.updateTransaction;
    deleteTransaction = methods.deleteTransaction;
    listCategories = methods.listCategories;
    createCategory = methods.createCategory;
    updateCategory = methods.updateCategory;
    deleteCategory = methods.deleteCategory;
  },
}));
import { customerFinanceRoutes, currentCustomerFinancePeriod } from './finance.js';
import { CustomerFinanceError } from '../../db/repositories/customer-finance.js';

const id = 'whatsapp:5511999990101';
const category = {
  id: 'cat-food',
  name: 'Alimentação',
  type: 'expense',
  color: '#2563EB',
  archived: false,
};
const transaction = {
  id: 'transaction-1',
  description: 'Almoço',
  amount: 36.39,
  type: 'expense',
  status: 'settled',
  categoryId: 'cat-food',
  date: '2026-11-10',
};
const input = {
  description: 'Almoço',
  amount: 36.39,
  type: 'expense',
  status: 'settled',
  categoryId: 'cat-food',
  date: '2026-11-10',
};
function app(context: 'write' | 'read' | 'none' = 'write', dataUserId = id) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (context !== 'none')
      c.set('customer', {
        dataUserId,
        accountId: 'account-1',
        timeZone: 'America/Campo_Grande',
        access: { canWrite: context === 'write' },
      } as CustomerSessionContext);
    await next();
  });
  app.route('/customer/finance', customerFinanceRoutes);
  return app;
}
function request(
  method: string,
  value?: unknown,
  headers: Record<string, string> = {}
): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  methods.summary.mockResolvedValue({ income: 100, expenses: 36.39, result: 63.61 });
  methods.listTransactions.mockResolvedValue({
    transactions: [transaction],
    total: 1,
    page: 1,
    pageSize: 30,
  });
  methods.getTransaction.mockResolvedValue(transaction);
  methods.createTransaction.mockResolvedValue(transaction);
  methods.updateTransaction.mockResolvedValue(transaction);
  methods.deleteTransaction.mockResolvedValue(true);
  methods.listCategories.mockResolvedValue([category]);
  methods.createCategory.mockResolvedValue(category);
  methods.updateCategory.mockResolvedValue(category);
  methods.deleteCategory.mockResolvedValue({ deleted: false, archived: true });
});

describe('customer finance HTTP scope and permissions', () => {
  it.each(['/summary', '/transactions', '/categories', '/transactions/transaction-1'])(
    'requires a customer session for %s',
    async (path) => {
      expect((await app('none').request(`/customer/finance${path}`)).status).toBe(401);
      expect(scope).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['POST', '/transactions', input],
    ['PATCH', '/transactions/transaction-1', { amount: 40 }],
    ['DELETE', '/transactions/transaction-1', undefined],
    ['POST', '/categories', { name: 'Teste', type: 'expense', color: '#2563EB' }],
    ['PATCH', '/categories/cat-food', { name: 'Teste' }],
    ['DELETE', '/categories/cat-food', undefined],
  ])('denies read-only account mutation %s %s', async (method, path, body) => {
    expect(
      (await app('read').request(`/customer/finance${path}`, request(String(method), body))).status
    ).toBe(403);
    expect(scope).not.toHaveBeenCalled();
  });
  it('allows an expired read-only customer to consult their own records', async () => {
    const response = await app('read').request('/customer/finance/transactions');
    expect(response.status).toBe(200);
    expect(scope).toHaveBeenCalledWith(id);
    expect(await response.json()).toMatchObject({ data: { transactions: [transaction] } });
  });
  it('uses the server identity despite a forged header', async () => {
    const response = await app().request('/customer/finance/transactions', {
      headers: { 'X-User-Id': 'default' },
    });
    expect(response.status).toBe(200);
    expect(scope).toHaveBeenCalledExactlyOnceWith(id);
  });
  it('rejects a body or query that attempts to choose an identity', async () => {
    expect(
      (
        await app().request(
          '/customer/finance/transactions',
          request('POST', { ...input, userId: 'default' })
        )
      ).status
    ).toBe(400);
    expect((await app().request('/customer/finance/transactions?userId=default')).status).toBe(400);
    expect(methods.createTransaction).not.toHaveBeenCalled();
    expect(methods.listTransactions).not.toHaveBeenCalled();
  });
});

describe('finance operations', () => {
  it('uses the customer timezone to choose the calendar month', async () => {
    expect(
      currentCustomerFinancePeriod('America/Campo_Grande', new Date('2026-12-01T02:00:00Z'))
    ).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(currentCustomerFinancePeriod('Asia/Tokyo', new Date('2026-11-30T16:00:00Z'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    const response = await app().request('/customer/finance/summary?from=2026-11-01&to=2026-11-30');
    expect(response.status).toBe(200);
    expect(methods.summary).toHaveBeenCalledWith('2026-11-01', '2026-11-30');
  });
  it('passes typed filters and pagination', async () => {
    const response = await app().request(
      '/customer/finance/transactions?type=income&status=pending&categoryId=cat-a&page=2&pageSize=10&search=Salario'
    );
    expect(response.status).toBe(200);
    expect(methods.listTransactions).toHaveBeenCalledWith({
      type: 'income',
      status: 'pending',
      categoryId: 'cat-a',
      page: 2,
      pageSize: 10,
      search: 'Salario',
    });
  });
  it('passes one stable request key to creation', async () => {
    const response = await app().request(
      '/customer/finance/transactions',
      request('POST', input, { 'Idempotency-Key': 'draft-12345678' })
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { transaction } });
    expect(methods.createTransaction).toHaveBeenCalledWith(input, 'draft-12345678');
  });
  it.each([0, -5, 1.001, 10_000_000_000])(
    'rejects invalid monetary amount %s before any database write',
    async (amount) => {
      expect(
        (
          await app().request(
            '/customer/finance/transactions',
            request('POST', { ...input, amount })
          )
        ).status
      ).toBe(400);
      expect(methods.createTransaction).not.toHaveBeenCalled();
    }
  );
  it.each([
    { date: '2026-02-30' },
    { type: 'transfer' },
    { status: 'unknown' },
    { description: '' },
    { categoryId: '' },
  ])('rejects invalid input %j', async (changes) => {
    expect(
      (
        await app().request(
          '/customer/finance/transactions',
          request('POST', { ...input, ...changes })
        )
      ).status
    ).toBe(400);
    expect(methods.createTransaction).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON, empty patch and invalid pagination', async () => {
    expect(
      (
        await app().request('/customer/finance/transactions', {
          ...request('POST'),
          body: '{broken',
        })
      ).status
    ).toBe(400);
    expect(
      (await app().request('/customer/finance/transactions/transaction-1', request('PATCH', {})))
        .status
    ).toBe(400);
    expect(
      (await app().request('/customer/finance/transactions?page=0&pageSize=1001')).status
    ).toBe(400);
  });
  it('updates and deletes only the requested scoped resource', async () => {
    expect(
      (
        await app().request(
          '/customer/finance/transactions/transaction-1',
          request('PATCH', { status: 'settled' })
        )
      ).status
    ).toBe(200);
    expect(methods.updateTransaction).toHaveBeenCalledWith('transaction-1', { status: 'settled' });
    expect(
      (await app().request('/customer/finance/transactions/transaction-1', request('DELETE')))
        .status
    ).toBe(200);
    expect(methods.deleteTransaction).toHaveBeenCalledWith('transaction-1');
  });
  it('returns 404 without disclosing another customer resource', async () => {
    methods.getTransaction.mockResolvedValueOnce(null);
    methods.updateTransaction.mockResolvedValueOnce(null);
    methods.deleteTransaction.mockResolvedValueOnce(false);
    expect((await app().request('/customer/finance/transactions/foreign')).status).toBe(404);
    expect(
      (
        await app().request(
          '/customer/finance/transactions/foreign',
          request('PATCH', { amount: 10 })
        )
      ).status
    ).toBe(404);
    expect(
      (await app().request('/customer/finance/transactions/foreign', request('DELETE'))).status
    ).toBe(404);
  });
  it('creates categories with idempotency and returns actual archival/transfer results', async () => {
    const payload = { name: 'Alimentação', type: 'expense', color: '#2563EB' };
    expect(
      (
        await app().request(
          '/customer/finance/categories',
          request('POST', payload, { 'Idempotency-Key': 'category-12345678' })
        )
      ).status
    ).toBe(201);
    expect(methods.createCategory).toHaveBeenCalledWith(payload, 'category-12345678');
    const response = await app().request(
      '/customer/finance/categories/cat-food',
      request('DELETE', { transferToId: 'cat-other' })
    );
    expect(await response.json()).toMatchObject({ data: { deleted: false, archived: true } });
    expect(methods.deleteCategory).toHaveBeenCalledWith('cat-food', 'cat-other');
  });
  it('allows category archiving but rejects an in-place type change', async () => {
    expect(
      (
        await app().request(
          '/customer/finance/categories/cat-food',
          request('PATCH', { archived: true })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await app().request(
          '/customer/finance/categories/cat-food',
          request('PATCH', { type: 'income' })
        )
      ).status
    ).toBe(400);
  });
  it('rejects conflicting transfer destinations', async () => {
    expect(
      (
        await app().request(
          '/customer/finance/categories/cat-food?transferToId=other',
          request('DELETE', { transferToId: 'cat-other' })
        )
      ).status
    ).toBe(400);
    expect(methods.deleteCategory).not.toHaveBeenCalled();
  });
  it('preserves business conflicts and hides private database errors', async () => {
    methods.createTransaction.mockRejectedValueOnce(
      new CustomerFinanceError('Tentativa já utilizada.', 409)
    );
    expect(
      (await app().request('/customer/finance/transactions', request('POST', input))).status
    ).toBe(409);
    methods.summary.mockRejectedValueOnce(new Error('password=private-data'));
    const response = await app().request('/customer/finance/summary');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-data');
  });
});
