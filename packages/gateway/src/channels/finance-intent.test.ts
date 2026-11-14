import { describe, expect, it } from 'vitest';
import { isFinanceReadOnlyRequest, requiredFinanceReadTool } from './finance-intent.js';
describe('financial read intent', () => {
  it.each([
    'Mostre o gasto guardanapos Ensaio Bambu de R$ 4,60.',
    'Quanto ficou o total dos gastos com pão e café?',
    'Qual foi meu último gasto?',
    'Quanto recebi hoje?',
    'Mostre como registrar um gasto',
    'Mostre meus gastos e não altere nada.',
    'Quero ver meus lançamentos',
  ])('keeps a lookup read-only: %s', (text) => {
    expect(isFinanceReadOnlyRequest(text)).toBe(true);
    expect(requiredFinanceReadTool(text)).toBe('core.list_transactions');
  });
  it.each([
    'Gastei R$ 4,60 de guardanapos',
    'E mais R$ 4,60 de guardanapos',
    'Mostre os gastos e corrija o café para R$ 5',
    'Quanto gastei? Depois remova o lançamento do pão.',
    'Quero registrar uma despesa',
    'Qual a temperatura agora?',
  ])('does not prevent an explicit mutation or misroute another domain: %s', (text) =>
    expect(isFinanceReadOnlyRequest(text)).toBe(false)
  );
  it('keeps external/hypothetical financial lookups read-only without forcing the local ledger', () => {
    expect(isFinanceReadOnlyRequest('Mostre meus gastos na planilha Google')).toBe(true);
    expect(requiredFinanceReadTool('Mostre meus gastos na planilha Google')).toBeUndefined();
    expect(requiredFinanceReadTool('Mostre os gastos deste exemplo fictício')).toBeUndefined();
  });
});
