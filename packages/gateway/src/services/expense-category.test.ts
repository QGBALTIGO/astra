import { describe, expect, it } from 'vitest';
import { inferExpenseCategory } from './expense-category.js';
describe('purchased item category', () => {
  it.each([
    'suco Ensaio Ipê para a equipe',
    'suco de laranja',
    'Refrigerante para o almoço',
    'Chá da tarde',
    'Café Ensaio Ipê',
    'Pão para a hamburgueria',
  ])('classifies food and beverages as food: %s', (text) =>
    expect(inferExpenseCategory(text)).toBe('food')
  );
  it.each([
    'Guardanapos Ensaio Ipê (Hamburgueria)',
    'guardanapos na lanchonete',
    'embalagens para pizza',
    'copos descartáveis do restaurante',
    'papel toalha no supermercado',
    'máquina de café',
  ])('does not turn supplies/equipment into food because of the merchant: %s', (text) =>
    expect(inferExpenseCategory(text)).toBe('shopping')
  );
});
