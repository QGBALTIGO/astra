/**
 * Human-facing expense data for AI channels (WhatsApp, Telegram, chat).
 *
 * Category IDs in PostgreSQL, API filters and exports must stay canonical.
 * Only the JSON tool result exposed to the assistant is localized.
 */
const CATEGORY_LABELS_PT_BR: Readonly<Record<string, string>> = {
  food: 'Alimentação',
  transport: 'Transporte',
  utilities: 'Contas e serviços',
  entertainment: 'Entretenimento',
  shopping: 'Compras',
  health: 'Saúde',
  education: 'Educação',
  travel: 'Viagens',
  subscription: 'Assinaturas',
  housing: 'Moradia',
  electronics: 'Eletrônicos',
  other: 'Outros',
};

export function expenseCategoryLabelPtBr(category: string): string {
  return CATEGORY_LABELS_PT_BR[category.trim().toLowerCase()] ?? category;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function presentExpense(value: unknown): unknown {
  if (!isObject(value) || typeof value.category !== 'string') return value;
  return {
    ...value,
    // Keep the underlying ID for future tool calls; present the localized
    // category in the normal field so the model doesn't repeat English codes.
    categoryCode: value.category,
    category:
      typeof value.categoryName === 'string' && value.categoryName.trim()
        ? value.categoryName
        : expenseCategoryLabelPtBr(value.category),
  };
}

/**
 * Translate only the view handed to the assistant. Never mutate repository
 * objects, stored records, CSV/JSON exports or REST API response formats.
 */
export function presentExpenseToolResult(toolName: string, result: unknown): unknown {
  if (!isObject(result)) return result;

  switch (toolName) {
    case 'add_expense':
    case 'update_expense':
      return presentExpense(result);
    case 'batch_add_expenses':
    case 'query_expenses': {
      const expenses = Array.isArray(result.expenses)
        ? result.expenses.map(presentExpense)
        : result.expenses;
      if (toolName === 'query_expenses' && typeof result.count === 'number') {
        return {
          ...result,
          expenses,
          message:
            result.count === 0
              ? 'Nenhuma despesa encontrada.'
              : `${result.count} despesa(s) encontrada(s).`,
        };
      }
      return { ...result, expenses };
    }
    case 'expense_summary': {
      if (!isObject(result.byCategory)) return result;
      const localized = Object.fromEntries(
        Object.entries(result.byCategory).map(([category, value]) => [
          expenseCategoryLabelPtBr(category),
          value,
        ])
      );
      return { ...result, byCategoryCode: result.byCategory, byCategory: localized };
    }
    default:
      // Exports stay machine-readable with canonical category IDs.
      return result;
  }
}
