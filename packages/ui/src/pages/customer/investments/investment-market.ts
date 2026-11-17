import { useCallback, useEffect, useRef, useState } from 'react';

/** Reference names for the loading shell. Live asset admission uses the server catalogue. */
export const INVESTMENT_MARKET_CATALOG = [
  { symbol: 'PETR4', name: 'Petrobras PN', kind: 'stock', currency: 'BRL', exchange: 'B3' },
  { symbol: 'VALE3', name: 'Vale ON', kind: 'stock', currency: 'BRL', exchange: 'B3' },
  { symbol: 'ITUB4', name: 'Itaú Unibanco PN', kind: 'stock', currency: 'BRL', exchange: 'B3' },
  { symbol: 'MGLU3', name: 'Magazine Luiza ON', kind: 'stock', currency: 'BRL', exchange: 'B3' },
] as const;
export const MARKET_CACHE_KEY = 'astra-market-observations-v2';
export const MARKET_QUOTE_TTL = 10 * 60 * 1000;
export const MARKET_HISTORY_TTL = 24 * 60 * 60 * 1000;
export type MarketCatalogItem = {
  symbol: string;
  name: string;
  kind: 'stock' | 'etf' | 'fii';
  currency: 'BRL';
  exchange: 'B3';
  provider: 'BRAPI';
  verifiedAt: string;
  automaticEligible: boolean;
  logoUrl?: string | null;
};
export type BrowseAsset = MarketCatalogItem;
export type MarketStatus = {
  configured: boolean;
  provider: 'BRAPI';
  version: 'v2';
  maxSymbols: number;
  maxRequestSymbols?: number;
  planName?: 'free' | 'startup' | 'pro';
  quoteCacheSeconds: number;
  historyCacheSeconds: number;
  metadataCacheSeconds: number;
};
export type MarketQuote = {
  symbol: string;
  price: string;
  change: string | null;
  changePercent: string | null;
  marketTimestamp: string;
  fetchedAt: string;
  currency: 'BRL';
  source: 'BRAPI';
  sourceUrl: string;
  provenance: 'public-evaluation' | 'authenticated-proxy';
  logoUrl?: string | null;
};
export type MarketHistoryPoint = {
  date: string;
  price: string | null;
  source: 'BRAPI';
  fetchedAt: string;
  barTimestamp: string;
  raw: true;
};
export type MarketHistory = {
  symbol: string;
  points: MarketHistoryPoint[];
  fetchedAt: string;
  fromCache: boolean;
  error?: string;
};
/** Chart-only adjusted observations are intentionally incompatible with raw ledger history. */
export type MarketChartHistory = {
  symbol: string;
  points: (Omit<MarketHistoryPoint, 'raw'> & { raw: false })[];
  basis: 'adjusted';
  range: string;
  fetchedAt: string;
  fromCache: boolean;
  error?: string;
  errorCode?: string;
};
export type MarketError = {
  symbol: string;
  code:
    | 'unsupported'
    | 'rate-limit'
    | 'provider'
    | 'network'
    | 'invalid-data'
    | 'timeout'
    | 'not-configured';
  message: string;
};
export type MarketRefreshResult = {
  quotes: MarketQuote[];
  errors: MarketError[];
  fromCache: boolean;
  nextRefreshAt?: string;
};
type PublicCache = {
  version: 1;
  quotes: Record<string, MarketQuote>;
  histories: Record<string, MarketHistory>;
  requests: number[];
};
const blankCache = (): PublicCache => ({ version: 1, quotes: {}, histories: {}, requests: [] });
export const MARKET_API_BASE = import.meta.env.VITE_API_BASE || '';
let memoryCache: PublicCache | undefined;
let queue: Promise<unknown> = Promise.resolve();
let clientCooldownUntil = 0;
let configuredBatchSize = 1;
function marketBatches(symbols: string[]): string[][] {
  const remaining = [...symbols],
    batches: string[][] = [];
  // This public pair was verified to support a single batched request on the current free plan.
  if (configuredBatchSize === 1 && remaining.includes('PETR4') && remaining.includes('VALE3')) {
    batches.push(['PETR4', 'VALE3']);
    remaining.splice(remaining.indexOf('PETR4'), 1);
    remaining.splice(remaining.indexOf('VALE3'), 1);
  }
  for (let i = 0; i < remaining.length; i += configuredBatchSize)
    batches.push(remaining.slice(i, i + configuredBatchSize));
  return batches;
}
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const barClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
export function marketDate(timestamp: string): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) throw new Error('Horário de mercado inválido.');
  const parts = formatter.formatToParts(new Date(time));
  const p = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${p('year')}-${p('month')}-${p('day')}`;
}
export function isPublicMarketSymbol(symbol: string): boolean {
  return INVESTMENT_MARKET_CATALOG.some((item) => item.symbol === symbol);
}
class ProviderError extends Error {
  code: MarketError['code'];
  providerCode?: string;
  constructor(code: MarketError['code'], message: string, providerCode?: string) {
    super(message);
    this.code = code;
    this.providerCode = providerCode;
  }
}
const validMarketSymbol = (symbol: string) => /^[A-Z][A-Z0-9]{2,11}$/.test(symbol);
export function resolveMarketLogoUrl(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || candidate.length > 500) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' &&
      url.hostname === 'icons.brapi.dev' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/icons\/[A-Za-z0-9_.-]+\.(svg|png|webp)$/i.test(url.pathname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function decimalText(value: unknown, positive = false): string {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'number' && !Number.isFinite(value))
  )
    throw new ProviderError('invalid-data', 'O provedor não retornou um preço válido.');
  const text = String(value);
  if (!/^-?\d{1,18}(?:\.\d{1,8})?$/.test(text))
    throw new ProviderError('invalid-data', 'Precisão ou formato de cotação inválido.');
  const negative = text.startsWith('-'),
    magnitude = negative ? text.slice(1) : text,
    [whole = '0', fraction = ''] = magnitude.split('.');
  const units = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  if (positive && (negative || units <= 0n || units > 1_000_000_000n * 100_000_000n))
    throw new ProviderError(
      'invalid-data',
      'O preço de mercado deve ser positivo e estar dentro do limite.'
    );
  const suffix = fraction.replace(/0+$/, '');
  return `${negative && units ? '-' : ''}${BigInt(whole)}${suffix ? `.${suffix}` : ''}`;
}
function optionalDecimal(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return decimalText(value);
}
export function formatMarketChangePercent(value: string | null, hidden = false): string {
  if (hidden) return '•••%';
  if (value === null) return 'Indisponível';
  const normalized = decimalText(value),
    negative = normalized.startsWith('-'),
    [whole = '0', fraction = ''] = (negative ? normalized.slice(1) : normalized).split('.');
  const scaled = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  const cents = scaled / 1_000_000n + (scaled % 1_000_000n >= 500_000n ? 1n : 0n);
  return `${cents ? (negative ? '−' : '+') : ''}${cents / 100n},${(cents % 100n).toString().padStart(2, '0')}%`;
}
function resultFor(payload: unknown, symbol: string): Record<string, unknown> {
  const body = payload as { results?: unknown[] };
  if (!body || !Array.isArray(body.results))
    throw new ProviderError('invalid-data', 'Resposta de mercado incompleta.');
  const matches = body.results.filter(
    (value) =>
      !!value &&
      typeof value === 'object' &&
      (value as { requestedSymbol?: string }).requestedSymbol === symbol
  );
  if (matches.length !== 1)
    throw new ProviderError(
      'invalid-data',
      'O provedor retornou uma identidade ausente ou ambígua para o ativo.'
    );
  const result = matches[0] as
    { requestedSymbol?: string; symbol?: string; changed?: boolean; data?: unknown } | undefined;
  if (
    !result ||
    result.requestedSymbol !== symbol ||
    result.symbol !== symbol ||
    result.changed !== false
  )
    throw new ProviderError(
      'invalid-data',
      'O ativo retornado não corresponde exatamente ao cadastro. Conversões de código exigem revisão.'
    );
  if (!result.data || typeof result.data !== 'object')
    throw new ProviderError('invalid-data', 'O provedor não retornou os dados deste ativo.');
  return result.data as Record<string, unknown>;
}
export function parseBRAPIQuote(
  payload: unknown,
  symbol: string,
  fetchedAt = new Date().toISOString()
): MarketQuote {
  if (!validMarketSymbol(symbol))
    throw new ProviderError('unsupported', 'Código de ativo inválido.');
  const data = resultFor(payload, symbol);
  if (data.currency !== 'BRL')
    throw new ProviderError('invalid-data', 'A cotação retornou uma moeda diferente de BRL.');
  const time = data.regularMarketTime;
  if (
    typeof time !== 'string' ||
    !Number.isFinite(Date.parse(time)) ||
    Date.parse(time) > Date.parse(fetchedAt)
  )
    throw new ProviderError('invalid-data', 'O horário da cotação é ausente ou está no futuro.');
  if (!Number.isFinite(Date.parse(fetchedAt)))
    throw new ProviderError('invalid-data', 'Horário de consulta inválido.');
  return {
    symbol,
    price: decimalText(data.regularMarketPrice, true),
    change: optionalDecimal(data.regularMarketChange),
    changePercent: optionalDecimal(data.regularMarketChangePercent),
    marketTimestamp: new Date(time).toISOString(),
    fetchedAt,
    currency: 'BRL',
    source: 'BRAPI',
    sourceUrl: 'https://brapi.dev/docs/acoes/cotacao',
    provenance: 'authenticated-proxy',
    logoUrl: resolveMarketLogoUrl(data.logoUrl ?? data.logourl) || null,
  };
}
export function parseBRAPIHistory(
  payload: unknown,
  symbol: string,
  fetchedAt = new Date().toISOString()
): MarketHistory {
  if (!validMarketSymbol(symbol))
    throw new ProviderError('unsupported', 'Código de ativo inválido.');
  if (
    (payload as { basis?: unknown })?.basis !== undefined &&
    (payload as { basis?: unknown }).basis !== 'raw'
  )
    throw new ProviderError(
      'invalid-data',
      'Uma série ajustada não pode atualizar os preços da carteira.'
    );
  const data = resultFor(payload, symbol);
  if (data.usedInterval !== '1d' || !Array.isArray(data.historicalDataPrice))
    throw new ProviderError('invalid-data', 'Histórico diário indisponível.');
  if (data.currency !== undefined && data.currency !== 'BRL')
    throw new ProviderError('invalid-data', 'O histórico retornou moeda incompatível.');
  if (data.historicalDataPrice.length > 4000)
    throw new ProviderError('invalid-data', 'Histórico acima da janela permitida.');
  const latestDate = marketDate(fetchedAt),
    dates = new Set<string>();
  const points: MarketHistoryPoint[] = data.historicalDataPrice
    .map((value: unknown) => {
      const row = value as Record<string, unknown>;
      if (!row || typeof row.date !== 'number' || !Number.isSafeInteger(row.date) || row.date <= 0)
        throw new ProviderError('invalid-data', 'Data de histórico inválida.');
      const barTimestamp = new Date(row.date * 1000).toISOString(),
        date = marketDate(barTimestamp);
      if (barClock.format(new Date(barTimestamp)) !== '00:00:00')
        throw new ProviderError(
          'invalid-data',
          'A convenção de data do histórico mudou. Não foi aplicada uma mudança automática de dia.'
        );
      if (date > latestDate || dates.has(date))
        throw new ProviderError('invalid-data', 'Histórico com datas futuras ou repetidas.');
      dates.add(date);
      // adjustedClose and close are deliberately never used as fallback for a missing rawClose.
      const price =
        row.rawClose === null || row.rawClose === undefined
          ? null
          : decimalText(row.rawClose, true);
      return { date, price, source: 'BRAPI' as const, fetchedAt, barTimestamp, raw: true as const };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return { symbol, points, fetchedAt, fromCache: false };
}
function readCache(): PublicCache {
  if (memoryCache) return memoryCache;
  memoryCache = blankCache();
  try {
    if (typeof localStorage === 'undefined') return memoryCache;
    const raw = localStorage.getItem(MARKET_CACHE_KEY);
    if (!raw || raw.length > 4_000_000) return memoryCache;
    const parsed = JSON.parse(raw) as PublicCache;
    if (parsed.version === 1 && parsed.quotes && parsed.histories && Array.isArray(parsed.requests))
      memoryCache = {
        version: 1,
        quotes: parsed.quotes,
        histories: parsed.histories,
        requests: parsed.requests.filter((value) => Number.isFinite(value)),
      };
  } catch {
    /* A public cache failure must not affect the private ledger. */
  }
  return memoryCache;
}
function writeCache() {
  try {
    const cache = readCache();
    let payload = JSON.stringify(cache);
    while (payload.length > 4_000_000 && Object.keys(cache.histories).length) {
      const oldest = Object.entries(cache.histories).sort((a, b) =>
        a[1].fetchedAt.localeCompare(b[1].fetchedAt)
      )[0]![0];
      delete cache.histories[oldest];
      payload = JSON.stringify(cache);
    }
    if (typeof localStorage !== 'undefined') localStorage.setItem(MARKET_CACHE_KEY, payload);
  } catch {
    /* Memory cache remains available. */
  }
}
function validCachedQuote(value: unknown, symbol: string): value is MarketQuote {
  try {
    const q = value as MarketQuote;
    if (
      q.symbol !== symbol ||
      q.currency !== 'BRL' ||
      q.source !== 'BRAPI' ||
      !['public-evaluation', 'authenticated-proxy'].includes(q.provenance) ||
      !Number.isFinite(Date.parse(q.fetchedAt)) ||
      Date.parse(q.fetchedAt) > Date.now() ||
      !Number.isFinite(Date.parse(q.marketTimestamp)) ||
      Date.parse(q.marketTimestamp) > Date.parse(q.fetchedAt)
    )
      return false;
    decimalText(q.price, true);
    return true;
  } catch {
    return false;
  }
}
function validCachedHistory(value: unknown, symbol: string): value is MarketHistory {
  try {
    const h = value as MarketHistory;
    if (
      h.symbol !== symbol ||
      !Number.isFinite(Date.parse(h.fetchedAt)) ||
      Date.parse(h.fetchedAt) > Date.now() ||
      !Array.isArray(h.points) ||
      h.points.length > 4000
    )
      return false;
    const dates = new Set<string>();
    return h.points.every((point) => {
      if (dates.has(point.date)) return false;
      dates.add(point.date);
      return (
        point.raw === true &&
        point.source === 'BRAPI' &&
        point.fetchedAt === h.fetchedAt &&
        point.date <= marketDate(h.fetchedAt) &&
        point.date === marketDate(point.barTimestamp) &&
        barClock.format(new Date(point.barTimestamp)) === '00:00:00' &&
        (point.price === null || !!decimalText(point.price, true))
      );
    });
  } catch {
    return false;
  }
}
export function readCachedMarketQuotes(symbols: string[]): Record<string, MarketQuote> {
  const result: Record<string, MarketQuote> = {},
    cache = readCache();
  for (const symbol of symbols)
    if (validMarketSymbol(symbol) && validCachedQuote(cache.quotes[symbol], symbol))
      result[symbol] = cache.quotes[symbol];
  return result;
}
function abortError() {
  return new DOMException('Consulta interrompida.', 'AbortError');
}
async function requestJSON(url: string, signal?: AbortSignal): Promise<unknown> {
  const task = async () => {
    if (signal?.aborted) throw abortError();
    if (clientCooldownUntil > Date.now())
      throw new ProviderError(
        'rate-limit',
        'O provedor pediu uma pausa. Aguarde antes de consultar novamente.'
      );
    const cache = readCache(),
      now = Date.now();
    cache.requests = cache.requests.filter((time) => time > now - 60_000 && time <= now);
    // Local status and server-cache hits do not consume provider calls. Only an actual
    // provider 429 establishes a cooldown; a fixed browser counter hid valid assets.
    cache.requests.push(now);
    writeCache();
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12_000);
    try {
      const response = await fetch(`${MARKET_API_BASE}${url}`, {
        signal: controller.signal,
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) {
        let detail: { error?: { code?: string; message?: string; retryAfterSeconds?: number } } =
          {};
        try {
          detail = await response.json();
        } catch {
          /* Safe generic error remains. */
        }
        if (response.status === 429) {
          const header = response.headers.get('Retry-After');
          const seconds =
            header && /^\d+$/.test(header)
              ? Number(header)
              : header
                ? Math.max(1, Math.ceil((Date.parse(header) - Date.now()) / 1000))
                : detail.error?.retryAfterSeconds || 60;
          const valid =
            Number.isSafeInteger(seconds) &&
            seconds <= Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 1000);
          clientCooldownUntil = Date.now() + (valid ? Math.max(1, seconds) : 60) * 1000;
        }
        throw new ProviderError(
          response.status === 429
            ? 'rate-limit'
            : detail.error?.code === 'PROVIDER_NOT_CONFIGURED'
              ? 'not-configured'
              : 'provider',
          detail.error?.message?.slice(0, 320) ||
            `O provedor não disponibilizou esta consulta (HTTP ${response.status}).`,
          detail.error?.code
        );
      }
      const text = await response.text();
      if (text.length > 2_500_000)
        throw new ProviderError('invalid-data', 'Resposta de mercado acima do limite.');
      // Keep the provider's financial number lexemes as decimal strings before JSON number parsing.
      const exact = text.replace(
        /(?<!\\)"(regularMarketPrice|regularMarketChange|regularMarketChangePercent|rawClose|adjustedClose|close)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/g,
        (_match, key: string, amount: string) => `"${key}":"${amount}"`
      );
      try {
        return JSON.parse(exact);
      } catch {
        throw new ProviderError('invalid-data', 'O provedor retornou uma resposta inválida.');
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut)
        throw new ProviderError(
          'timeout',
          'A consulta demorou mais que o esperado. A última informação foi mantida.'
        );
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'network',
        'Não foi possível consultar o mercado. Verifique a conexão; o último preço conhecido foi mantido.'
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}
export async function refreshMarketQuotes(
  symbols: string[],
  options: { signal?: AbortSignal; force?: boolean } = {}
): Promise<MarketRefreshResult> {
  const cache = readCache(),
    quotes: MarketQuote[] = [],
    errors: MarketError[] = [],
    needed: string[] = [];
  let fromCache = true;
  for (const symbol of [...new Set(symbols)]) {
    if (options.signal?.aborted) throw abortError();
    if (!validMarketSymbol(symbol)) {
      errors.push({ symbol, code: 'unsupported', message: 'Código de ativo inválido.' });
      continue;
    }
    const previous = validCachedQuote(cache.quotes[symbol], symbol)
      ? cache.quotes[symbol]
      : undefined;
    const age = previous ? Date.now() - Date.parse(previous.fetchedAt) : Infinity;
    // Automatic refresh caches for ten minutes. Manual refresh still waits a minute.
    if (
      previous &&
      previous.logoUrl !== undefined &&
      age < (options.force ? 60_000 : MARKET_QUOTE_TTL)
    )
      quotes.push(previous);
    else needed.push(symbol);
  }
  for (const batch of marketBatches(needed)) {
    let payload: unknown;
    try {
      fromCache = false;
      payload = await requestJSON(
        `/api/v1/customer/investments/market/quotes?symbols=${encodeURIComponent(batch.join(','))}`,
        options.signal
      );
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      for (const symbol of batch) {
        errors.push({
          symbol,
          code: (error as ProviderError).code || 'provider',
          message: (error as Error).message,
        });
        if (validCachedQuote(cache.quotes[symbol], symbol)) quotes.push(cache.quotes[symbol]);
      }
      continue;
    }
    for (const symbol of batch)
      try {
        const fetchedAt =
            (payload as { meta?: { fetchedAt?: string } }).meta?.fetchedAt ||
            new Date().toISOString(),
          quote = parseBRAPIQuote(payload, symbol, fetchedAt),
          previous = validCachedQuote(cache.quotes[symbol], symbol)
            ? cache.quotes[symbol]
            : undefined;
        if (previous && Date.parse(quote.marketTimestamp) < Date.parse(previous.marketTimestamp))
          throw new ProviderError(
            'invalid-data',
            'Uma observação anterior não substituiu o último preço conhecido.'
          );
        cache.quotes[symbol] = quote;
        quotes.push(quote);
      } catch (error) {
        errors.push({
          symbol,
          code: (error as ProviderError).code || 'provider',
          message: (error as Error).message,
        });
        if (validCachedQuote(cache.quotes[symbol], symbol)) quotes.push(cache.quotes[symbol]);
      }
    writeCache();
  }
  return {
    quotes,
    errors,
    fromCache,
    nextRefreshAt: quotes.length
      ? new Date(
          Math.min(...quotes.map((q) => Date.parse(q.fetchedAt))) + MARKET_QUOTE_TTL
        ).toISOString()
      : undefined,
  };
}
export async function fetchMarketHistories(
  symbols: string[],
  options: { signal?: AbortSignal; range?: string } = {}
): Promise<Record<string, MarketHistory>> {
  const range = options.range || '3mo';
  if (!['1mo', '3mo', '6mo', '1y', '2y', '5y'].includes(range))
    throw new ProviderError('unsupported', 'Janela histórica não permitida.');
  const cache = readCache(),
    result: Record<string, MarketHistory> = {},
    needed: string[] = [];
  for (const symbol of [...new Set(symbols)]) {
    const key = `${symbol}|${range}`,
      previous = validCachedHistory(cache.histories[key], symbol)
        ? cache.histories[key]
        : undefined;
    if (!validMarketSymbol(symbol))
      result[symbol] = {
        symbol,
        points: [],
        fetchedAt: new Date().toISOString(),
        fromCache: false,
        error: 'Código de ativo inválido.',
      };
    else if (previous && Date.now() - Date.parse(previous.fetchedAt) < MARKET_HISTORY_TTL)
      result[symbol] = { ...previous, fromCache: true };
    else needed.push(symbol);
  }
  for (const batch of marketBatches(needed)) {
    let payload: unknown;
    try {
      payload = await requestJSON(
        `/api/v1/customer/investments/market/history?symbols=${encodeURIComponent(batch.join(','))}&range=${range}`,
        options.signal
      );
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      for (const symbol of batch) {
        const key = `${symbol}|${range}`,
          previous = validCachedHistory(cache.histories[key], symbol)
            ? cache.histories[key]
            : undefined;
        result[symbol] = {
          ...(previous || { symbol, points: [], fetchedAt: new Date().toISOString() }),
          fromCache: !!previous,
          error: (error as Error).message,
        };
      }
      continue;
    }
    for (const symbol of batch)
      try {
        const fetchedAt =
            (payload as { meta?: { fetchedAt?: string } }).meta?.fetchedAt ||
            new Date().toISOString(),
          history = parseBRAPIHistory(payload, symbol, fetchedAt);
        cache.histories[`${symbol}|${range}`] = history;
        result[symbol] = history;
      } catch (error) {
        const previous = cache.histories[`${symbol}|${range}`];
        result[symbol] = {
          ...(previous || { symbol, points: [], fetchedAt: new Date().toISOString() }),
          fromCache: !!previous,
          error: (error as Error).message,
        };
      }
    writeCache();
  }
  return result;
}
export async function fetchMarketHistory(
  symbol: string,
  options: { signal?: AbortSignal; force?: boolean; range?: string } = {}
): Promise<MarketHistory> {
  const history = (await fetchMarketHistories([symbol], options))[symbol];
  if (!history) throw new ProviderError('invalid-data', 'Histórico indisponível para este ativo.');
  return history;
}

const chartRanges = ['1mo', '3mo', '6mo', '1y', '2y', '5y', 'max'];
const chartHistoryCache = new Map<string, MarketChartHistory>();
export function parseBRAPIChartHistory(
  payload: unknown,
  symbol: string,
  range = '3mo',
  fetchedAt = new Date().toISOString()
): MarketChartHistory {
  if (!validMarketSymbol(symbol) || !chartRanges.includes(range))
    throw new ProviderError('unsupported', 'Ativo ou período de gráfico inválido.');
  if ((payload as { basis?: unknown })?.basis !== 'adjusted')
    throw new ProviderError('invalid-data', 'A origem ajustada do gráfico não foi confirmada.');
  const data = resultFor(payload, symbol);
  if (
    data.usedInterval !== '1d' ||
    !Array.isArray(data.historicalDataPrice) ||
    data.historicalDataPrice.length > 20000
  )
    throw new ProviderError(
      'invalid-data',
      'Série diária do gráfico indisponível ou acima do limite.'
    );
  if (data.currency !== undefined && data.currency !== 'BRL')
    throw new ProviderError('invalid-data', 'O histórico retornou moeda incompatível.');
  const latestDate = marketDate(fetchedAt),
    dates = new Set<string>();
  const points: MarketChartHistory['points'] = data.historicalDataPrice
    .map((value: unknown) => {
      const row = value as Record<string, unknown>;
      if (!row || typeof row.date !== 'number' || !Number.isSafeInteger(row.date) || row.date <= 0)
        throw new ProviderError('invalid-data', 'Data de gráfico inválida.');
      const barTimestamp = new Date(row.date * 1000).toISOString(),
        date = marketDate(barTimestamp);
      if (
        barClock.format(new Date(barTimestamp)) !== '00:00:00' ||
        date > latestDate ||
        dates.has(date)
      )
        throw new ProviderError(
          'invalid-data',
          'O gráfico retornou datas ambíguas, futuras ou repetidas.'
        );
      dates.add(date);
      // This series is a market chart reference only. It never enters the ledger,
      // never falls back to raw/close and never changes the price of an operation.
      const price =
        row.adjustedClose === null || row.adjustedClose === undefined
          ? null
          : decimalText(row.adjustedClose, true);
      return {
        date,
        price,
        source: 'BRAPI' as const,
        fetchedAt,
        barTimestamp,
        raw: false as const,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    symbol,
    points,
    basis: 'adjusted',
    range: typeof data.usedRange === 'string' ? data.usedRange : range,
    fetchedAt,
    fromCache: false,
  };
}
export async function fetchMarketChartHistory(
  symbol: string,
  options: { signal?: AbortSignal; force?: boolean; range?: string } = {}
): Promise<MarketChartHistory> {
  const range = options.range || '3mo',
    key = `${symbol}|${range}`,
    previous = chartHistoryCache.get(key);
  if (!validMarketSymbol(symbol) || !chartRanges.includes(range))
    return {
      symbol,
      points: [],
      basis: 'adjusted',
      range,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      error: 'Ativo ou período de gráfico inválido.',
      errorCode: 'INVALID_REQUEST',
    };
  if (
    previous &&
    Date.now() - Date.parse(previous.fetchedAt) < (options.force ? 60000 : MARKET_HISTORY_TTL)
  )
    return { ...previous, fromCache: true };
  try {
    const payload = await requestJSON(
      `/api/v1/customer/investments/market/history?symbols=${encodeURIComponent(symbol)}&range=${range}&basis=adjusted`,
      options.signal
    );
    const fetchedAt =
        (payload as { meta?: { fetchedAt?: string } }).meta?.fetchedAt || new Date().toISOString(),
      history = parseBRAPIChartHistory(payload, symbol, range, fetchedAt);
    chartHistoryCache.delete(key);
    chartHistoryCache.set(key, history);
    while (chartHistoryCache.size > 6)
      chartHistoryCache.delete(chartHistoryCache.keys().next().value!);
    return history;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return {
      ...(previous || {
        symbol,
        points: [],
        basis: 'adjusted' as const,
        range,
        fetchedAt: new Date().toISOString(),
      }),
      fromCache: !!previous,
      error: (error as Error).message,
      errorCode:
        (error as ProviderError).providerCode || (error as ProviderError).code || 'PROVIDER_ERROR',
    };
  }
}
export function useInvestmentMarketChartHistory(symbol?: string, enabled = true, range = '3mo') {
  const [history, setHistory] = useState<MarketChartHistory | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string>(),
    [errorCode, setErrorCode] = useState<string>(),
    runRef = useRef<(force?: boolean) => void>(() => {});
  useEffect(() => {
    let alive = true,
      active: AbortController | undefined;
    setHistory(null);
    setError(undefined);
    setErrorCode(undefined);
    setLoading(false);
    const run = async (force = false) => {
      if (!symbol || !enabled || document.visibilityState === 'hidden' || active) return;
      const controller = new AbortController();
      active = controller;
      setLoading(true);
      try {
        const result = await fetchMarketChartHistory(symbol, {
          signal: controller.signal,
          range,
          force,
        });
        if (alive) {
          setHistory(result);
          setError(result.error);
          setErrorCode(result.errorCode);
        }
      } catch (e) {
        if (alive && (e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        if (active === controller) active = undefined;
        if (alive) setLoading(false);
      }
    };
    runRef.current = (force) => {
      void run(force);
    };
    void run();
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        active?.abort();
        active = undefined;
        setLoading(false);
      } else void run();
    };
    const focus = () => {
      void run();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', focus);
    return () => {
      alive = false;
      active?.abort();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', focus);
    };
  }, [symbol, enabled, range]);
  return {
    history,
    loading,
    error,
    errorCode,
    refresh: useCallback(() => runRef.current(true), []),
  };
}

export function useInvestmentMarket(symbols: string[], enabled = true) {
  const key = [...new Set(symbols)].sort().join(','),
    active = useRef<AbortController | null>(null),
    runRef = useRef<(force?: boolean) => void>(() => {});
  const [quotes, setQuotes] = useState<Record<string, MarketQuote>>(() =>
      readCachedMarketQuotes(key.split(',').filter(Boolean))
    ),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [loading, setLoading] = useState(false),
    [lastRefreshAt, setLastRefreshAt] = useState<string>();
  useEffect(() => {
    let alive = true;
    const list = key.split(',').filter(Boolean);
    setLoading(false);
    const run = async (force = false) => {
      if (!enabled || !list.length || document.visibilityState === 'hidden' || active.current)
        return;
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      try {
        const result = await refreshMarketQuotes(list, { signal: controller.signal, force });
        if (!alive) return;
        setQuotes(Object.fromEntries(result.quotes.map((q) => [q.symbol, q])));
        setErrors(Object.fromEntries(result.errors.map((e) => [e.symbol, e.message])));
        setLastRefreshAt(new Date().toISOString());
      } catch (error) {
        if (alive && (error as Error).name !== 'AbortError')
          setErrors(Object.fromEntries(list.map((symbol) => [symbol, (error as Error).message])));
      } finally {
        if (active.current === controller) active.current = null;
        if (alive) setLoading(false);
      }
    };
    runRef.current = (force) => {
      void run(force);
    };
    void run();
    const interval = window.setInterval(() => {
      void run();
    }, MARKET_QUOTE_TTL);
    const visible = () => {
      if (document.visibilityState === 'hidden') {
        active.current?.abort();
        active.current = null;
        setLoading(false);
      } else void run();
    };
    const focus = () => {
      void run();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', focus);
    return () => {
      alive = false;
      active.current?.abort();
      active.current = null;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', focus);
    };
  }, [key, enabled]);
  const refresh = useCallback(() => runRef.current(true), []);
  return { quotes, errors, loading, refresh, lastRefreshAt };
}
export function useInvestmentMarketHistory(symbol?: string, enabled = true) {
  const [history, setHistory] = useState<MarketHistory | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string>(),
    active = useRef<AbortController | null>(null),
    runRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    setHistory(null);
    setError(undefined);
    setLoading(false);
    const run = async () => {
      if (!symbol || !enabled || document.visibilityState === 'hidden' || active.current) return;
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      try {
        const result = await fetchMarketHistory(symbol, { signal: controller.signal });
        if (alive) {
          setHistory(result);
          setError(result.error);
        }
      } catch (e) {
        if (alive && (e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        if (active.current === controller) active.current = null;
        if (alive) setLoading(false);
      }
    };
    runRef.current = () => {
      void run();
    };
    void run();
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        active.current?.abort();
        active.current = null;
        setLoading(false);
      } else void run();
    };
    const focus = () => {
      void run();
    };
    const interval = window.setInterval(() => {
      void run();
    }, MARKET_HISTORY_TTL);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', focus);
    return () => {
      alive = false;
      active.current?.abort();
      active.current = null;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', focus);
    };
  }, [symbol, enabled]);
  const refresh = useCallback(() => runRef.current(), []);
  return { history, loading, error, refresh };
}
export function useInvestmentMarketHistories(symbols: string[], enabled = true, range = '3mo') {
  const key = [...new Set(symbols)].sort().join(','),
    [histories, setHistories] = useState<Record<string, MarketHistory>>({}),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string>(),
    runRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true,
      active: AbortController | undefined;
    setLoading(false);
    setError(undefined);
    setHistories({});
    const list = key.split(',').filter(Boolean);
    const run = async () => {
      if (!enabled || !list.length || active || document.visibilityState === 'hidden') return;
      const controller = new AbortController();
      active = controller;
      setLoading(true);
      try {
        const result = await fetchMarketHistories(list, { signal: controller.signal, range });
        if (alive) {
          setHistories(result);
          setError(Object.values(result).find((h) => h.error)?.error);
        }
      } catch (e) {
        if (alive && (e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        if (active === controller) active = undefined;
        if (alive) setLoading(false);
      }
    };
    runRef.current = () => {
      void run();
    };
    void run();
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        active?.abort();
        active = undefined;
        setLoading(false);
      } else void run();
    };
    const focus = () => {
        void run();
      },
      interval = window.setInterval(() => {
        void run();
      }, MARKET_HISTORY_TTL);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', focus);
    return () => {
      alive = false;
      active?.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', focus);
    };
  }, [key, enabled, range]);
  return { histories, loading, error, refresh: useCallback(() => runRef.current(), []) };
}
const searchCache = new Map<string, { items: MarketCatalogItem[]; time: number }>();
export async function fetchMarketAssets(
  query: string,
  kind: 'all' | 'stock' | 'etf' | 'fii' = 'all',
  signal?: AbortSignal
): Promise<MarketCatalogItem[]> {
  const search = query.trim();
  if (search.length > 80)
    throw new ProviderError('unsupported', 'A busca deve ter até 80 caracteres.');
  const key = `${kind}|${search.toUpperCase()}`,
    previous = searchCache.get(key);
  if (previous && Date.now() - previous.time < 3600000) return previous.items;
  const payload = (await requestJSON(
    `/api/v1/customer/investments/market/assets?search=${encodeURIComponent(search)}&kind=${kind}`,
    signal
  )) as { items?: unknown[] };
  if (!Array.isArray(payload.items))
    throw new ProviderError('invalid-data', 'Catálogo de ativos indisponível.');
  const items: MarketCatalogItem[] = [],
    seen = new Set<string>();
  for (const value of payload.items) {
    const item = value as MarketCatalogItem;
    if (
      !item ||
      !validMarketSymbol(item.symbol) ||
      seen.has(item.symbol) ||
      typeof item.name !== 'string' ||
      !item.name ||
      item.name.length > 160 ||
      !['stock', 'etf', 'fii'].includes(item.kind) ||
      (kind !== 'all' && item.kind !== kind) ||
      item.currency !== 'BRL' ||
      item.exchange !== 'B3' ||
      item.provider !== 'BRAPI' ||
      item.automaticEligible !== true ||
      !Number.isFinite(Date.parse(item.verifiedAt)) ||
      Date.parse(item.verifiedAt) > Date.now()
    )
      continue;
    seen.add(item.symbol);
    items.push(item);
  }
  const safeItems = items.map((item) => ({ ...item, logoUrl: resolveMarketLogoUrl(item.logoUrl) }));
  searchCache.set(key, { items: safeItems, time: Date.now() });
  if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value!);
  return safeItems;
}
export function useInvestmentMarketSearch(
  query: string,
  kind: 'all' | 'stock' | 'etf' | 'fii' = 'all',
  enabled = true
) {
  const [items, setItems] = useState<MarketCatalogItem[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setError(undefined);
    if (!enabled || query.trim().length === 1) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(
      async () => {
        try {
          const result = await fetchMarketAssets(query, kind, controller.signal);
          if (alive) setItems(result);
        } catch (e) {
          if (alive && (e as Error).name !== 'AbortError') {
            setItems([]);
            setError((e as Error).message);
          }
        } finally {
          if (alive) setLoading(false);
        }
      },
      query.trim() ? 350 : 0
    );
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, kind, enabled]);
  return { items, loading, error };
}
export async function fetchMarketStatus(signal?: AbortSignal): Promise<MarketStatus> {
  const value = (await requestJSON(
    '/api/v1/customer/investments/market/status',
    signal
  )) as MarketStatus;
  if (
    !value ||
    typeof value.configured !== 'boolean' ||
    value.provider !== 'BRAPI' ||
    value.version !== 'v2' ||
    !Number.isSafeInteger(value.maxSymbols) ||
    value.maxSymbols < 1 ||
    value.maxSymbols > 20
  )
    throw new ProviderError('invalid-data', 'Status da fonte de mercado inválido.');
  configuredBatchSize = value.maxSymbols;
  return value;
}
export function useInvestmentMarketStatus(enabled = true) {
  const [status, setStatus] = useState<MarketStatus | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string>(),
    runRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const run = async () => {
      if (!enabled) return;
      setLoading(true);
      setError(undefined);
      try {
        const value = await fetchMarketStatus(controller.signal);
        if (alive) setStatus(value);
      } catch (e) {
        if (alive && (e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    runRef.current = () => {
      void run();
    };
    void run();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [enabled]);
  return { status, loading, error, refresh: useCallback(() => runRef.current(), []) };
}
/** Isolated tests can clear module cache without touching private portfolio storage. */
export function resetInvestmentMarketCache() {
  memoryCache = blankCache();
  queue = Promise.resolve();
  clientCooldownUntil = 0;
  configuredBatchSize = 1;
  searchCache.clear();
  chartHistoryCache.clear();
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(MARKET_CACHE_KEY);
  } catch {
    /* Public cache only. */
  }
}
