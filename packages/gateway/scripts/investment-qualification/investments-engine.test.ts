import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as engine from '../../src/services/investments/engine.ts';
import { exactDecimal, movingBasisReference as ref } from './investments-reference.ts';
import type { InvestmentState, OperationInput } from '../../src/services/investments/engine.ts';

const results: { name: string; pass: boolean; error?: string }[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error: String(error) });
    console.log(`FAIL ${name}: ${error}`);
  }
}
function base(cash = '1000', quantum = '1'): InvestmentState {
  let s = engine.emptyInvestmentState();
  s = engine.addPortfolio(s, { id: 'portfolio-a', name: 'Carteira sintética A' });
  s = engine.addAccount(s, { id: 'account-a', portfolioId: 'portfolio-a', name: 'Custódia A' });
  s = engine.addAsset(s, {
    id: 'asset-a',
    symbol: 'SYN-A',
    name: 'Ativo sintético',
    kind: 'stock',
    quantum,
  });
  return engine.saveOperation(s, {
    id: 'opening-cash',
    accountId: 'account-a',
    type: 'OPEN_CASH',
    date: '2026-11-01',
    sequence: 1,
    amount: cash,
  });
}
function add(s: InvestmentState, id: string, fields: Partial<OperationInput>): InvestmentState {
  return engine.saveOperation(s, {
    id,
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'BUY',
    date: '2026-11-02',
    sequence: 1,
    quantity: '1',
    unitPrice: '1',
    fees: '0',
    ...fields,
  });
}
function bought(): InvestmentState {
  let s = base();
  s = add(s, 'buy-one', { ...ref.firstBuy });
  return add(s, 'buy-two', { ...ref.secondBuy, sequence: 2 });
}
function sold(): InvestmentState {
  return add(bought(), 'sell-part', { type: 'SELL', date: '2026-11-03', ...ref.partialSell });
}
function snapshot(s: InvestmentState, date = '2026-11-03') {
  return engine.getSnapshot(s, { date });
}

