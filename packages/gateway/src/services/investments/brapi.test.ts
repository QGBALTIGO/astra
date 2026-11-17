import { describe, expect, it, vi } from 'vitest';
import { createBrAPIHandler } from './brapi.js';

const token = 'synthetic-test-credential';
const env = { BRAPI_TOKEN: token };
const query = (path: string) => new Request('https://app.example.test/api/market/' + path);
const quotes = () =>
  new Response(
    '{"results":[{"requestedSymbol":"PETR4","symbol":"PETR4","changed":false,"data":{"regularMarketPrice":37.12345678,"regularMarketChange":null,"regularMarketChangePercent":null,"currency":"BRL","regularMarketTime":"2026-01-02T20:00:00Z","longName":"Company synthetic-test-credential","logoUrl":"https://icons.brapi.dev/icons/PETR4.svg"}},{"requestedSymbol":"VALE3","symbol":"VALE3","changed":false,"data":null}]}',
    { headers: { 'Content-Type': 'application/json' } }
  );
describe('server-only BRAPI v2 integration', () => {
  it('reports missing configuration without inventing quotes or exposing env values', async () => {
    const fetchImpl = vi.fn(),
      handle = createBrAPIHandler({ fetchImpl });
    expect(await (await handle(query('status'))).json()).toMatchObject({ configured: false });
    expect((await handle(query('quotes?symbols=PETR4,VALE3'))).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('batches PETR4 and VALE3 through symbols and sends the secret only in Authorization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(quotes()),
      handle = createBrAPIHandler({ fetchImpl });
    const response = await handle(query('quotes?symbols=VALE3,PETR4'), env),
      text = await response.text();
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(new URL(url as string).pathname).toBe('/api/v2/stocks/quote');
    expect(new URL(url as string).searchParams.get('symbols')).toBe('PETR4,VALE3');
    expect(options.headers.Authorization).toBe('Bearer ' + token);
    expect(url).not.toContain(token);
    expect(text).not.toContain(token);
    const body = JSON.parse(text);
    expect(body.results[0].data.regularMarketPrice).toBe('37.12345678');
    expect(body.results[0].data.regularMarketChange).toBeNull();
    expect(body.results[1].data).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it.each([401, 403, 404])(
    'handles provider %s without echoing its body or credential',
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(token, { status })),
        handle = createBrAPIHandler({ fetchImpl });
      const response = await handle(query('quotes?symbols=PETR4'), env);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(token);
    }
  );
  it('respects Retry-After and does not call the provider during its cooldown', async () => {
    let now = 100_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(token, { status: 429, headers: { 'Retry-After': '7' } }))
      .mockImplementation(async () => quotes());
    const handle = createBrAPIHandler({ fetchImpl, now: () => now });
    const first = await handle(query('quotes?symbols=PETR4'), env);
    expect(first.status).toBe(429);
    expect(first.headers.get('Retry-After')).toBe('7');
    expect((await handle(query('quotes?symbols=VALE3'), env)).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 7001;
    expect((await handle(query('quotes?symbols=VALE3'), env)).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects caller credentials, invalid symbols, extra and duplicate query parameters', async () => {
    const fetchImpl = vi.fn(),
      handle = createBrAPIHandler({ fetchImpl });
    for (const path of [
      'quotes?symbols=PETR4&token=unsafe',
      'quotes?symbols=PETR4&symbols=VALE3',
      'quotes?symbols=../../secret',
      'history?symbols=PETR4&basis=unknown',
      'assets?search=%3Cscript%3E',
      'status?token=unsafe',
    ])
      expect((await handle(query(path), env)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('requests raw history for ledger valuation and keeps decimal strings and null gaps', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          '{"results":[{"requestedSymbol":"PETR4","symbol":"PETR4","data":{"historicalDataPrice":[{"date":1700000000,"rawClose":12.12345678,"adjustedClose":10.12345678},{"date":1700086400,"rawClose":null}]}}]}'
        )
      );
    const handle = createBrAPIHandler({ fetchImpl }),
      response = await handle(query('history?symbols=PETR4&range=3mo&basis=raw'), env);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(new URL(url as string).pathname).toBe('/api/v2/stocks/historical');
    expect(new URL(url as string).searchParams.get('includeRaw')).toBe('true');
    expect(await response.json()).toMatchObject({
      basis: 'raw',
      results: [
        { data: { historicalDataPrice: [{ rawClose: '12.12345678' }, { rawClose: null }] } },
      ],
    });
  });
  it('normalizes catalogue identity and permits only approved HTTPS logo paths', async () => {
    const rows = [
      {
        symbol: 'PETR4',
        name: 'Ativo',
        currency: 'BRL',
        exchange: 'B3',
        isActive: true,
        subType: 'stock',
        assetType: 'stock',
        logoUrl: 'https://evil.test/icon.svg',
      },
      {
        symbol: 'VALE3',
        name: 'Ativo válido',
        currency: 'BRL',
        exchange: 'B3',
        isActive: true,
        subType: 'stock',
        assetType: 'stock',
        logoUrl: 'https://icons.brapi.dev/icons/VALE3.svg',
      },
      {
        symbol: 'BAD3',
        name: 'Outra moeda',
        currency: 'USD',
        exchange: 'B3',
        isActive: true,
        subType: 'stock',
        assetType: 'stock',
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: rows }))),
      handle = createBrAPIHandler({ fetchImpl });
    const body = await (await handle(query('assets?kind=stock'), env)).json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].logoUrl).toBeNull();
    expect(body.items[1].logoUrl).toBe('https://icons.brapi.dev/icons/VALE3.svg');
  });
  it('reuses a bounded cached observation and clears it when the secret changes', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => quotes()),
      handle = createBrAPIHandler({ fetchImpl });
    await handle(query('quotes?symbols=PETR4'), env);
    expect(await (await handle(query('quotes?symbols=PETR4'), env)).json()).toMatchObject({
      cached: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await handle(query('quotes?symbols=PETR4'), { BRAPI_TOKEN: 'rotated-synthetic-secret' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
