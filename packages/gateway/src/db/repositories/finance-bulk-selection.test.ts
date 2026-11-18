import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAdapter } from '../../test-helpers.js';
import type { FinanceSelectionFilter } from './finance-bulk-selection.js';

const adapter = createMockAdapter();
vi.mock('../adapters/index.js', () => ({ getAdapter: async () => adapter }));
const { FinanceBulkSelectionRepository } = await import('./finance-bulk-selection.js');

const scope = {
  userId: 'synthetic-finance-owner',
  channelPluginId: 'channel.whatsapp',
  platformChatId: 'synthetic-chat',
  senderId: 'synthetic-chat',
};
const binding = 'synthetic-binding';
let prior: Record<string, unknown> | null;
let at: Date;
let repo: InstanceType<typeof FinanceBulkSelectionRepository>;
const allowed = async () => true;
function readSelection(filter: FinanceSelectionFilter) {
  prior = {
    phase: 'read',
    messageId: 'synthetic-read',
    receivedAt: at.getTime() - 1000,
    binding,
    filter,
    cutoff: at.getTime() - 1000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prior = null;
  at = new Date(Date.now() - 1000);
  repo = new FinanceBulkSelectionRepository();
  adapter.transaction.mockImplementation(async (work: () => Promise<unknown>) => work());
  adapter.queryOne.mockImplementation(async (sql: string) =>
    sql.includes('FROM system_settings') && prior ? { value: JSON.stringify(prior) } : null
  );
  adapter.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM channel_messages'))
      return [{ id: 'synthetic-request' }, { id: 'synthetic-read' }];
    if (sql.includes('FROM expenses e'))
      return [{ id: 'synthetic-target', version: '7', protected: false }];
    return [];
  });
});

describe('explicit pending deletion scope', () => {
  it.each(['income', 'expense'] as const)(
    'previews all pending %s with a bound type and no prior read',
    async (type) => {
      const result = await repo.prepare(
        scope,
        'synthetic-request',
        at,
        binding,
        true,
        allowed,
        type
      );
      expect(result).toMatchObject({ kind: 'preview', count: 1, filter: { type } });
      const query = adapter.query.mock.calls.find(([sql]) =>
        String(sql).includes('FROM expenses e')
      )!;
      expect(query[0]).toContain("e.user_id=$1 AND e.status='pending' AND e.deleted_at IS NULL");
      expect(query[0]).toContain('e.transaction_type=$3');
      expect(query[1]).toEqual([scope.userId, at, type]);
      expect(
        adapter.execute.mock.calls.every(
          ([sql]) => !/UPDATE expenses|DELETE FROM expenses/u.test(String(sql))
        )
      ).toBe(true);
    }
  );

  it('narrows a mixed previous read while preserving its period, currency, ids and cutoff', async () => {
    const filter: FinanceSelectionFilter = {
      status: 'pending',
      currency: 'BRL',
      from: '2026-11-01',
      to: '2026-11-30',
      search: 'Synthetic',
      ids: ['synthetic-target'],
    };
    readSelection(filter);
    const result = await repo.prepare(
      scope,
      'synthetic-request',
      at,
      binding,
      false,
      allowed,
      'income'
    );
    expect(result).toMatchObject({ kind: 'preview', filter: { ...filter, type: 'income' } });
    const query = adapter.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM expenses e')
    )!;
    expect(query[1]).toEqual([
      scope.userId,
      new Date(at.getTime() - 1000),
      'income',
      'BRL',
      '2026-11-01',
      '2026-11-30',
      '%Synthetic%',
      ['synthetic-target'],
    ]);
  });

  it('does not replace a preceding expense selection with unrelated income', async () => {
    readSelection({ type: 'expense', currency: 'BRL' });
    expect(
      await repo.prepare(scope, 'synthetic-request', at, binding, false, allowed, 'income')
    ).toEqual({ kind: 'missing' });
    expect(adapter.query).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('still requires a prior selection for a contextual request', async () => {
    expect(
      await repo.prepare(scope, 'synthetic-request', at, binding, false, allowed, 'income')
    ).toEqual({ kind: 'missing' });
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
