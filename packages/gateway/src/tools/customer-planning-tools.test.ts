import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ owner: vi.fn(), subscriptions: vi.fn() }));
vi.mock('../db/repositories/customer-planning.js', () => ({
  CustomerPlanningRepository: class {
    constructor(userId: string) {
      f.owner(userId);
    }
    subscriptions = f.subscriptions;
  },
}));
import { executeCustomerPlanningTool } from './customer-planning-tools.js';

beforeEach(() => {
  vi.clearAllMocks();
  f.subscriptions.mockResolvedValue([
    {
      id: 'private-id',
      title: 'Revista Café',
      amount: 12.9,
      nextDueDate: '2026-12-18',
      notes: 'private notes',
      userId: 'a',
    },
    { id: 'second-id', title: 'Música', amount: 20, nextDueDate: null },
  ]);
});

describe('customer subscription facts for AI', () => {
  it('reads planning under the authenticated customer and exposes only display facts', async () => {
    const result = await executeCustomerPlanningTool(
      'list_customer_subscriptions',
      { search: 'CAFE', userId: 'attacker' },
      'customer-a'
    );
    expect(f.owner).toHaveBeenCalledWith('customer-a');
    expect(result).toEqual({
      success: true,
      result: {
        subscriptions: [
          { title: 'Revista Café', amount: 12.9, currency: 'BRL', nextDueDate: '2026-12-18' },
        ],
        total: 1,
        page: 1,
        hasMore: false,
        note: expect.stringContaining('não confirma cobrança'),
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|attacker|userId/);
  });
  it('preserves ambiguous names and unconfigured renewal without guessing', async () => {
    f.subscriptions.mockResolvedValue([
      { title: 'Revista Um', amount: 10, nextDueDate: null },
      { title: 'Revista Dois', amount: 20, nextDueDate: '2026-12-18' },
    ]);
    const result = await executeCustomerPlanningTool(
      'list_customer_subscriptions',
      { search: 'revista' },
      'customer-a'
    );
    expect(result).toMatchObject({
      success: true,
      result: { total: 2, subscriptions: [{ nextDueDate: null }, { amount: 20 }] },
    });
  });
  it('paginates with at most twenty facts instead of overflowing the model context', async () => {
    f.subscriptions.mockResolvedValue(
      Array.from({ length: 45 }, (_, i) => ({
        title: 'Revista ' + i,
        amount: i + 1,
        nextDueDate: null,
      }))
    );
    const first = await executeCustomerPlanningTool(
      'list_customer_subscriptions',
      {},
      'customer-a'
    );
    const third = await executeCustomerPlanningTool(
      'list_customer_subscriptions',
      { page: 3 },
      'customer-a'
    );
    expect(first).toMatchObject({
      result: { total: 45, hasMore: true, subscriptions: expect.any(Array) },
    });
    expect((first.result as { subscriptions: unknown[] }).subscriptions).toHaveLength(20);
    expect((third.result as { subscriptions: unknown[] }).subscriptions).toHaveLength(5);
    expect(third).toMatchObject({ result: { hasMore: false } });
  });
  it.each([undefined, '', ' '])('does not query without a real user scope (%s)', async (user) => {
    expect(
      await executeCustomerPlanningTool('list_customer_subscriptions', {}, user)
    ).toMatchObject({ success: false });
    expect(f.owner).not.toHaveBeenCalled();
  });
  it.each([
    { page: 0 },
    { page: 1.5 },
    { page: '2' },
    { page: 101 },
    { search: '' },
    { search: 'a'.repeat(121) },
    { search: 123 },
  ])('rejects invalid lookup arguments before database access: %j', async (args) => {
    expect(
      await executeCustomerPlanningTool('list_customer_subscriptions', args, 'customer-a')
    ).toMatchObject({ success: false });
    expect(f.owner).not.toHaveBeenCalled();
  });
  it('never exposes database errors or accepts a write tool name', async () => {
    f.subscriptions.mockRejectedValue(new Error('postgresql://private-password@internal/database'));
    const result = await executeCustomerPlanningTool(
      'list_customer_subscriptions',
      {},
      'customer-a'
    );
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('suas assinaturas'),
    });
    expect(JSON.stringify(result)).not.toMatch(/password|postgresql|internal/);
    expect(
      await executeCustomerPlanningTool('delete_subscription', {}, 'customer-a')
    ).toMatchObject({ success: false });
    expect(f.owner).toHaveBeenCalledTimes(1);
  });
});
