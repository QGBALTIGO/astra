import { describe, expect, it } from 'vitest';
import { currencyThresholdRequest } from './currency-intent.js';

describe('currency condition consent', () => {
  it('parses the screenshot exactly without a reminder clock', () => {
    expect(
      currencyThresholdRequest('Me avise se o dólar chegar a 5 reais cravado ou menos')
    ).toEqual({
      action: 'follow',
      source: 'ptax',
      subject: 'USD',
      delivery: 'threshold',
      threshold: '5',
      comparison: 'at_or_below',
    });
  });
  it.each([
    ['Me avise se o dólar ficar abaixo de R$ 5,123456', 'below', '5.123456', 'USD'],
    ['Me avise quando o euro ficar em R$ 6 ou mais', 'at_or_above', '6', 'EUR'],
    ['Me avise se USD <= 5', 'at_or_below', '5', 'USD'],
    ['Me avise se a libra ficar acima de 7 reais', 'above', '7', 'GBP'],
  ])('preserves comparison and decimal precision: %s', (text, comparison, threshold, subject) => {
    expect(currencyThresholdRequest(text)).toMatchObject({ comparison, threshold, subject });
  });
  it.each([
    'Me avise se o dólar ficar em R$ 5 ou menos amanhã às 10h',
    'Me lembre de verificar o dólar amanhã às 10h',
    'Não me avise se o dólar ficar abaixo de 5',
    'Explique: me avise se o dólar ficar abaixo de 5',
    '"Me avise se o dólar ficar abaixo de 5"',
    'Me avise se o dólar chegar a 5',
    'Me avise se o dólar ficar abaixo de 5,0000001',
    'Me avise se o dólar ficar abaixo de 5 mil reais',
    'Me avise se o dólar chegar a 500 centavos ou menos',
    'Me avise se o dólar ficar em 5 reais ou menos na semana que vem',
    'Me avise se o dólar ficar abaixo de 5 ou acima de 6',
    'Me avise se o dólar ficar abaixo de 0',
    'Me avise quando o Codex voltar',
  ])('does not invent subscription terms: %s', (text) =>
    expect(currencyThresholdRequest(text)).toBeUndefined()
  );
});
