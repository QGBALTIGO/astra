import { mockCustomerApi } from './customer-fixtures.ts';
import * as E from '../src/pages/customer/investments/investment-engine.ts';

export const BASE = process.env.ASTRA_QA_BASE_URL || 'http://127.0.0.1:5188';
export const ago = (days) => {
  const date = new Date(E.investmentToday() + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};
const items = [
  ['PETR4', 'Petrobras PN', 'stock'],
  ['VALE3', 'Vale ON', 'stock'],
  ['BOVA11', 'iShares Ibovespa', 'etf'],
  ['HGLG11', 'CSHG Logística', 'fii'],
].map(([symbol, name, kind]) => ({
  symbol,
  name,
  kind,
  provider: 'BRAPI',
  verifiedAt: new Date(Date.now() - 1000).toISOString(),
  currency: 'BRL',
  exchange: 'B3',
  automaticEligible: true,
  logoUrl: `https://icons.brapi.dev/icons/${symbol}.svg`,
}));

export function portfolioSeed(mode = 'dense') {
  if (mode === 'empty') return E.emptyInvestmentState();
  let state = E.emptyInvestmentState();
  state = E.addPortfolio(state, { id: 'qa-portfolio', name: 'Carteira QA' });
  state = E.addAccount(state, {
    id: 'qa-account',
    portfolioId: 'qa-portfolio',
    name: 'Custódia QA',
  });
  state = E.addAsset(state, {
    id: 'qa-stock',
    symbol: 'PETR4',
    name: 'Petrobras PN',
    kind: 'stock',
    ...(mode === 'dense' || mode === 'negative'
      ? {
          pricingMode: 'automatic',
          marketIdentity: {
            provider: 'BRAPI',
            symbol: 'PETR4',
            kind: 'stock',
            currency: 'BRL',
            exchange: 'B3',
            verifiedAt: new Date(Date.now() - 1000).toISOString(),
          },
        }
      : {}),
  });
  state = E.saveOperation(state, {
    accountId: 'qa-account',
    type: 'OPEN_CASH',
    date: ago(30),
    sequence: 1,
    amount: '1000',
  });
  state = E.saveOperation(state, {
    accountId: 'qa-account',
    type: 'BUY',
    assetId: 'qa-stock',
    date: ago(30),
    sequence: 2,
    quantity: '10',
    unitPrice: '30',
    fees: '0',
  });
  if (mode === 'sparse' || mode === 'single') {
    state = E.saveManualQuote(state, {
      assetId: 'qa-stock',
      date: ago(30),
      price: '30',
      source: 'Fechamento sintético inicial',
    });
    if (mode === 'sparse')
      state = E.saveManualQuote(state, {
        assetId: 'qa-stock',
        date: E.investmentToday(),
        price: '33',
        source: 'Fechamento sintético final',
      });
  }
  return state;
}

export async function mockReleaseDashboard(page, options = {}) {
  const api = await mockCustomerApi(page, {
    authenticated: true,
    theme: options.theme || 'light',
    seededPlans: true,
    ...options,
  });
  // The older portal fixture freezes November 10 for golden images; investment
  // provider identities and price timestamps must use this run's current date.
  await page.clock.setFixedTime(new Date());
  const calls = [],
    blocked = [],
    bookWrites = [],
    payouts = [];
  let state = structuredClone(options.book || portfolioSeed(options.mode || 'dense'));
  let storageVersion = 0,
    nextBookFailure = null,
    nextPayoutFailure = false,
    releasePut = null,
    holding = false;
  let referralRecords = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      label: 'Convite 12AB34CD',
      status: 'approved',
      reward: 40,
      cycle: '2026-11',
      note: 'Assinatura validada.',
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      requestedAt: null,
      paidAt: null,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      label: 'Convite 56EF78AB',
      status: 'registered',
      reward: null,
      cycle: null,
      note: '',
      createdAt: new Date().toISOString(),
      approvedAt: null,
      requestedAt: null,
      paidAt: null,
    },
  ];
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'icons.brapi.dev') {
      blocked.push(url.origin + url.pathname);
      const symbol = url.pathname.match(/([A-Z0-9]+)\.svg/)?.[1] || 'B3';
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="70"><rect width="100" height="70" rx="8" fill="${symbol === 'PETR4' ? '#00864c' : '#124f9e'}"/><text x="50" y="41" text-anchor="middle" fill="white" font-family="Arial" font-size="17">${symbol}</text></svg>`,
      });
    }
    if (url.origin !== BASE && /^https?:$/.test(url.protocol)) {
      blocked.push(url.origin + url.pathname);
      return route.abort();
    }
    return route.fallback();
  });
  await page.route('**/api/v1/customer/referrals**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    calls.push(`${request.method()} ${path}`);
    let data;
    if (path.endsWith('/claim')) data = { claimed: false };
    else if (path.endsWith('/payout')) {
      const body = request.postDataJSON();
      payouts.push({ body, path });
      if (nextPayoutFailure) {
        nextPayoutFailure = false;
        return route.fulfill({
          status: 503,
          json: {
            success: false,
            error: { code: 'TEMPORARY', message: 'Não foi possível registrar o pedido agora.' },
          },
        });
      }
      const id = path.split('/').at(-2),
        record = referralRecords.find((value) => value.id === id);
      record.status = 'requested';
      record.requestedAt = new Date().toISOString();
      data = { record };
    } else
      data = {
        code: 'AST-0123456789ABCDEF',
        link: 'https://app.astraacessor.pro/api/v1/customer/referrals/invite/AST-0123456789ABCDEF',
        records: referralRecords,
        available: referralRecords
          .filter((value) => value.status === 'approved')
          .reduce((sum, value) => sum + value.reward, 0),
        paid: 0,
        awaitingValidation: 1,
        rewardedThisCycle: 1,
        cycle: '2026-11',
        limit: 5,
        minReward: 20,
        maxReward: 100,
      };
    return route.fulfill({ json: { success: true, data } });
  });
  const preferences = { enabled: true, time: '07:00', quietStart: '22:00', quietEnd: '07:00' };
  let interests = [
    {
      id: '00000000-0000-4000-8000-000000000003',
      source: 'weather',
      target: 'qa-city',
      label: 'Clima em Campo Grande',
      query: 'Campo Grande',
      delivery: 'digest',
      leadMinutes: 0,
      active: true,
      revision: 1,
      createdAt: new Date().toISOString(),
      errorCode: null,
      snapshot: {
        items: [
          {
            id: 'qa-weather',
            title: 'Tempo em Campo Grande',
            text: 'Céu parcialmente nublado. Mínima de 22 °C e máxima de 31 °C.',
          },
        ],
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        sourceLabel: 'MET Norway',
        sourceUrl: 'https://example.org/weather',
      },
    },
  ];
  await page.route('**/api/v1/customer/radar**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    calls.push(`${request.method()} ${path}`);
    let data;
    if (path.endsWith('/preferences') && request.method() === 'PUT') {
      Object.assign(preferences, request.postDataJSON());
      data = { preferences };
    } else if (request.method() === 'PATCH') {
      const item = interests.find((value) => path.endsWith(value.id));
      Object.assign(item, request.postDataJSON());
      item.revision++;
      data = { interest: item };
    } else if (request.method() === 'DELETE') {
      interests = interests.filter((value) => !path.endsWith(value.id));
      data = { deleted: true };
    } else
      data = {
        catalog: [
          ['weather', 'Clima', 'MET Norway'],
          ['football', 'Futebol', 'openfootball'],
          ['news', 'Notícias', 'Global Voices'],
        ].map(([id, name, provider]) => ({
          id,
          name,
          provider,
          description: 'Acompanhe informações de fontes verificáveis.',
          url: 'https://example.org/',
          license: 'Fonte pública com atribuição',
          hint: 'Escolha um assunto',
          needsSearch: id !== 'news',
          available: true,
        })),
        preferences,
        interests,
        history: [],
        timeZone: 'America/Campo_Grande',
        chatUrl: 'https://wa.me/5599000000001?text=Quero%20configurar%20meu%20Radar',
      };
    return route.fulfill({ json: { success: true, data } });
  });
  await page.route('**/api/v1/customer/investments/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      now = new Date(Date.now() - 60000).toISOString();
    calls.push(`${request.method()} ${path}`);
    if (path.endsWith('/book')) {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        bookWrites.push(structuredClone(body));
        if (holding) {
          holding = false;
          await new Promise((resolve) => {
            releasePut = resolve;
          });
          releasePut = null;
        }
        if (nextBookFailure) {
          const status = nextBookFailure;
          nextBookFailure = null;
          // A real conflict means another device advanced the stored version.
          if (status === 409) storageVersion++;
          return route.fulfill({
            status,
            json: {
              success: false,
              error: {
                code: 'BOOK_CONFLICT',
                message:
                  status === 409
                    ? 'A carteira foi atualizada em outro aparelho. Atualize para continuar.'
                    : 'Não foi possível salvar a carteira agora.',
              },
            },
          });
        }
        if (body.expectedStorageVersion !== storageVersion)
          return route.fulfill({
            status: 409,
            json: {
              success: false,
              error: { code: 'BOOK_CONFLICT', message: 'Conflito de versão da carteira.' },
            },
          });
        if (request.headers()['x-astra-account'] !== 'synthetic-account')
          throw new Error('Investment write omitted its selected customer account.');
        state = E.validateInvestmentState(body.state);
        storageVersion++;
      }
      return route.fulfill({ json: { success: true, data: { state, storageVersion } } });
    }
    let data;
    if (path.endsWith('/status'))
      data = {
        configured: true,
        provider: 'BRAPI',
        version: 'v2',
        maxSymbols: 20,
        maxRequestSymbols: 20,
        planName: 'startup',
        quoteCacheSeconds: 600,
        historyCacheSeconds: 86400,
        metadataCacheSeconds: 3600,
      };
    else if (path.endsWith('/assets'))
      data = {
        items: items.filter(
          (item) =>
            (!url.searchParams.get('kind') ||
              url.searchParams.get('kind') === 'all' ||
              item.kind === url.searchParams.get('kind')) &&
            (!url.searchParams.get('search') ||
              `${item.symbol} ${item.name}`
                .toLocaleLowerCase()
                .includes(url.searchParams.get('search').toLocaleLowerCase()))
        ),
      };
    else if (path.endsWith('/quotes'))
      data = {
        results: (url.searchParams.get('symbols') || '').split(',').map((symbol) => ({
          requestedSymbol: symbol,
          symbol,
          changed: false,
          data: {
            symbol,
            currency: 'BRL',
            regularMarketPrice: options.mode === 'negative' ? '25.00' : '33.00',
            regularMarketChange: options.mode === 'negative' ? '-1.00' : '0.50',
            regularMarketChangePercent: options.mode === 'negative' ? '-3.85' : '1.54',
            regularMarketTime: now,
            logoUrl: `https://icons.brapi.dev/icons/${symbol}.svg`,
          },
        })),
        meta: { fetchedAt: now },
      };
    else if (path.endsWith('/history')) {
      let prices = [];
      for (let days = 32; days >= 0; days--) {
        const date = ago(days),
          weekday = new Date(date + 'T12:00:00Z').getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        const price =
          (options.mode === 'negative' ? 33 - (32 - days) * 0.25 : 29 + (32 - days) * 0.125) +
          Math.sin(days) * 0.25;
        prices.push({
          date: Date.parse(date + 'T03:00:00Z') / 1000,
          rawClose: Number(price.toFixed(2)),
          close: Number(price.toFixed(2)),
          adjustedClose: Number(price.toFixed(2)),
        });
      }
      if (options.historyShape === 'empty') prices = [];
      if (options.historyShape === 'single') prices = prices.slice(-1);
      if (options.historyShape === 'gaps')
        prices = prices.map((point, index) =>
          index === Math.floor(prices.length / 2)
            ? { ...point, rawClose: null, adjustedClose: null }
            : point
        );
      data = {
        ...(url.searchParams.get('basis') === 'adjusted' ? { basis: 'adjusted' } : {}),
        results: (url.searchParams.get('symbols') || '').split(',').map((symbol) => ({
          requestedSymbol: symbol,
          symbol,
          changed: false,
          data: { symbol, currency: 'BRL', usedInterval: '1d', historicalDataPrice: prices },
        })),
        meta: { fetchedAt: now },
      };
    } else throw new Error('Unexpected investment endpoint ' + path);
    return route.fulfill({ json: data });
  });
  return {
    ...api,
    calls,
    blocked,
    bookWrites,
    payouts,
    getBook: () => structuredClone({ state, storageVersion }),
    failBook(status = 503) {
      nextBookFailure = status;
    },
    failPayout() {
      nextPayoutFailure = true;
    },
    holdBook() {
      holding = true;
    },
    releaseBook() {
      releasePut?.();
    },
    pendingBook: () => Boolean(releasePut),
  };
}
