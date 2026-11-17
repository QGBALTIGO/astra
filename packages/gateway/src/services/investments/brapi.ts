/** Same-origin public market data. The credential never leaves the server/provider boundary. */
type Data = Record<string, unknown>;
type ProviderResult = { body?: unknown; response?: Response };
type MarketEnvironment = {
  BRAPI_TOKEN?: string;
  BRAPI_MAX_SYMBOLS?: string;
  BRAPI_PLAN_NAME?: string;
};
type HandlerOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  quoteTtlMs?: number;
  historyTtlMs?: number;
  metadataTtlMs?: number;
};
const object = (value: unknown): Data | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : null;
const validSymbol = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z][A-Z0-9]{2,11}$/.test(value);
const MAX_SYMBOLS = 20;
const MAX_UPSTREAM_BYTES = 2_500_000;
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
const failure = (status: number, code: string, message: string, retryAfterSeconds?: number) =>
  json({ error: { code, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } }, status, {
    ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
    ...(status === 405 ? { Allow: 'GET' } : {}),
  });
const safeText = (value: unknown, token: string, max = 240): string | null =>
  typeof value === 'string' ? value.split(token).join('[redigido]').slice(0, max) : null;
function safeLogo(value: unknown, token: string): string | null {
  if (typeof value !== 'string' || value.length > 500 || value.includes(token)) return null;
  try {
    const image = new URL(value);
    return image.protocol === 'https:' &&
      image.hostname === 'icons.brapi.dev' &&
      !image.username &&
      !image.password &&
      !image.port &&
      !image.search &&
      !image.hash &&
      /^\/icons\/[A-Za-z0-9_.-]+\.(svg|png|webp)$/.test(image.pathname)
      ? image.toString()
      : null;
  } catch {
    return null;
  }
}
function exactFinancialJSON(text: string): unknown {
  return JSON.parse(
    text.replace(
      /(?<!\\)"(regularMarketPrice|regularMarketChange|regularMarketChangePercent|rawClose|adjustedClose|close)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/g,
      (_match, key: string, amount: string) => `"${key}":"${amount}"`
    )
  );
}
const nullableDecimal = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : typeof value === 'string' && /^-?\d{1,18}(?:\.\d{1,8})?$/.test(value)
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : null;

