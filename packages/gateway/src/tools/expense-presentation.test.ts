import { describe, expect, it } from 'vitest';
import { expenseCategoryLabelPtBr, presentExpenseToolResult } from './expense-presentation.js';

describe('expense categories presented in Brazilian Portuguese', () => {
  it.each([
    ['other', 'Outros'],
    ['shopping', 'Compras'],
    ['electronics', 'Eletrônicos'],
    ['transport', 'Transporte'],
    ['food', 'Alimentação'],
    ['utilities', 'Contas e serviços'],
    ['entertainment', 'Entretenimento'],
    ['health', 'Saúde'],
    ['education', 'Educação'],
    ['travel', 'Viagens'],
    ['subscription', 'Assinaturas'],
    ['housing', 'Moradia'],
  ])('%s is displayed as %s', (category, label) => {
    expect(expenseCategoryLabelPtBr(category)).toBe(label);
  });

  it('preserves unknown/custom categories instead of inventing a label', () => {
    expect(expenseCategoryLabelPtBr('custom_category')).toBe('custom_category');
  });

  it('localizes the WhatsApp expense listing without changing money, dates or DB rows', () => {
    const raw = {
      count: 2,
      message: 'Found 2 expense(s).',
      expenses: [
        { id: 'e1', date: '2026-11-09', amount: 101.35, category: 'other', description: 'sertão' },
        {
          id: 'e2',
          date: '2026-11-09',
          amount: 15,
          category: 'electronics',
          description: 'adaptador HDMI',
        },
      ],
    };

    const result = presentExpenseToolResult('query_expenses', raw);
    expect(result).toEqual({
      ...raw,
      message: '2 despesa(s) encontrada(s).',
      expenses: [
        { ...raw.expenses[0], category: 'Outros', categoryCode: 'other' },
        { ...raw.expenses[1], category: 'Eletrônicos', categoryCode: 'electronics' },
      ],
    });
    expect(raw.expenses[0]?.category).toBe('other');
    expect(raw.expenses[1]?.category).toBe('electronics');
  });

  it('localizes summaries while preserving canonical category codes and aggregate values', () => {
    const raw = {
      totalAmount: 200,
      count: 2,
      byCategory: {
        food: { amount: 100, count: 1 },
        shopping: { amount: 100, count: 1 },
      },
      byCurrency: { BRL: 200 },
    };
    const result = presentExpenseToolResult('expense_summary', raw);
    expect(result).toEqual({
      ...raw,
      byCategory: {
        Alimentação: { amount: 100, count: 1 },
        Compras: { amount: 100, count: 1 },
      },
      byCategoryCode: raw.byCategory,
    });
    expect(raw.byCategory).toHaveProperty('food');
  });

  it('localizes confirmations and batches while retaining original amounts', () => {
    const expense = { amount: 470, category: 'transport', description: 'parcela do carro' };
    expect(presentExpenseToolResult('add_expense', expense)).toEqual({
      ...expense,
      categoryCode: 'transport',
      category: 'Transporte',
    });
    expect(presentExpenseToolResult('batch_add_expenses', { added: 1, expenses: [expense] })).toEqual({
      added: 1,
      expenses: [{ ...expense, categoryCode: 'transport', category: 'Transporte' }],
    });
    expect(expense.category).toBe('transport');
  });

  it('keeps raw export data untouched to preserve machine-readable IDs', () => {
    const exported = { format: 'json', data: [{ category: 'food' }], count: 1 };
    expect(presentExpenseToolResult('export_expenses', exported)).toBe(exported);
  });

  it('does not alter errors or non-expense results', () => {
    expect(presentExpenseToolResult('delete_expense', { message: 'deleted' })).toEqual({
      message: 'deleted',
    });
    expect(presentExpenseToolResult('query_expenses', null)).toBeNull();
  });
});
