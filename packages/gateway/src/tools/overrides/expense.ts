/**
 * Expense Tool Overrides
 *
 * Replaces the file-based expense tool executors from core with
 * DB-backed executors using ExpensesRepository (PostgreSQL).
 *
 * The tool DEFINITIONS remain in core. Only the executors are swapped.
 */

import type { ToolRegistry } from '@ownpilot/core/tools';
import { executeExpenseTool } from '../expense-tools.js';
import { presentExpenseToolResult } from '../expense-presentation.js';
import { getLog } from '../../services/log.js';

const log = getLog('ExpenseOverrides');

/**
 * Override file-based expense executors with DB-backed versions.
 * Must be called AFTER registerAllTools() which registers the originals.
 */
export function registerExpenseOverrides(tools: ToolRegistry, userId: string): void {
  // parse_receipt still uses the core executor (vision-based, doesn't need DB)
  const DB_BACKED_TOOLS = [
    'add_expense',
    'batch_add_expenses',
    'query_expenses',
    'expense_summary',
    'update_expense',
    'delete_expense',
    'export_expenses',
  ];

  let overridden = 0;
  for (const toolName of DB_BACKED_TOOLS) {
    // Get the existing tool definition (registered by core)
    const existing = tools.get(toolName);
    if (!existing) continue;

    // Replacing an executor must use updateExecutor: register() rejects duplicates.
    // Preserve the original qualified name and definition so tool discovery stays intact.
    const updated = tools.updateExecutor(existing.definition.name, async (args, context) => {
      // Shared registries may have been initialized for the operator. Always
      // prefer the execution's authenticated user over the registry creator,
      // otherwise a guest could read/write the operator's financial records.
      const authenticatedUserId = context?.userId ?? userId;
      const result = await executeExpenseTool(
        toolName,
        args as Record<string, unknown>,
        authenticatedUserId
      );
      return {
        content: result.success
          ? JSON.stringify(presentExpenseToolResult(toolName, result.result))
          : String(result.error ?? 'Expense operation failed'),
        isError: !result.success,
      };
    });
    if (updated) overridden++;
  }

  log.info(`Registered ${overridden} DB-backed expense tool overrides`);
}