test('Independent reference purchases preserve 353 total basis and 647 cash', () => {
  const s = snapshot(bought());
  exactDecimal(s.positions[0].quantity, '15', 'quantity');
  exactDecimal(s.positions[0].cost, '353', 'basis');
  exactDecimal(s.cash, '647', 'cash');
});
test('Partial sale uses full basis, not displayed average', () => {
  const s = snapshot(sold());
  exactDecimal(s.positions[0].quantity, '9', 'quantity');
  exactDecimal(s.positions[0].cost, '211.8', 'remaining basis');
  exactDecimal(s.cash, '884', 'cash');
  exactDecimal(s.realized, '95.8', 'realized');
  exactDecimal(s.fees, '6', 'recorded fees');
});
test('Raw manual market valuation and realized/unrealized remain separate', () => {
  const s = snapshot(
    engine.saveManualQuote(sold(), {
      assetId: 'asset-a',
      date: '2026-11-03',
      price: '25',
      source: 'Exemplo sintético',
    })
  );
  exactDecimal(s.positions[0].marketValue, '225', 'market value');
  exactDecimal(s.unrealized, '13.2', 'unrealized');
  exactDecimal(s.realized, '95.8', 'realized');
  exactDecimal(s.totalValue, '1109', 'wealth');
});
test('Full liquidation removes all residual cost and realizes 109 cumulatively', () => {
  const s = snapshot(
    add(sold(), 'sell-final', { type: 'SELL', date: '2026-11-04', ...ref.finalSell }),
    '2026-11-04'
  );
  assert.equal(s.positions.length, 0);
  exactDecimal(s.cost, '0', 'cost');
  exactDecimal(s.cash, '1109', 'cash');
  exactDecimal(s.realized, '109', 'realized');
});
test('Overselling and cash shortfall reject without partial mutation', () => {
  const s = sold(),
    original = JSON.stringify(s);
  assert.throws(
    () => add(s, 'oversell', { type: 'SELL', date: '2026-11-04', quantity: '10', unitPrice: '25' }),
    /quantidade insuficiente/i
  );
  assert.throws(() => add(base('1'), 'cash-short', { quantity: '1', unitPrice: '20' }), /caixa/i);
  assert.equal(JSON.stringify(s), original);
});
test('Backdated correction validates the entire historical position path', () => {
  const s = sold(),
    buy = s.operations.find((o) => o.id === 'buy-one')!;
  assert.throws(() => engine.saveOperation(s, { ...buy, quantity: '0.5' }, buy.id), /múltipla/i);
  assert.throws(() => engine.saveOperation(s, { ...buy, quantity: '0' }, buy.id));
  const onlyFive = { ...buy, quantity: '1' };
  // 1 + 5 = 6 is enough for the existing sale; reducing the second purchase later must fail.
  const corrected = engine.saveOperation(s, onlyFive, buy.id);
  assert.throws(
    () =>
      engine.saveOperation(
        corrected,
        { ...corrected.operations.find((o) => o.id === 'buy-two')!, quantity: '1' },
        'buy-two'
      ),
    /quantidade insuficiente/i
  );
});
test('Cancel preserves history and cannot remove a purchase supporting later sales', () => {
  const s = sold();
  assert.throws(() => engine.cancelOperation(s, 'buy-one'), /quantidade insuficiente/i);
  const cancelled = engine.cancelOperation(s, 'sell-part', 'Correção de exemplo');
  assert.equal(cancelled.operations.find((o) => o.id === 'sell-part')!.status, 'cancelled');
  assert.equal(cancelled.operations.find((o) => o.id === 'sell-part')!.history.length, 1);
  exactDecimal(snapshot(cancelled).positions[0].quantity, '15', 'restored quantity');
  const retried = engine.cancelOperation(cancelled, 'sell-part');
  assert.equal(retried, cancelled);
});
test('Manual correction retains prior revision and updates all derived totals', () => {
  const s = bought(),
    buy = s.operations.find((o) => o.id === 'buy-one')!;
  const corrected = engine.saveOperation(
    s,
    { ...buy, unitPrice: '21', note: 'Preço corrigido' },
    buy.id
  );
  const op = corrected.operations.find((o) => o.id === buy.id)!;
  assert.equal(op.revision, 2);
  assert.equal(op.history.length, 1);
  assert.equal(op.history[0].data.unitPrice, '20');
  exactDecimal(snapshot(corrected).cost, '363', 'corrected basis');
  exactDecimal(snapshot(corrected).cash, '637', 'corrected cash');
});
test('Legitimate identical trades with distinct IDs and economic sequence are preserved', () => {
  let s = base();
  s = add(s, 'same-one', {});
  s = add(s, 'same-two', { sequence: 2 });
  exactDecimal(snapshot(s).positions[0].quantity, '2', 'quantity');
  assert.equal(s.operations.filter((o) => o.type === 'BUY').length, 2);
});
test('External ID retries are durable and changed payload conflicts', () => {
  const input: OperationInput = {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'BUY',
    date: '2026-11-02',
    sequence: 1,
    quantity: '2',
    unitPrice: '10',
    fees: '0',
    sourceId: 'statement',
    externalId: 'line-1',
  };
  const first = engine.saveOperation(base(), input),
    repeated = engine.saveOperation(first, input);
  assert.equal(repeated, first);
  assert.throws(
    () => engine.saveOperation(first, { ...input, unitPrice: '11' }),
    /identificador externo/i
  );
  const cancelled = engine.cancelOperation(
    first,
    first.operations.find((o) => o.externalId === 'line-1')!.id
  );
  const afterRetry = engine.saveOperation(cancelled, input);
  assert.equal(afterRetry, cancelled);
  assert.equal(
    afterRetry.operations.filter((o) => o.status === 'confirmed' && o.type === 'BUY').length,
    0
  );
});
test('Received income records gross and withholding but cash receives only 8.50', () => {
  const s = engine.saveOperation(base(), {
    id: 'income',
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'INCOME',
    date: '2026-11-02',
    sequence: 1,
    gross: '10',
    withholding: '1.5',
  });
  exactDecimal(snapshot(s).cash, '1008.5', 'cash');
  exactDecimal(snapshot(s).income, '8.5', 'net income');
  assert.throws(
    () =>
      engine.saveOperation(base(), {
        accountId: 'account-a',
        assetId: 'asset-a',
        type: 'INCOME',
        date: '2026-11-02',
        sequence: 1,
        gross: '10',
        withholding: '11',
      }),
    /retenção/i
  );
});
test('Transfer legs conserve consolidated cash and carry basis without realized profit', () => {
  let s = bought();
  s = engine.addPortfolio(s, { id: 'portfolio-b', name: 'Carteira B' });
  s = engine.addAccount(s, { id: 'account-b', portfolioId: 'portfolio-b', name: 'Custódia B' });
  s = engine.saveOperation(s, {
    accountId: 'account-b',
    type: 'OPEN_CASH',
    date: '2026-11-01',
    sequence: 1,
    amount: '0',
  });
  s = engine.saveOperation(s, {
    accountId: 'account-a',
    type: 'TRANSFER_CASH',
    date: '2026-11-03',
    sequence: 1,
    amount: '100',
    counterAccountId: 'account-b',
  });
  exactDecimal(snapshot(s).cash, '647', 'consolidated cash');
  exactDecimal(
    engine.getSnapshot(s, { date: '2026-11-03', accountId: 'account-b' }).cash,
    '100',
    'target cash'
  );
  s = engine.saveOperation(s, {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'TRANSFER_ASSET',
    date: '2026-11-03',
    sequence: 2,
    quantity: '6',
    counterAccountId: 'account-b',
  });
  const p = snapshot(s);
  exactDecimal(p.cost, '353', 'consolidated cost');
  exactDecimal(p.realized, '0', 'realized');
  exactDecimal(
    p.positions.find((o) => o.accountId === 'account-b')!.cost,
    '141.2',
    'transferred cost'
  );
  exactDecimal(p.positions.find((o) => o.accountId === 'account-a')!.cost, '211.8', 'origin cost');
});
test('Simple split preserves basis and matching raw valuation', () => {
  let s = sold();
  s = engine.saveOperation(s, {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'SPLIT',
    date: '2026-11-04',
    sequence: 1,
    ratioNumerator: '2',
    ratioDenominator: '1',
    note: 'Fonte sintética conferida',
  });
  s = engine.saveManualQuote(s, {
    assetId: 'asset-a',
    date: '2026-11-04',
    price: '12.5',
    source: 'Exemplo sintético',
  });
  const p = snapshot(s, '2026-11-04');
  exactDecimal(p.positions[0].quantity, '18', 'split quantity');
  exactDecimal(p.cost, '211.8', 'split cost');
  exactDecimal(p.positions[0].marketValue, '225', 'split market');
  assert.throws(
    () =>
      engine.saveOperation(sold(), {
        accountId: 'account-a',
        assetId: 'asset-a',
        type: 'SPLIT',
        date: '2026-11-04',
        sequence: 1,
        ratioNumerator: '1',
        ratioDenominator: '2',
        note: 'Fonte sintética conferida',
      }),
    /fração|conciliação/i
  );
});
test('Unknown initial basis remains unknown and prevents transfers without fabricated zero cost', () => {
  let s = engine.saveOperation(base(), {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'OPEN_POSITION',
    date: '2026-11-01',
    sequence: 2,
    quantity: '10',
  });
  s = engine.saveManualQuote(s, {
    assetId: 'asset-a',
    date: '2026-11-03',
    price: '25',
    source: 'Exemplo sintético',
  });
  let p = snapshot(s);
  assert.equal(p.positions[0].cost, null);
  assert.equal(p.unrealized, null);
  exactDecimal(p.totalValue, '1250', 'known market wealth');
  s = engine.saveOperation(s, {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'SELL',
    date: '2026-11-02',
    sequence: 1,
    quantity: '1',
    unitPrice: '25',
  });
  p = snapshot(s);
  assert.equal(p.realized, null);
  assert.equal(p.positions[0].cost, null);
  s = engine.addAccount(s, { id: 'account-b', portfolioId: 'portfolio-a', name: 'Custódia B' });
  assert.throws(
    () =>
      engine.saveOperation(s, {
        accountId: 'account-a',
        assetId: 'asset-a',
        type: 'TRANSFER_ASSET',
        date: '2026-11-03',
        sequence: 1,
        quantity: '1',
        counterAccountId: 'account-b',
      }),
    /custo de origem/i
  );
});
test('Missing/stale prices do not fabricate current wealth and quote corrections retain history', () => {
  let s = sold();
  const missing = snapshot(s);
  assert.equal(missing.totalValue, null);
  exactDecimal(missing.cash, '884', 'cash known despite missing quote');
  s = engine.saveManualQuote(s, {
    assetId: 'asset-a',
    date: '2026-11-03',
    price: '25',
    source: 'Exemplo sintético',
  });
  const stale = snapshot(s, '2026-11-04');
  assert.equal(stale.totalValue, null);
  exactDecimal(stale.knownValue, '1109', 'last-known estimate');
  s = engine.saveManualQuote(s, {
    assetId: 'asset-a',
    date: '2026-11-03',
    price: '26',
    source: 'Exemplo corrigido',
  });
  assert.equal(s.quotes.length, 1);
  assert.equal(s.quotes[0].history?.length, 1);
  assert.equal(s.quotes[0].history?.[0].price, '25');
});
test('Forbidden fields, invalid dates, future received operations and numeric ambiguity reject', () => {
  assert.throws(() => add(base(), 'wrong-field', { amount: '20' }), /não se aplica/i);
  assert.throws(() => add(base(), 'bad-date', { date: '2026-02-30' }), /data/i);
  assert.throws(() => add(base(), 'future-date', { date: '2099-01-01' }), /futur|hoje|data/i);
  for (const unitPrice of ['1e2', '1,50', '-1', 'NaN', '1.000.000'])
    assert.throws(() =>
      add(base(), `invalid-${unitPrice.replace(/[^a-z0-9]/gi, '')}`, { unitPrice })
    );
});
test('Eight-place precision uses canonical fixed-decimal amounts without display rounding', () => {
  let s = base('1000', '0.00000001');
  s = add(s, 'precision', { quantity: '0.12345678', unitPrice: '0.87654321' });
  const p = snapshot(s);
  // Independently multiplied: 12345678 × 87654321 / 10^16 = 0.1082152022374638, quantized to 12 places.
  exactDecimal(p.cost, '0.108215202237', 'canonical product');
  exactDecimal(p.cash, '999.891784797763', 'same canonical cash debit');
  assert.equal(engine.formatInvestmentMoney('1.005'), 'R$ 1,01');
  assert.equal(engine.formatInvestmentMoney('-1.005'), '− R$ 1,01');
});
test('Dietz reference separates 650 wealth growth from 150 gain and 12 percent', () => {
  let s = base();
  s = engine.saveOperation(s, {
    accountId: 'account-a',
    type: 'CASH_IN',
    date: '2026-11-06',
    sequence: 1,
    amount: '500',
  });
  s = engine.saveOperation(s, {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'INCOME',
    date: '2026-11-11',
    sequence: 1,
    gross: '150',
    withholding: '0',
  });
  const p = engine.calculatePerformance(s, { from: '2026-11-01', to: '2026-11-11' });
  exactDecimal(p.startValue, '1000', 'start');
  exactDecimal(p.endValue, '1650', 'end');
  exactDecimal(p.gain, '150', 'gain');
  exactDecimal(p.externalFlows, '500', 'external flows');
  exactDecimal(p.denominator, '1250', 'weighted capital');
  exactDecimal(p.returnRate, '0.12', 'return');
  assert.equal(p.sensitive, true);
});
test('Contribution without economic gain is zero return, last-day flow has zero weight', () => {
  let s = engine.saveOperation(base(), {
    accountId: 'account-a',
    type: 'CASH_IN',
    date: '2026-11-11',
    sequence: 1,
    amount: '500',
  });
  let p = engine.calculatePerformance(s, { from: '2026-11-01', to: '2026-11-11' });
  exactDecimal(p.gain, '0', 'gain');
  exactDecimal(p.returnRate, '0', 'return');
  exactDecimal(p.denominator, '1000', 'last-day contribution weight');
  s = engine.saveOperation(s, {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'INCOME',
    date: '2026-11-11',
    sequence: 2,
    gross: '150',
    withholding: '0',
  });
  p = engine.calculatePerformance(s, { from: '2026-11-01', to: '2026-11-11' });
  exactDecimal(p.returnRate, '0.15', 'last-day flow does not dilute capital');
});
test('Unknown acquisition basis permits future return from complete market/cash baseline', () => {
  let s = engine.saveOperation(base('0'), {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'OPEN_POSITION',
    date: '2026-11-01',
    sequence: 2,
    quantity: '10',
  });
  s = engine.saveManualQuote(s, {
    assetId: 'asset-a',
    date: '2026-11-01',
    price: '20',
    source: 'Baseline sintético',
  });
  s = engine.saveManualQuote(s, {
    assetId: 'asset-a',
    date: '2026-11-11',
    price: '25',
    source: 'Fechamento sintético',
  });
  const p = engine.calculatePerformance(s, { from: '2026-11-01', to: '2026-11-11' });
  exactDecimal(p.returnRate, '0.25', 'future return');
  assert.equal(snapshot(s, '2026-11-11').cost, null);
});
test('Initial position introduced inside requested period is not fabricated profit', () => {
  let s = engine.saveOperation(base('0'), {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'OPEN_POSITION',
    date: '2026-11-05',
    sequence: 1,
    quantity: '10',
    initialBasis: '200',
  });
  s = engine.saveManualQuote(s, {
    assetId: 'asset-a',
    date: '2026-11-11',
    price: '25',
    source: 'Fechamento sintético',
  });
  const p = engine.calculatePerformance(s, { from: '2026-11-01', to: '2026-11-11' });
  assert.equal(p.returnRate, null);
  assert.match(p.reason!, /inicial|abertura/i);
});
test('Unknown cash and missing endpoint prices block return, not force zero', () => {
  let s = engine.emptyInvestmentState();
  s = engine.addPortfolio(s, { id: 'p', name: 'P' });
  s = engine.addAccount(s, { id: 'a', portfolioId: 'p', name: 'A' });
  s = engine.addAsset(s, { id: 'x', symbol: 'X', name: 'X', kind: 'stock' });
  s = engine.saveOperation(s, {
    accountId: 'a',
    assetId: 'x',
    type: 'OPEN_POSITION',
    date: '2026-11-01',
    sequence: 1,
    quantity: '10',
    initialBasis: '200',
  });
  assert.equal(engine.getSnapshot(s, { date: '2026-11-01' }).cashComplete, false);
  assert.equal(engine.getSnapshot(s, { date: '2026-11-01' }).totalValue, null);
  assert.equal(
    engine.calculatePerformance(s, { from: '2026-11-01', to: '2026-11-11' }).returnRate,
    null
  );
  assert.equal(
    engine.calculatePerformance(bought(), { from: '2026-11-02', to: '2026-11-11' }).returnRate,
    null
  );
});
test('No denominator or no elapsed days returns unavailable rather than invented percentage', () => {
  assert.equal(
    engine.calculatePerformance(base('0'), { from: '2026-11-01', to: '2026-11-11' }).returnRate,
    null
  );
  assert.equal(
    engine.calculatePerformance(base(), { from: '2026-11-01', to: '2026-11-01' }).returnRate,
    null
  );
  assert.equal(
    engine.calculatePerformance(base(), { from: '2026-11-01', to: '2099-01-01' }).returnRate,
    null
  );
});
test('Own cash transfer is neutral consolidated and external only within account scope', () => {
  let s = base();
  s = engine.addPortfolio(s, { id: 'portfolio-b', name: 'B' });
  s = engine.addAccount(s, { id: 'account-b', portfolioId: 'portfolio-b', name: 'B' });
  s = engine.saveOperation(s, {
    accountId: 'account-b',
    type: 'OPEN_CASH',
    date: '2026-11-01',
    sequence: 1,
    amount: '0',
  });
  s = engine.saveOperation(s, {
    accountId: 'account-a',
    type: 'TRANSFER_CASH',
    date: '2026-11-06',
    sequence: 1,
    amount: '100',
    counterAccountId: 'account-b',
  });
  const consolidated = engine.calculatePerformance(s, { from: '2026-11-01', to: '2026-11-11' }),
    origin = engine.calculatePerformance(s, {
      from: '2026-11-01',
      to: '2026-11-11',
      accountId: 'account-a',
    });
  exactDecimal(consolidated.externalFlows, '0', 'consolidated flows');
  exactDecimal(consolidated.returnRate, '0', 'consolidated return');
  exactDecimal(origin.externalFlows, '-100', 'origin withdrawal');
  exactDecimal(origin.denominator, '950', 'origin weighted capital');
  exactDecimal(origin.returnRate, '0', 'origin return');
});
test('Editing imported trade cannot drop or rebind its durable external identity', () => {
  const original: OperationInput = {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'BUY',
    date: '2026-11-02',
    sequence: 1,
    quantity: '1',
    unitPrice: '10',
    fees: '0',
    sourceId: 'statement',
    externalId: 'line-1',
  };
  let s = engine.saveOperation(base(), original);
  const id = s.operations.find((o) => o.externalId === 'line-1')!.id;
  s = engine.saveOperation(
    s,
    {
      accountId: 'account-a',
      assetId: 'asset-a',
      type: 'BUY',
      date: '2026-11-02',
      sequence: 2,
      quantity: '1',
      unitPrice: '11',
      fees: '0',
    },
    id
  );
  const edited = s.operations.find((o) => o.id === id)!;
  assert.equal(edited.sourceId, 'statement');
  assert.equal(edited.externalId, 'line-1');
  assert.equal(
    engine.saveOperation(s, original),
    s,
    'original file remains an idempotent replay after correction'
  );
  assert.throws(
    () => engine.saveOperation(s, { ...edited, externalId: 'new-line' }, id),
    /identidade|identificador|origem/i
  );
  s = engine.cancelOperation(s, id);
  assert.equal(engine.saveOperation(s, original), s, 'cancelled original remains a tombstone');
});

