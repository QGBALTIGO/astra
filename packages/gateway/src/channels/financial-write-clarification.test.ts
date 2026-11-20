import { describe, expect, it } from 'vitest';
import {
  financialWriteClarification,
  financialWriteRefusal,
  financingClarificationReply,
  isOnlyRequestedFinanceMetadataUpdate,
} from './financial-write-clarification.js';

describe('financial write clarification', () => {
  it.each(['Paguei 28000 do carro até agora', 'Já paguei no total 28 mil do carro'])(
    'keeps accumulated history out of new-payment instructions: %s',
    (text) => {
      expect(financialWriteClarification(text)?.reason).toBe('historical_financing_amount');
      expect(financingClarificationReply(text)).toContain('total já pago');
    }
  );
  it.each([
    'Paguei 28 mil já do meu carro, debita lá',
    'Já paguei 28 mil no carro',
    'Na verdade, era do parcelamento do carro',
    'Isso é do parcelamento do carro',
    'Me refiro ao parcelamento do carro',
    'O valor do carro é 72 mil, já paguei 100 mil',
  ])('proves no mutation was attempted for an unresolved financing request: %s', (text) => {
    expect(financialWriteRefusal(text)).toMatchObject({
      success: false,
      result: { operation: 'financial_write_refusal', mutation: 'not_attempted' },
    });
    expect(financingClarificationReply(text)).toBeTruthy();
  });
  it.each([
    'Paguei 100 de gasolina do carro',
    'Paguei 250 na manutenção do carro',
    'Paguei 50 na lavagem do carro',
    'Paguei 400 de seguro do carro',
  ])('keeps ordinary vehicle expenses available: %s', (text) => {
    expect(financialWriteClarification(text)).toBeNull();
  });
  it.each([
    [
      'Corrija apenas a categoria da despesa Parcela do carro para Transporte',
      'category',
      'Transporte',
    ],
    [
      'Altere a descrição de Pagamento do financiamento para Parcela do carro',
      'description',
      'Parcela do carro',
    ],
  ])('allows only the explicitly requested metadata field: %s', (text, field, value) => {
    expect(financingClarificationReply(text)).toBeNull();
    expect(financialWriteRefusal(text)).toMatchObject({
      result: { reason: 'financial_metadata_correction_requires_update' },
    });
    const update = { transaction_id: 'existing', [field]: value };
    expect(isOnlyRequestedFinanceMetadataUpdate(text, update, 'transaction_id')).toBe(true);
    for (const extra of [
      { amount: 100 },
      { date: '2026-11-19' },
      { status: 'settled' },
      { type: 'income' },
    ]) {
      expect(
        isOnlyRequestedFinanceMetadataUpdate(text, { ...update, ...extra }, 'transaction_id')
      ).toBe(false);
    }
  });
});
