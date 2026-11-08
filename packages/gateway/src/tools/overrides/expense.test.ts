/**
 * Expense Override Registration Tests
 *
 * Guarantees DB-backed expense executors replace the existing core handlers.
 * ToolRegistry.register() rejects duplicates; only updateExecutor() may do this.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerAllTools, ToolRegistry } from '@ownpilot/core/tools';
import { registerExpenseOverrides } from './expense.js';

const mockExecuteExpenseTool = vi.fn();

vi.mock('../expense-tools.js', () => ({
  executeExpenseTool: (...args: unknown[]) => mockExecuteExpenseTool(...args),
}));

type Handler = (args: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;

function makeFakeRegistry(existing: string[]) {
  const handlers = new Map<string, Handler>();
  const get = vi.fn((name: string) => {
    if (!existing.includes(name)) return undefined;
    return { definition: { name: `core.${name}`, description: `${name} definition` } };
  });
  const updateExecutor = vi.fn((name: string, handler: Handler) => {
    if (!existing.includes(name.replace(/^core\./, ''))) return false;
    handlers.set(name, handler);
    return true;
  });
  const register = vi.fn();
  return { get, updateExecutor, register, handlers };
}

const DB_TOOLS = [
  'add_expense',
  'batch_add_expenses',
  'query_expenses',
  'expense_summary',
  'update_expense',
  'delete_expense',
  'export_expenses',
];

describe('registerExpenseOverrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates all seven registered handlers instead of re-registering duplicates', () => {
    const registry = makeFakeRegistry(DB_TOOLS);
    registerExpenseOverrides(registry as never, 'user-1');

    expect(registry.updateExecutor).toHaveBeenCalledTimes(7);
    expect(registry.register).not.toHaveBeenCalled();
    for (const name of DB_TOOLS) {
      expect(registry.handlers.has(`core.${name}`)).toBe(true);
    }
  });

  it('does not override parse_receipt (vision-only, not DB-backed)', () => {
    const registry = makeFakeRegistry([...DB_TOOLS, 'parse_receipt']);
    registerExpenseOverrides(registry as never, 'user-1');
    expect(registry.handlers.has('core.parse_receipt')).toBe(false);
  });

  it('skips tools not present in the registry', () => {
    const registry = makeFakeRegistry(['add_expense', 'query_expenses']);
    registerExpenseOverrides(registry as never, 'user-1');
    expect(registry.updateExecutor).toHaveBeenCalledTimes(2);
  });

  it('does nothing when none of the expected tools are registered', () => {
    const registry = makeFakeRegistry([]);
    registerExpenseOverrides(registry as never, 'user-1');
    expect(registry.updateExecutor).not.toHaveBeenCalled();
  });

  it('passes the user ID and arguments to PostgreSQL-backed executor', async () => {
    const registry = makeFakeRegistry(['add_expense']);
    mockExecuteExpenseTool.mockResolvedValue({
      success: true,
      result: { id: 'exp-1', amount: 12 },
    });
    registerExpenseOverrides(registry as never, 'user-42');
    const handler = registry.handlers.get('core.add_expense')!;
    const result = await handler({ amount: 12, description: 'café' });

    expect(mockExecuteExpenseTool).toHaveBeenCalledWith(
      'add_expense',
      { amount: 12, description: 'café' },
      'user-42'
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ id: 'exp-1', amount: 12 });
  });

  it('reports an underlying execution failure without pretending success', async () => {
    const registry = makeFakeRegistry(['delete_expense']);
    mockExecuteExpenseTool.mockResolvedValue({ success: false, error: 'not found' });
    registerExpenseOverrides(registry as never, 'user-1');
    const result = await registry.handlers.get('core.delete_expense')!({ expenseId: 'exp-x' });
    expect(result).toEqual({ isError: true, content: 'not found' });
  });

  it('uses a generic error when the executor supplies no error field', async () => {
    const registry = makeFakeRegistry(['query_expenses']);
    mockExecuteExpenseTool.mockResolvedValue({ success: false });
    registerExpenseOverrides(registry as never, 'user-1');
    const result = await registry.handlers.get('core.query_expenses')!({});
    expect(result).toEqual({ isError: true, content: 'Expense operation failed' });
  });

  it('uses updateExecutor with the existing qualified definition name', () => {
    const registry = makeFakeRegistry(['add_expense']);
    registerExpenseOverrides(registry as never, 'user-1');
    expect(registry.updateExecutor.mock.calls[0]?.[0]).toBe('core.add_expense');
  });

  it('actually replaces existing core handlers in the real ToolRegistry', async () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);

    const previousExpenseExecutor = registry.get('expense_summary')?.executor;
    const originalReceiptExecutor = registry.get('parse_receipt')?.executor;
    expect(previousExpenseExecutor).toBeDefined();

    registerExpenseOverrides(registry, 'user-42');

    expect(registry.get('expense_summary')?.executor).not.toBe(previousExpenseExecutor);
    expect(registry.get('parse_receipt')?.executor).toBe(originalReceiptExecutor);

    mockExecuteExpenseTool.mockResolvedValue({ success: true, result: { totalAmount: 50 } });
    const result = await registry.get('expense_summary')!.executor(
      { period: 'this_month' },
      { userId: 'user-42', conversationId: 'test', callId: 'test' } as never
    );

    expect(mockExecuteExpenseTool).toHaveBeenCalledWith(
      'expense_summary',
      { period: 'this_month' },
      'user-42'
    );
    expect(JSON.parse(result.content as string)).toEqual({ totalAmount: 50 });
  });
});
