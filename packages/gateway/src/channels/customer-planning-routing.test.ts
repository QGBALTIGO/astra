import { describe, expect, it } from 'vitest';
import { parseCustomerPlanningIntent } from './customer-planning-routing.js';
import { planningNameKey } from '../db/repositories/customer-plan-actions.js';

describe('explicit customer planning commands', () => {
  it('understands the reported confirmations and car query without an AI provider', () => {
    expect(parseCustomerPlanningIntent('Mais uma parcela de Júlio César paga')).toEqual({
      kind: 'payment',
      name: 'julio cesar',
    });
    expect(parseCustomerPlanningIntent('Quanto resta da parcela do meu carro?')).toEqual({
      kind: 'balance',
      name: 'parcela do meu carro',
    });
    expect(planningNameKey('Parcela do carro')).toBe(planningNameKey('parcela do meu carro'));
    expect(parseCustomerPlanningIntent('Minhas metas')).toEqual({ kind: 'list', group: 'metas' });
    expect(parseCustomerPlanningIntent('Guardei 100 reais na meta Viagem')).toEqual({
      kind: 'saving',
      amount: 100,
      name: 'viagem',
    });
  });
  it('keeps money, installment counts and historical opening progress explicit', () => {
    expect(
      parseCustomerPlanningIntent('Crie uma meta Viagem de R$ 8.000,50 com R$ 100 guardados')
    ).toMatchObject({
      kind: 'create',
      planKind: 'goal',
      name: 'Viagem',
      amount: 8000.5,
      progress: 100,
    });
    expect(
      parseCustomerPlanningIntent('Defina um orçamento de Alimentação de R$ 500')
    ).toMatchObject({ kind: 'create', planKind: 'budget', name: 'Alimentação', amount: 500 });
    expect(
      parseCustomerPlanningIntent('Cadastre compra Notebook em 12 parcelas de R$ 300, com 2 pagas')
    ).toMatchObject({
      kind: 'create',
      planKind: 'installment',
      name: 'Notebook',
      amount: 300,
      total: 12,
      paid: 2,
    });
  });
  it.each([
    'Vou pagar a parcela do carro',
    'Não paguei a parcela do carro',
    'Talvez paguei uma parcela do carro',
    'Pague a parcela do carro',
    'Mais uma parcela de Júlio César paga?',
    'Se eu pagar a parcela do carro',
    'Crie uma meta Viagem',
    'Guarde 100 reais na meta Viagem',
    'Ele disse: "Mais uma parcela do carro paga"',
  ])('does not execute a future, negative, quoted or uncertain request: %s', (text) => {
    expect(parseCustomerPlanningIntent(text)).toBeNull();
  });
});
