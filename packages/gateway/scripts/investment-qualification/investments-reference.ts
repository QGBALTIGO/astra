import assert from 'node:assert/strict';

// Independently worked reference values from the reviewed financial specification.
// Fixtures intentionally use literal expected amounts, not the candidate's formulas.
export const movingBasisReference = {
  openingCash: '1000',
  firstBuy: { quantity: '10', unitPrice: '20', fees: '2' },
  secondBuy: { quantity: '5', unitPrice: '30', fees: '1' },
  partialSell: { quantity: '6', unitPrice: '40', fees: '3' },
  finalSell: { quantity: '9', unitPrice: '25', fees: '0' },
  checkpoints: {
    afterBuys: { quantity: '15', basis: '353', cash: '647' },
    afterPartialSell: { quantity: '9', basis: '211.8', cash: '884', realized: '95.8' },
    pricedRemainder: { price: '25', market: '225', unrealized: '13.2', wealth: '1109' },
    afterFinalSell: { quantity: '0', basis: '0', cash: '1109', realized: '109' },
  },
};

export const dietzReference = {
  baseline: { date: '2026-11-01', cash: '1000' },
  contribution: { date: '2026-11-06', amount: '500' },
  income: { date: '2026-11-11', gross: '150', withholding: '0' },
  end: { date: '2026-11-11', wealth: '1650' },
  expected: { days: 10, result: '150', weightedCapital: '1250', ratio: '0.12' },
};

export const incomeReference = { gross: '10', withholding: '1.5', net: '8.5' };
export const splitReference = {
  beforeQuantity: '9',
  afterQuantity: '18',
  basis: '211.8',
  afterPrice: '12.5',
  market: '225',
};

function normalize(value: string) {
  assert.match(value, /^-?\d+(?:\.\d+)?$/);
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return (whole === '-0' && !trimmed ? '0' : whole) + (trimmed ? `.${trimmed}` : '');
}
export function exactDecimal(actual: unknown, expected: string, label: string) {
  assert.equal(typeof actual, 'string', `${label}: financial output must remain a decimal string`);
  assert.equal(normalize(actual as string), normalize(expected), label);
}
