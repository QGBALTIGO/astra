import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as E from '../../src/services/investments/engine.ts';
import { exactDecimal } from './investments-reference.ts';
import type { MarketQuote, MarketHistory } from '../../src/services/investments/market-types.ts';

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
function identity(symbol = 'PETR4', kind: 'stock' | 'fii' | 'etf' = 'stock') {
  return {
    provider: 'BRAPI' as const,
    symbol,
    kind,
    currency: 'BRL' as const,
    exchange: 'B3' as const,
    verifiedAt: new Date(Date.now() - 1000).toISOString(),
  };
}
function base(automatic = true) {
  let s = E.addPortfolio(E.emptyInvestmentState(), { id: 'p', name: 'Carteira sintética' });
  s = E.addAccount(s, { id: 'a', portfolioId: 'p', name: 'Custódia sintética' });
  s = E.addAsset(s, {
    id: 'asset',
    symbol: 'PETR4',
    kind: 'stock',
    name: 'Ativo de avaliação',
    ...(automatic ? { pricingMode: 'automatic' as const, marketIdentity: identity() } : {}),
  });
  s = E.saveOperation(s, {
    id: 'cash',
    accountId: 'a',
    type: 'OPEN_CASH',
    date: '2026-11-01',
    sequence: 1,
    amount: '1000',
  });
  return E.saveOperation(s, {
    id: 'buy',
    accountId: 'a',
    assetId: 'asset',
    type: 'BUY',
    date: '2026-11-02',
    sequence: 1,
    quantity: '10',
    unitPrice: '20',
    fees: '0',
  });
}
const now = Date.now(),
  date = E.investmentToday();