function csv(rows: Record<string, string>[], header = [...engine.INVESTMENT_CSV_COLUMNS]): string {
  return [
    header.join(';'),
    ...rows.map((row) => header.map((column) => row[column] || '').join(';')),
  ].join('\n');
}
function csvRow(fields: Record<string, string> = {}): Record<string, string> {
  return {
    schema_version: 'astra-investments-v1',
    source_id: 'qa-fixture',
    event_id: 'buy-1',
    portfolio_id: 'portfolio-a',
    account_id: 'account-a',
    event_type: 'BUY',
    event_date: '2026-11-02',
    sequence: '1',
    currency: 'BRL',
    asset_id: 'asset-a',
    quantity: '10',
    unit_price: '20',
    fees: '2',
    ...fields,
  };
}
test('CSV preview does not mutate and atomic confirmation matches analytic purchases', () => {
  const s = base(),
    original = JSON.stringify(s),
    text = csv([
      csvRow(),
      csvRow({ event_id: 'buy-2', sequence: '2', quantity: '5', unit_price: '30', fees: '1' }),
    ]);
  const p = engine.previewInvestmentCSV(s, text);
  assert.equal(JSON.stringify(s), original);
  assert.equal(p.valid, true);
  assert.equal(p.added, 2);
  const committed = engine.commitInvestmentCSV(s, p);
  exactDecimal(snapshot(committed).cost, '353', 'imported cost');
  exactDecimal(snapshot(committed).cash, '647', 'imported cash');
});
test('CSV same file, reordered lines and same-ID duplicate rows never duplicate effects', () => {
  const rows = [
    csvRow(),
    csvRow({ event_id: 'buy-2', sequence: '2', quantity: '5', unit_price: '30', fees: '1' }),
  ];
  const s = engine.commitInvestmentCSV(base(), engine.previewInvestmentCSV(base(), csv(rows)));
  const repeated = engine.previewInvestmentCSV(s, csv(rows));
  assert.equal(repeated.valid, true);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.duplicates, 2);
  assert.equal(engine.commitInvestmentCSV(s, repeated), s);
  const reordered = engine.previewInvestmentCSV(s, csv([...rows].reverse()));
  assert.equal(reordered.valid, true);
  assert.equal(reordered.added, 0);
  const duplicatedInFile = engine.previewInvestmentCSV(base(), csv([rows[0], rows[0]]));
  assert.equal(duplicatedInFile.valid, true);
  assert.equal(duplicatedInFile.added, 1);
  assert.equal(duplicatedInFile.duplicates, 1);
});
test('CSV last-row failure applies zero events and same-ID changed payload conflicts', () => {
  const s = base(),
    original = JSON.stringify(s),
    p = engine.previewInvestmentCSV(
      s,
      csv([csvRow(), csvRow({ event_id: 'bad', sequence: '2', unit_price: '-1' })])
    );
  assert.equal(p.valid, false);
  assert.equal(p.errors[0].line, 3);
  assert.throws(() => engine.commitInvestmentCSV(s, p));
  assert.equal(JSON.stringify(s), original);
  const first = engine.commitInvestmentCSV(s, engine.previewInvestmentCSV(s, csv([csvRow()])));
  const changed = engine.previewInvestmentCSV(first, csv([csvRow({ unit_price: '21' })]));
  assert.equal(changed.valid, false);
  assert.match(changed.errors[0].message, /conteúdo diferente|dados diferentes/i);
});
test('CSV foreign-resource IDs, forbidden fields, wrong headers and decimal ambiguity reject', () => {
  for (const fields of [
    { account_id: 'foreign-account' },
    { portfolio_id: 'foreign-portfolio' },
    { amount: '202' },
    { unit_price: '20,00' },
    { sequence: '1.5' },
    { currency: 'USD' },
  ]) {
    const p = engine.previewInvestmentCSV(base(), csv([csvRow(fields)]));
    assert.equal(p.valid, false, JSON.stringify(fields));
    assert.ok(p.errors.length > 0);
  }
  const header = [...engine.INVESTMENT_CSV_COLUMNS];
  header[0] = 'unknown' as (typeof header)[0];
  assert.equal(engine.previewInvestmentCSV(base(), csv([csvRow()], header)).valid, false);
});
test('CSV identical economics with separate durable IDs and economic sequences remain separate', () => {
  const p = engine.previewInvestmentCSV(
    base(),
    csv([csvRow(), csvRow({ event_id: 'same-but-legitimate', sequence: '2' })])
  );
  assert.equal(p.valid, true);
  assert.equal(p.added, 2);
  const s = engine.commitInvestmentCSV(base(), p);
  exactDecimal(snapshot(s).positions[0].quantity, '20', 'separate trades preserved');
  exactDecimal(snapshot(s).cost, '404', 'separate costs');
});
test('CSV stale preview cannot overwrite a newer ledger revision', () => {
  const s = base(),
    p = engine.previewInvestmentCSV(s, csv([csvRow()]));
  const newer = engine.saveOperation(s, {
    accountId: 'account-a',
    type: 'CASH_IN',
    date: '2026-11-03',
    sequence: 1,
    amount: '10',
  });
  assert.throws(() => engine.commitInvestmentCSV(newer, p), /mudaram|prévia/i);
});
test('CSV transfer is one atomic movement and refuses missing/foreign destination', () => {
  let s = base();
  s = engine.addAccount(s, { id: 'account-b', portfolioId: 'portfolio-a', name: 'B' });
  s = engine.saveOperation(s, {
    accountId: 'account-b',
    type: 'OPEN_CASH',
    date: '2026-11-01',
    sequence: 1,
    amount: '0',
  });
  const row = csvRow({
    event_id: 'transfer-1',
    event_type: 'TRANSFER_CASH',
    asset_id: '',
    quantity: '',
    unit_price: '',
    fees: '',
    amount: '100',
    counter_account_id: 'account-b',
    transfer_group_id: 'transfer-group-1',
  });
  const p = engine.previewInvestmentCSV(s, csv([row]));
  assert.equal(p.valid, true);
  const next = engine.commitInvestmentCSV(s, p);
  exactDecimal(
    engine.getSnapshot(next, { date: '2026-11-03', accountId: 'account-a' }).cash,
    '900',
    'origin'
  );
  exactDecimal(
    engine.getSnapshot(next, { date: '2026-11-03', accountId: 'account-b' }).cash,
    '100',
    'destination'
  );
  exactDecimal(snapshot(next).cash, '1000', 'consolidated');
  assert.equal(
    engine.previewInvestmentCSV(s, csv([{ ...row, counter_account_id: 'foreign' }])).valid,
    false
  );
  assert.equal(
    engine.previewInvestmentCSV(s, csv([{ ...row, transfer_group_id: '' }])).valid,
    false
  );
});
test('JSON backup roundtrip preserves cancelled operations, quotes and audit history', () => {
  let s = sold();
  s = engine.saveManualQuote(s, {
    assetId: 'asset-a',
    date: '2026-11-03',
    price: '25',
    source: 'Exemplo sintético',
  });
  s = engine.cancelOperation(s, 'sell-part', 'Revisão sintética');
  const restored = engine.restoreInvestmentJSON(engine.exportInvestmentJSON(s));
  assert.deepEqual(restored, s);
  assert.throws(() => engine.restoreInvestmentJSON('{bad json'));
  const wrapper = JSON.parse(engine.exportInvestmentJSON(s));
  wrapper.state.operations[0].accountId = 'foreign';
  assert.throws(() => engine.restoreInvestmentJSON(JSON.stringify(wrapper)));
});
test('CSV mixed types preserve independently balanced cash, transferred basis and fees', () => {
  let s = base();
  s = engine.addAccount(s, { id: 'account-b', portfolioId: 'portfolio-a', name: 'B' });
  s = engine.saveOperation(s, {
    accountId: 'account-b',
    type: 'OPEN_CASH',
    date: '2026-11-01',
    sequence: 1,
    amount: '0',
  });
  const common = {
    schema_version: 'astra-investments-v1',
    source_id: 'mixed-types',
    portfolio_id: 'portfolio-a',
    account_id: 'account-a',
    currency: 'BRL',
  };
  const rows = [
    {
      ...common,
      event_id: 'opening',
      event_type: 'OPEN_POSITION',
      event_date: '2026-11-01',
      sequence: '2',
      asset_id: 'asset-a',
      quantity: '10',
      initial_basis: '100',
    },
    {
      ...common,
      event_id: 'buy',
      event_type: 'BUY',
      event_date: '2026-11-02',
      sequence: '1',
      asset_id: 'asset-a',
      quantity: '10',
      unit_price: '20',
      fees: '2',
    },
    {
      ...common,
      event_id: 'sell',
      event_type: 'SELL',
      event_date: '2026-11-03',
      sequence: '1',
      asset_id: 'asset-a',
      quantity: '5',
      unit_price: '30',
      fees: '1',
    },
    {
      ...common,
      event_id: 'in',
      event_type: 'CASH_IN',
      event_date: '2026-11-03',
      sequence: '2',
      amount: '100',
    },
    {
      ...common,
      event_id: 'out',
      event_type: 'CASH_OUT',
      event_date: '2026-11-03',
      sequence: '3',
      amount: '50',
    },
    {
      ...common,
      event_id: 'income',
      event_type: 'INCOME',
      event_date: '2026-11-03',
      sequence: '4',
      asset_id: 'asset-a',
      gross: '10',
      withholding: '1.5',
    },
    {
      ...common,
      event_id: 'fee',
      event_type: 'FEE',
      event_date: '2026-11-03',
      sequence: '5',
      amount: '2',
    },
    {
      ...common,
      event_id: 'split',
      event_type: 'SPLIT',
      event_date: '2026-11-04',
      sequence: '1',
      asset_id: 'asset-a',
      ratio_numerator: '2',
      ratio_denominator: '1',
      note: 'Fonte sintética conferida',
    },
    {
      ...common,
      event_id: 'cash-transfer',
      event_type: 'TRANSFER_CASH',
      event_date: '2026-11-05',
      sequence: '1',
      amount: '100',
      counter_account_id: 'account-b',
      transfer_group_id: 'cash-group',
    },
    {
      ...common,
      event_id: 'asset-transfer',
      event_type: 'TRANSFER_ASSET',
      event_date: '2026-11-05',
      sequence: '2',
      asset_id: 'asset-a',
      quantity: '10',
      counter_account_id: 'account-b',
      transfer_group_id: 'asset-group',
    },
  ];
  const p = engine.previewInvestmentCSV(s, '\uFEFF' + csv(rows).replaceAll('\n', '\r\n'));
  assert.equal(p.valid, true, JSON.stringify(p.errors));
  s = engine.commitInvestmentCSV(s, p);
  const end = snapshot(s, '2026-11-05');
  exactDecimal(end.cash, '1003.5', 'consolidated cash');
  exactDecimal(end.realized, '71.5', 'realized after standalone fee');
  exactDecimal(end.income, '8.5', 'received income');
  exactDecimal(end.fees, '5', 'all fees');
  exactDecimal(end.cost, '226.5', 'remaining basis');
  exactDecimal(
    end.positions.find((x) => x.accountId === 'account-a')!.quantity,
    '20',
    'origin quantity'
  );
  exactDecimal(end.positions.find((x) => x.accountId === 'account-a')!.cost, '151', 'origin basis');
  exactDecimal(
    end.positions.find((x) => x.accountId === 'account-b')!.quantity,
    '10',
    'target quantity'
  );
  exactDecimal(
    end.positions.find((x) => x.accountId === 'account-b')!.cost,
    '75.5',
    'target basis'
  );
});
test('CSV opening cash can establish zero baseline and repeated order rejects atomically', () => {
  const s = { ...base(), operations: [] },
    row = csvRow({
      event_id: 'opening-cash-csv',
      event_type: 'OPEN_CASH',
      event_date: '2026-11-01',
      asset_id: '',
      quantity: '',
      unit_price: '',
      fees: '',
      amount: '0',
    });
  const p = engine.previewInvestmentCSV(s, csv([row]));
  assert.equal(p.valid, true);
  const next = engine.commitInvestmentCSV(s, p);
  assert.equal(engine.getSnapshot(next, { date: '2026-11-01' }).cashComplete, true);
  const tied = engine.previewInvestmentCSV(
    base(),
    csv([csvRow(), csvRow({ event_id: 'other-id-same-order' })])
  );
  assert.equal(tied.valid, false);
  assert.match(tied.errors[0].message, /ordem/i);
});
test('Accepted extreme valuation and average values remain displayable without crashing', () => {
  let s = engine.saveOperation(base('0'), {
    accountId: 'account-a',
    assetId: 'asset-a',
    type: 'OPEN_POSITION',
    date: '2026-11-01',
    sequence: 2,
    quantity: '1000000000000',
    initialBasis: '0',
  });
  s = engine.saveManualQuote(s, {
    assetId: 'asset-a',
    date: '2026-11-03',
    price: '1000000000',
    source: 'Limite sintético',
  });
  const p = snapshot(s);
  exactDecimal(p.totalValue, '1000000000000000000000', 'extreme market');
  assert.doesNotThrow(() => engine.formatInvestmentMoney(p.totalValue));
  assert.doesNotThrow(() => engine.formatInvestmentMoney('100000000000000000000000'));
  assert.doesNotThrow(() => engine.formatInvestmentPercent('100000000000000000000000'));
});

await writeFile(
  process.env.ASTRA_QUALIFICATION_REPORT || 'qa-investments-engine-results.json',
  JSON.stringify(
    {
      scope: 'Independent synthetic references; pure local engine only',
      completedAt: new Date().toISOString(),
      cases: results,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
    },
    null,
    2
  )
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
