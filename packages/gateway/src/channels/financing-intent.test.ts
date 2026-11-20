import { describe, expect, it } from 'vitest';
import { classifyFinancingPaymentAuthority, parseFinancingIntent } from './financing-intent.js';

describe('Financing payment authority from the original customer message', () => {
  it.each([
    ['Paguei 28 mil já do carro, debita lá', 'ambiguous'],
    ['Paguei 28 mil já do meu carro, debita lá', 'ambiguous'],
    ['Já paguei 28 mil no carro', 'ambiguous'],
    ['Paguei 28 mil já do carro, debita lá. ' + 'Explicação adicional. '.repeat(40), 'ambiguous'],
    ['Já paguei 28 mil do carro', 'ambiguous'],
    ['Já paguei 28 mil no total do carro', 'historical'],
    ['Já paguei no total 28 mil do carro', 'historical'],
    ['O total que já paguei no carro é 28 mil', 'historical'],
    ['Debita 28 mil já do meu carro', 'ambiguous'],
    ['Paguei 28 mil ao todo do financiamento', 'historical'],
    ['Até agora paguei 28 mil do carro', 'historical'],
    ['Paguei mais 28 mil do carro, esse é o total acumulado', 'historical'],
    ['Não, do parcelamento do carro', 'correction'],
    ['Corrija o pagamento do financiamento do carro', 'correction'],
    ['É do parcelamento do carro', 'correction'],
    ['Na verdade, era do parcelamento do carro', 'correction'],
    ['Isso é do parcelamento do carro', 'correction'],
    ['Me refiro ao parcelamento do carro', 'correction'],
    ['Na verdade, era do carro', 'correction'],
    ['Se eu disser que paguei 500 do carro, registre', 'ambiguous'],
    ['Paguei 500 do carro? Não tenho certeza', 'ambiguous'],
    ['Hoje eu não paguei 500 do carro', 'ambiguous'],
    ['Paguei 500 do carro e 300 da moto', 'ambiguous'],
  ] as const)('requires clarification instead of a new payment: %s', (text, kind) => {
    expect(classifyFinancingPaymentAuthority(text)).toEqual({ kind });
  });

  it.each([
    'Paguei 500 do carro',
    'Paguei mais 500 do carro hoje',
    'Já paguei 500 hoje do carro',
    'Paguei 500 do carro agora',
    'Acabei de pagar 500 do carro',
  ])('binds an explicit new payment to its actual amount and financing: %s', (text) => {
    expect(classifyFinancingPaymentAuthority(text)).toEqual({
      kind: 'new_payment',
      name: 'carro',
      amountCents: 50_000,
    });
  });

  it.each([
    'Paguei 40 da pizza',
    'Paguei 40 no mercado',
    'Já paguei 50 hoje no almoço',
    'Paguei 100 na lavagem do carro',
    'Paguei 100 de gasolina do carro',
    'Paguei 250 na manutenção do carro',
    'Paguei 100 do seguro do carro',
    'Quanto falta pagar do carro?',
    'Quanto já paguei do carro?',
    'O valor do carro é 72 mil, já paguei 28 mil',
    'Me lembre de lavar o carro amanhã',
  ])(
    'does not turn an unrelated expense, query or complete opening balance into a payment: %s',
    (text) => {
      expect(classifyFinancingPaymentAuthority(text)).toEqual({ kind: 'none' });
    }
  );

  it('permits an explicitly zero opening balance without inventing a prior payment', () => {
    expect(parseFinancingIntent('O valor do carro é 72 mil, já paguei 0')).toEqual({
      kind: 'create',
      name: 'carro',
      principalCents: 7_200_000,
      openingCents: 0,
    });
  });

  it('keeps a recognizable but impossible opening balance out of the expense fallback', () => {
    expect(parseFinancingIntent('O valor do carro é 72 mil, já paguei 100 mil')).toEqual({
      kind: 'unconfirmed',
    });
  });
});