function quote(price = '25', offset = -2000): MarketQuote {
  return {
    symbol: 'PETR4',
    price,
    change: '1',
    changePercent: '4.17',
    marketTimestamp: new Date(now + offset).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    currency: 'BRL',
    source: 'BRAPI',
    sourceUrl: 'https://brapi.dev/docs/acoes/cotacao',
    provenance: 'authenticated-proxy',
  };
}
function history(price: string | null = '24'): MarketHistory {
  return {
    symbol: 'PETR4',
    fetchedAt: new Date(now).toISOString(),
    fromCache: false,
    points: [
      {
        date: '2026-11-13',
        price,
        source: 'BRAPI',
        raw: true,
        fetchedAt: new Date(now).toISOString(),
        barTimestamp: '2026-11-13T03:00:00.000Z',
      },
    ],
  };
}
test('Quote25 changes current position gain to50/+25% without changing executed cost or quantity', () => {
  const s = base(),
    book = JSON.stringify(s.operations),
    revision = s.revision,
    next = E.applyMarketQuotes(s, [quote()]),
    p = E.getSnapshot(next, { date }).positions[0],
    change = E.getPositionChange(p);
  exactDecimal(p.marketValue, '250', 'position value');
  exactDecimal(p.cost, '200', 'cost');
  exactDecimal(change.gain, '50', 'gain');
  exactDecimal(change.rate, '0.25', 'rate');
  assert.equal(JSON.stringify(next.operations), book);
  assert.equal(next.revision, revision);
  assert.equal(next.marketRevision, 1);
  assert.equal(next.operations.find((o) => o.type === 'BUY')!.unitPrice, '20');
  assert.equal(p.marketTimestamp, quote().marketTimestamp);
});
test('Newer quote18 changes gain to-20/-10%; providerdaychange does not become positiongain', () => {
  let s = E.applyMarketQuotes(base(), [quote()]);
  s = E.applyMarketQuotes(s, [quote('18', -1000)]);
  const p = E.getSnapshot(s, { date }).positions[0],
    change = E.getPositionChange(p);
  exactDecimal(p.marketValue, '180', 'position value');
  exactDecimal(change.gain, '-20', 'loss');
  exactDecimal(change.rate, '-0.1', 'loss rate');
  exactDecimal(p.quantity, '10', 'quantity');
  exactDecimal(p.averagePrice, '20', 'executed cost');
});
test('Partial sale leaves proportional basis and market result only on remaining quantity', () => {
  let s = E.saveOperation(base(), {
    id: 'sell',
    accountId: 'a',
    assetId: 'asset',
    type: 'SELL',
    date: '2026-11-03',
    sequence: 1,
    quantity: '4',
    unitPrice: '30',
    fees: '0',
  });
  s = E.applyMarketQuotes(s, [quote()]);
  let p = E.getSnapshot(s, { date }).positions[0];
  exactDecimal(p.quantity, '6', 'remaining quantity');
  exactDecimal(p.cost, '120', 'remaining cost');
  exactDecimal(p.realized, '40', 'realized gain');
  exactDecimal(E.getPositionChange(p).gain, '30', 'open gain');
  exactDecimal(E.getPositionChange(p).rate, '0.25', 'open gain rate');
  s = E.applyMarketQuotes(s, [quote('18', -1000)]);
  p = E.getSnapshot(s, { date }).positions[0];
  exactDecimal(E.getPositionChange(p).gain, '-12', 'remaining open loss');
  exactDecimal(p.realized, '40', 'realized result unaffected');
});
test('Manual and automatic observations coexist; selected mode determines valuation', () => {
  let s = E.saveManualQuote(base(false), {
    assetId: 'asset',
    date,
    price: '22',
    source: 'Preço manual sintético',
  });
  const before = s;
  s = E.applyMarketQuotes(s, [quote()]);
  assert.equal(s, before, 'manual mode must ignore automatic observations');
  s = E.setAssetPricingMode(s, 'asset', 'automatic', identity());
  s = E.applyMarketQuotes(s, [quote()]);
  exactDecimal(E.getSnapshot(s, { date }).positions[0].marketValue, '250', 'automatic selected');
  s = E.setAssetPricingMode(s, 'asset', 'manual');
  exactDecimal(
    E.getSnapshot(s, { date }).positions[0].marketValue,
    '220',
    'original manual data survived'
  );
  assert.equal(s.quotes.length, 2);
});
test('Automatic admission rejects unsupported identity, wrongclass and fractional instrument metadata', () => {
  for (const change of [
    { symbol: 'UNKNOWN3', kind: 'stock' as const },
    { symbol: 'PETR4', kind: 'fii' as const },
    { symbol: 'PETR4', kind: 'stock' as const, quantum: '0.1' },
  ]) {
    let s = E.addPortfolio(E.emptyInvestmentState(), { id: 'p', name: 'P' });
    s = E.addAsset(s, { id: 'asset', name: 'X', ...change });
    assert.throws(() => E.setAssetPricingMode(s, 'asset', 'automatic'));
  }
});
test('Invalid currency, future/older observations never overwrite a valid quote', () => {
  const s = E.applyMarketQuotes(base(), [quote()]),
    serialized = JSON.stringify(s);
  for (const q of [
    { ...quote('18', -5000) },
    { ...quote('18', -1000), currency: 'USD' },
    { ...quote('18', -1000), price: '0' },
    { ...quote('18', -1000), marketTimestamp: new Date(now + 86400000).toISOString() },
  ])
    assert.throws(() => E.applyMarketQuotes(s, [q as MarketQuote]));
  assert.equal(JSON.stringify(s), serialized);
  const replay = E.applyMarketQuotes(s, [quote()]);
  assert.equal(replay, s, 'same source observation is idempotent');
  const unrelated = E.applyMarketQuotes(s, [{ ...quote(), symbol: 'VALE3' }]);
  assert.equal(unrelated, s, 'unrelated symbol cannot change the holding');
});
test('Raw historical prices retain original dates and gaps with no purchase/adjusted-price fallback', () => {
  let s = E.applyMarketHistory(base(), history());
  let points = E.getAssetPriceHistory(s, 'asset');
  assert.equal(points[0].date, '2026-11-13');
  exactDecimal(points[0].price, '24', 'raw close');
  s = E.applyMarketHistory(s, history(null));
  points = E.getAssetPriceHistory(s, 'asset');
  assert.equal(points[0].price, null, 'missingraw must be a gap');
  assert.equal(points.length, 1);
  assert.equal(E.getSnapshot(s, { date: '2026-11-13' }).totalValue, null);
});
test('Same-day current quote cannot be overwritten by lower-resolution daily history', () => {
  let s = E.applyMarketQuotes(base(), [quote()]);
  const h = history('10');
  h.points = [{ ...h.points[0], date, barTimestamp: `${date}T03:00:00.000Z` }];
  s = E.applyMarketHistory(s, h);
  exactDecimal(
    E.getSnapshot(s, { date }).positions[0].marketValue,
    '250',
    'intraday quote takes precedence'
  );
  assert.equal(
    s.quotes.find((q) => q.origin === 'automatic' && q.date === date)!.observationType,
    'quote'
  );
});
test('Market metadata and gap provenance survive a validated JSON backup roundtrip', () => {
  let s = E.applyMarketQuotes(base(), [quote()]);
  s = E.applyMarketHistory(s, history(null));
  const restored = E.restoreInvestmentJSON(E.exportInvestmentJSON(s));
  assert.deepEqual(restored, s);
  const tampered = JSON.parse(E.exportInvestmentJSON(s));
  tampered.state.quotes.find((q: { origin: string }) => q.origin === 'automatic').symbol = 'PETR3';
  assert.throws(() => E.restoreInvestmentJSON(JSON.stringify(tampered)));
});
test('Confirming a trade prepared before a market refresh preserves the newer automatic observation', () => {
  const old = base(),
    candidate = E.saveOperation(old, {
      id: 'contribution',
      accountId: 'a',
      type: 'CASH_IN',
      date: '2026-11-03',
      sequence: 1,
      amount: '10',
    }),
    current = E.applyMarketQuotes(old, [quote()]),
    saved = E.preserveAutomaticMarketData(candidate, current);
  assert.equal(saved.operations.length, 3);
  assert.equal(saved.revision, candidate.revision);
  assert.equal(saved.quotes.find((q) => q.origin === 'automatic')!.price, '25');
  exactDecimal(E.getSnapshot(saved, { date }).cash, '810', 'new contribution cash');
  exactDecimal(
    E.getPositionChange(E.getSnapshot(saved, { date }).positions[0]).gain,
    '50',
    'latest price gain remains'
  );
});
test('Verified provider identity admits additional Brazilian stock, ETF and FII beyond the old public samples', () => {
  for (const [symbol, kind] of [
    ['BBAS3', 'stock'],
    ['IVVB11', 'etf'],
    ['MXRF11', 'fii'],
  ] as const) {
    let s = E.addPortfolio(E.emptyInvestmentState(), { id: 'p', name: 'P' });
    s = E.addAccount(s, { id: 'a', portfolioId: 'p', name: 'A' });
    s = E.addAsset(s, {
      id: 'asset',
      symbol,
      kind,
      name: 'Fixture autenticada',
      pricingMode: 'automatic',
      marketIdentity: identity(symbol, kind),
    });
    s = E.saveOperation(s, {
      accountId: 'a',
      type: 'OPEN_CASH',
      date: '2026-11-01',
      sequence: 1,
      amount: '1000',
    });
    s = E.saveOperation(s, {
      accountId: 'a',
      assetId: 'asset',
      type: 'BUY',
      date: '2026-11-02',
      sequence: 1,
      quantity: '10',
      unitPrice: '20',
      fees: '0',
    });
    s = E.applyMarketQuotes(s, [{ ...quote(), symbol }]);
    exactDecimal(
      E.getPositionChange(E.getSnapshot(s, { date }).positions[0]).gain,
      '50',
      `${symbol} open gain`
    );
    assert.throws(() =>
      E.setAssetPricingMode(s, 'asset', 'automatic', {
        ...identity(symbol, kind),
        currency: 'USD',
      } as never)
    );
  }
});

await writeFile(
  process.env.ASTRA_MARKET_QUALIFICATION_REPORT || 'qa-investments-market-engine-results.json',
  JSON.stringify(
    {
      scope: 'Pure synthetic automatic quote-to-ledger references, no network',
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