async function providerText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > MAX_UPSTREAM_BYTES) throw new Error('Provider response limit');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0,
    text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_BYTES) {
        await reader.cancel();
        throw new Error('Provider response limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function normalizeSeries(
  body: unknown,
  wanted: string[],
  kind: string,
  token: string,
  fetchedAt: string,
  basis: string
): Data {
  const envelope = object(body);
  if (!envelope || !Array.isArray(envelope.results) || envelope.results.length > MAX_SYMBOLS * 2)
    throw new Error('Invalid provider series');
  const results = envelope.results
    .map(object)
    .filter(
      (row): row is Data =>
        !!row && typeof row.requestedSymbol === 'string' && wanted.includes(row.requestedSymbol)
    )
    .map((row) => {
      const identity = {
        requestedSymbol: safeText(row.requestedSymbol, token, 20),
        symbol: safeText(row.symbol, token, 20),
        changed: typeof row.changed === 'boolean' ? row.changed : null,
      };
      const data = object(row.data);
      if (!data) return { ...identity, data: null };
      if (kind === 'quotes')
        return {
          ...identity,
          data: {
            currency: data.currency === 'BRL' ? 'BRL' : safeText(data.currency, token, 8),
            regularMarketPrice: nullableDecimal(data.regularMarketPrice),
            regularMarketChange: nullableDecimal(data.regularMarketChange),
            regularMarketChangePercent: nullableDecimal(data.regularMarketChangePercent),
            regularMarketTime: safeText(data.regularMarketTime, token, 40),
            shortName: safeText(data.shortName, token),
            longName: safeText(data.longName, token),
            logoUrl: safeLogo(data.logoUrl, token) || safeLogo(data.logourl, token),
          },
        };
      if (
        !Array.isArray(data.historicalDataPrice) ||
        data.historicalDataPrice.length > (basis === 'adjusted' ? 20_000 : 4_000)
      )
        throw new Error('Invalid historical series');
      return {
        ...identity,
        data: {
          usedInterval: safeText(data.usedInterval, token, 20),
          usedRange: safeText(data.usedRange, token, 20),
          historicalDataPrice: data.historicalDataPrice.map((raw) => {
            const point = object(raw);
            return {
              date: Number.isSafeInteger(point?.date) ? point?.date : null,
              rawClose: nullableDecimal(point?.rawClose),
              adjustedClose: nullableDecimal(point?.adjustedClose),
              close: nullableDecimal(point?.close),
            };
          }),
        },
      };
    });
  return { results, requestedAt: safeText(envelope.requestedAt, token, 40) || fetchedAt };
}

function normalizeAssets(
  body: unknown,
  token: string,
  fetchedAt: string,
  selectedKind: string
): Data {
  const envelope = object(body);
  if (!envelope || !Array.isArray(envelope.results) || envelope.results.length > 2000)
    throw new Error('Invalid catalogue');
  const items: Data[] = [],
    seen = new Set<string>();
  for (const raw of envelope.results) {
    const row = object(raw);
    if (
      !row ||
      !validSymbol(row.symbol) ||
      seen.has(row.symbol) ||
      row.exchange !== 'B3' ||
      row.currency !== 'BRL' ||
      row.isActive !== true ||
      !['stock', 'etf', 'fii'].includes(String(row.subType)) ||
      (selectedKind !== 'all' && row.subType !== selectedKind)
    )
      continue;
    if (row.subType === 'stock' ? row.assetType !== 'stock' : row.assetType !== 'fund') continue;
    const name = safeText(row.name || row.longName, token, 160);
    if (!name) continue;
    seen.add(row.symbol);
    items.push({
      symbol: row.symbol,
      name,
      kind: row.subType,
      currency: 'BRL',
      exchange: 'B3',
      provider: 'BRAPI',
      verifiedAt: fetchedAt,
      automaticEligible: true,
      logoUrl: safeLogo(row.logoUrl, token),
    });
  }
  const pagination = object(envelope.pagination);
  return {
    items,
    fetchedAt,
    total: Number.isSafeInteger(pagination?.totalCount) ? pagination?.totalCount : items.length,
  };
}

export function createBrAPIHandler({
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = 12_000,
  quoteTtlMs = 600_000,
  historyTtlMs = 86_400_000,
  metadataTtlMs = 3_600_000,
}: HandlerOptions = {}) {
  const cache = new Map<string, { storedAt: number; body: Data; bytes: number }>(),
    inFlight = new Map<string, Promise<Response>>();
  let activeCredential = '',
    cooldownUntil = 0,
    cachedBytes = 0,
    queue: Promise<unknown> = Promise.resolve();
  function retryDelay(header: string | null): number {
    if (header && /^\d+$/.test(header.trim())) {
      const seconds = Number(header);
      if (
        Number.isSafeInteger(seconds) &&
        seconds <= Math.floor((Number.MAX_SAFE_INTEGER - now()) / 1000)
      )
        return Math.max(1, seconds);
    }
    const ms = header ? Date.parse(header) - now() : NaN;
    return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 60;
  }
  const messages: Record<number, string> = {
    400: 'A consulta não foi aceita pelo plano. Revise os ativos e os limites da conta.',
    401: 'A chave do provedor não foi aceita. Revise a configuração segura no servidor.',
    403: 'O plano do provedor não permite este recurso.',
    404: 'O provedor não encontrou dados para os ativos solicitados.',
    429: 'O provedor limitou as consultas. Aguarde o período indicado antes de atualizar.',
  };
  async function performUpstream(
    path: string,
    params: Record<string, string>,
    token: string,
    signal: AbortSignal
  ): Promise<ProviderResult> {
    if (activeCredential !== token)
      return {
        response: failure(
          409,
          'CONFIGURATION_CHANGED',
          'A configuração do provedor mudou. Atualize a consulta.'
        ),
      };
    const pending = Math.ceil((cooldownUntil - now()) / 1000);
    if (pending > 0) return { response: failure(429, 'RATE_LIMITED', messages[429]!, pending) };
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal.aborted)
      return { response: failure(499, 'REQUEST_ABORTED', 'Consulta interrompida.') };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const url = new URL(`https://brapi.dev${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = [400, 401, 403, 404, 429].includes(response.status) ? response.status : 502;
        const delay = status === 429 ? retryDelay(response.headers.get('Retry-After')) : undefined;
        if (delay) cooldownUntil = Math.max(cooldownUntil, now() + delay * 1000);
        return {
          response: failure(
            status,
            status === 429
              ? 'RATE_LIMITED'
              : status === 401
                ? 'INVALID_CREDENTIAL'
                : status === 403
                  ? 'PLAN_RESTRICTED'
                  : status === 404
                    ? 'NOT_FOUND'
                    : 'PROVIDER_ERROR',
            messages[status] || 'O provedor está indisponível. A última informação foi mantida.',
            delay
          ),
        };
      }
      try {
        return { body: exactFinancialJSON(await providerText(response)) };
      } catch {
        return {
          response: failure(
            502,
            'INVALID_PROVIDER_DATA',
            'O provedor retornou um documento inválido ou acima do limite.'
          ),
        };
      }
    } catch {
      return {
        response: failure(
          signal.aborted ? 499 : timedOut ? 504 : 502,
          signal.aborted
            ? 'REQUEST_ABORTED'
            : timedOut
              ? 'PROVIDER_TIMEOUT'
              : 'PROVIDER_UNAVAILABLE',
          signal.aborted
            ? 'Consulta interrompida.'
            : timedOut
              ? 'A consulta ao provedor excedeu o tempo esperado.'
              : 'Não foi possível consultar o provedor. A última informação foi mantida.'
        ),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  function upstream(
    path: string,
    params: Record<string, string>,
    token: string,
    signal: AbortSignal
  ): Promise<ProviderResult> {
    const task = () => performUpstream(path, params, token, signal);
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }
  return async function handle(request: Request, env: MarketEnvironment = {}): Promise<Response> {
    const url = new URL(request.url);
    if (
      ![
        '/api/market/status',
        '/api/market/quotes',
        '/api/market/history',
        '/api/market/assets',
      ].includes(url.pathname)
    )
      return failure(404, 'NOT_FOUND', 'Recurso de mercado não encontrado.');
    if (request.method !== 'GET')
      return failure(405, 'METHOD_NOT_ALLOWED', 'Este recurso aceita somente consultas GET.');
    const token = typeof env.BRAPI_TOKEN === 'string' ? env.BRAPI_TOKEN.trim() : '';
    if (url.pathname.endsWith('/status')) {
      if ([...url.searchParams].length)
        return failure(400, 'INVALID_REQUEST', 'Esta consulta não aceita parâmetros.');
      const declared = Number(env.BRAPI_MAX_SYMBOLS),
        planBatchSize =
          Number.isSafeInteger(declared) && declared >= 1 && declared <= MAX_SYMBOLS ? declared : 1;
      const planName = ['free', 'startup', 'pro'].includes(env.BRAPI_PLAN_NAME || '')
        ? env.BRAPI_PLAN_NAME
        : undefined;
      return json({
        configured: !!token,
        provider: 'BRAPI',
        version: 'v2',
        maxSymbols: planBatchSize,
        maxRequestSymbols: MAX_SYMBOLS,
        ...(planName ? { planName } : {}),
        quoteCacheSeconds: quoteTtlMs / 1000,
        historyCacheSeconds: historyTtlMs / 1000,
        metadataCacheSeconds: metadataTtlMs / 1000,
      });
    }
    const allowed = url.pathname.endsWith('/assets')
      ? ['search', 'kind', 'page']
      : url.pathname.endsWith('/history')
        ? ['symbols', 'range', 'basis']
        : ['symbols'];
    if (
      [...url.searchParams.keys()].some(
        (key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1
      )
    )
      return failure(
        400,
        'INVALID_REQUEST',
        'Parâmetros inválidos. Credenciais são configuradas somente no servidor.'
      );
    if (!token)
      return failure(
        503,
        'PROVIDER_NOT_CONFIGURED',
        'A fonte de mercado ainda não foi configurada no servidor. Seus registros manuais continuam disponíveis.'
      );
    if (activeCredential !== token) {
      activeCredential = token;
      cache.clear();
      inFlight.clear();
      cooldownUntil = 0;
      cachedBytes = 0;
    }
    let path: string,
      params: Record<string, string>,
      ttl: number,
      kind: string,
      wanted: string[] = [],
      basis: string | undefined;
    if (url.pathname.endsWith('/assets')) {
      const search = (url.searchParams.get('search') || '').trim(),
        selectedKind = url.searchParams.get('kind') || 'all',
        page = url.searchParams.get('page') || '1';
      if (
        search.length > 80 ||
        /[\u0000-\u001f<>]/.test(search) ||
        !['all', 'stock', 'etf', 'fii'].includes(selectedKind) ||
        !/^\d{1,3}$/.test(page) ||
        Number(page) < 1 ||
        Number(page) > 100
      )
        return failure(400, 'INVALID_REQUEST', 'Busca ou classe de ativo inválida.');
      path = '/api/v2/tickers';
      params = {
        search,
        limit: '40',
        page,
        sortBy: 'symbol',
        sortOrder: 'asc',
        ...(selectedKind !== 'all' ? { subType: selectedKind } : {}),
      };
      ttl = metadataTtlMs;
      kind = 'assets';
    } else {
      const symbols = (url.searchParams.get('symbols') || '').split(',');
      wanted = [...new Set(symbols)];
      if (
        !wanted.length ||
        wanted.length > MAX_SYMBOLS ||
        symbols.some((value) => !validSymbol(value))
      )
        return failure(
          400,
          'INVALID_SYMBOLS',
          `Informe de 1 a ${MAX_SYMBOLS} códigos válidos separados por vírgula.`
        );
      kind = url.pathname.endsWith('/history') ? 'history' : 'quotes';
      const range = url.searchParams.get('range') || '3mo';
      if (kind === 'history' && !['1mo', '3mo', '6mo', '1y', '2y', '5y', 'max'].includes(range))
        return failure(400, 'INVALID_RANGE', 'Janela histórica não permitida.');
      basis = kind === 'history' ? url.searchParams.get('basis') || 'raw' : undefined;
      if (basis && !['raw', 'adjusted'].includes(basis))
        return failure(400, 'INVALID_BASIS', 'A série deve indicar preços brutos ou ajustados.');
      wanted.sort();
      path = kind === 'history' ? '/api/v2/stocks/historical' : '/api/v2/stocks/quote';
      params = {
        symbols: wanted.join(','),
        ...(kind === 'history'
          ? { range, interval: '1d', ...(basis === 'raw' ? { includeRaw: 'true' } : {}) }
          : {}),
      };
      ttl = kind === 'history' ? historyTtlMs : quoteTtlMs;
    }
    const key = `${path}?${new URLSearchParams(params)}`,
      cached = cache.get(key);
    if (cached && now() - cached.storedAt < ttl)
      return json({
        ...cached.body,
        cached: true,
        meta: { ...object(cached.body.meta), cached: true },
      });
    const existing = inFlight.get(key);
    if (existing) return (await existing).clone();
    if (inFlight.size >= 50)
      return failure(
        429,
        'RATE_LIMITED',
        'Há muitas consultas em andamento. Aguarde para atualizar.',
        10
      );
    const task = (async () => {
      const result = await upstream(path, params, token, request.signal);
      if (result.response) return result.response;
      const fetchedAt = new Date(now()).toISOString();
      let normalized: Data;
      try {
        normalized =
          kind === 'assets'
            ? normalizeAssets(result.body, token, fetchedAt, params.subType || 'all')
            : normalizeSeries(result.body, wanted, kind, token, fetchedAt, basis || 'raw');
      } catch {
        return failure(
          502,
          'INVALID_PROVIDER_DATA',
          'A resposta do provedor não corresponde ao formato esperado.'
        );
      }
      if (activeCredential !== token)
        return failure(
          409,
          'CONFIGURATION_CHANGED',
          'A configuração do provedor mudou. Atualize a consulta.'
        );
      const body = {
          ...normalized,
          ...(basis ? { basis } : {}),
          cached: false,
          meta: {
            provider: 'BRAPI',
            version: 'v2',
            cached: false,
            fetchedAt,
            ...(basis ? { basis } : {}),
          },
        },
        bytes = Buffer.byteLength(JSON.stringify(body));
      const previous = cache.get(key);
      if (previous) {
        cachedBytes -= previous.bytes;
        cache.delete(key);
      }
      while (cache.size && (cache.size >= 100 || cachedBytes + bytes > 8 * 1024 * 1024)) {
        const oldest = cache.keys().next().value!;
        cachedBytes -= cache.get(oldest)!.bytes;
        cache.delete(oldest);
      }
      if (bytes <= 8 * 1024 * 1024) {
        cache.set(key, { storedAt: now(), body, bytes });
        cachedBytes += bytes;
      }
      return json(body);
    })();
    inFlight.set(key, task);
    try {
      return (await task).clone();
    } finally {
      inFlight.delete(key);
    }
  };
}
