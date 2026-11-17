import { createHash, randomUUID } from 'node:crypto';
import { BaseRepository } from '../../db/repositories/base.js';
import { radarRepo } from '../../db/repositories/customer-radar.js';

export class RadarSourceError extends Error {
  constructor(
    readonly code: string,
    readonly retrySeconds = 300
  ) {
    super('A fonte está temporariamente indisponível. Tente novamente mais tarde.');
    this.name = 'RadarSourceError';
  }
}
const POLICY: Record<string, { interval: number; ttl: number }> = {
  'api.frankfurter.dev': { interval: 1000, ttl: 21600 },
  'olinda.bcb.gov.br': { interval: 1500, ttl: 1800 },
  'raw.githubusercontent.com': { interval: 1500, ttl: 21600 },
  'pt.globalvoices.org': { interval: 1500, ttl: 3600 },
  'api.tvmaze.com': { interval: 600, ttl: 3600 },
  'api.queridodiario.ok.org.br': { interval: 1500, ttl: 14400 },
  'dadosabertos.aneel.gov.br': { interval: 1500, ttl: 86400 },
  'api.github.com': { interval: 65000, ttl: 3600 },
  'futapi.p.rapidapi.com': { interval: 0, ttl: 1200 },
};
const PATHS: Record<string, RegExp> = {
  'api.frankfurter.dev': /^\/v2\/rates$/,
  'olinda.bcb.gov.br':
    /^\/olinda\/servico\/PTAX\/versao\/v1\/odata\/CotacaoMoedaPeriodo\(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao\)$/,
  'raw.githubusercontent.com': /^\/openfootball\/south-america\/master\/brazil\/20\d{2}_br1\.txt$/,
  'pt.globalvoices.org': /^\/wp-json\/wp\/v2\/posts$/,
  'api.tvmaze.com': /^(?:\/search\/shows|\/shows\/\d+)$/,
  'api.queridodiario.ok.org.br': /^\/(?:cities|gazettes)$/,
  'dadosabertos.aneel.gov.br':
    /^\/dataset\/[a-f0-9-]+\/resource\/[a-f0-9-]+\/download\/bandeira-tarifaria-acionamento\.csv$/,
  'api.github.com': /^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/releases\/latest$/,
  'futapi.p.rapidapi.com': /^\/v1\/competitions(?:\/cp_[A-Za-z0-9]{12}\/(?:teams|matches))?$/,
};
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new RadarSourceError('invalid_response');
  return value as Record<string, unknown>;
}
function pick(value: unknown, keys: string[]) {
  const o = record(value);
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
function list(value: unknown, max: number) {
  if (!Array.isArray(value)) throw new RadarSourceError('invalid_response');
  return value.slice(0, max);
}
/** Provider cache stores only the fields used by the public-data adapter. */
export function minimizeRadarJson(url: URL, value: unknown): unknown {
  switch (url.hostname) {
    case 'api.frankfurter.dev':
      return list(value, 20).map((r) => pick(r, ['date', 'base', 'quote', 'rate']));
    case 'olinda.bcb.gov.br':
      return {
        value: list(record(value).value, 1).map((r) =>
          pick(r, ['dataHoraCotacao', 'cotacaoVenda', 'tipoBoletim'])
        ),
      };
    case 'pt.globalvoices.org':
      return list(value, 20).map((r) => ({
        ...pick(r, ['id', 'date_gmt', 'link']),
        title: pick(record(r).title, ['rendered']),
      }));
    case 'api.tvmaze.com': {
      if (url.pathname === '/search/shows')
        return list(value, 8).map((r) => ({
          show: pick(record(r).show, ['id', 'name', 'premiered']),
        }));
      const show = record(value),
        embedded = show._embedded ? record(show._embedded) : {};
      return {
        ...pick(show, ['id', 'name']),
        _embedded: {
          nextepisode: embedded.nextepisode
            ? pick(embedded.nextepisode, [
                'id',
                'name',
                'season',
                'number',
                'airdate',
                'airstamp',
                'url',
              ])
            : undefined,
        },
      };
    }
    case 'api.queridodiario.ok.org.br': {
      const data = record(value);
      return url.pathname === '/cities'
        ? {
            cities: list(data.cities, 100).map((r) =>
              pick(r, ['territory_id', 'territory_name', 'state_code', 'level'])
            ),
          }
        : {
            gazettes: list(data.gazettes, 8).map((r) =>
              pick(r, ['territory_id', 'territory_name', 'date', 'url', 'file_checksum'])
            ),
          };
    }
    case 'api.github.com':
      return pick(value, [
        'id',
        'tag_name',
        'name',
        'published_at',
        'html_url',
        'draft',
        'prerelease',
      ]);
    case 'futapi.p.rapidapi.com': {
      const envelope = record(value);
      if (!Array.isArray(envelope.data) || envelope.data.length > 100)
        throw new RadarSourceError('invalid_response');
      const paging = envelope.paging == null ? null : record(envelope.paging);
      return {
        data: envelope.data.map((row) =>
          url.pathname.endsWith('/matches')
            ? {
                ...pick(row, ['id', 'season', 'round', 'kickoff_at', 'status']),
                competition: pick(record(row).competition, ['id', 'name']),
                home_team: pick(record(row).home_team, ['id', 'name', 'short_name']),
                away_team: pick(record(row).away_team, ['id', 'name', 'short_name']),
                score: record(row).score == null ? null : pick(record(row).score, ['home', 'away']),
              }
            : pick(row, ['id', 'name', 'short_name', 'country_code', 'current_season'])
        ),
        paging: paging ? pick(paging, ['next_cursor']) : null,
      };
    }
    default:
      throw new RadarSourceError('invalid_source');
  }
}
export interface RadarFetchMetadata {
  fetchedAt: string;
  expiresAt: string;
}
class RadarHttpRepository extends BaseRepository {
  async reserveFootballAttempt(): Promise<boolean> {
    const count =
      "CASE WHEN radar_http_cache.body ~ '^[0-9]{1,3}$' THEN radar_http_cache.body::integer ELSE 90 END";
    return !!(await this.queryOne(
      `INSERT INTO radar_http_cache(key,body,expires_at,touched_at)
       VALUES('budget:futapi:' || to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD'),'1',
         (date_trunc('day',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+INTERVAL '1 day',NOW())
       ON CONFLICT(key) DO UPDATE SET body=((${count})+1)::text,touched_at=NOW()
       WHERE (${count})<90 RETURNING key`
    ));
  }
  async cached(
    key: string
  ): Promise<{ body: string; touched_at: Date | string; expires_at: Date | string } | null> {
    return this.queryOne(
      `SELECT body,touched_at,expires_at FROM radar_http_cache WHERE key=$1 AND body IS NOT NULL AND expires_at>NOW()`,
      [key]
    );
  }
  async claim(key: string, token: string): Promise<boolean> {
    return !!(await this.queryOne(
      `INSERT INTO radar_http_cache(key,lease_token,leased_until) VALUES($1,$2,NOW()+INTERVAL '30 seconds')
   ON CONFLICT(key) DO UPDATE SET lease_token=$2,leased_until=NOW()+INTERVAL '30 seconds',touched_at=NOW()
   WHERE radar_http_cache.expires_at<=NOW() AND (radar_http_cache.leased_until IS NULL OR radar_http_cache.leased_until<NOW()) RETURNING key`,
      [key, token]
    ));
  }
  async finish(key: string, token: string, body: string, seconds: number) {
    return this.queryOne<{ touched_at: Date | string; expires_at: Date | string }>(
      `UPDATE radar_http_cache SET body=$3,expires_at=NOW()+$4*INTERVAL '1 second',lease_token=NULL,leased_until=NULL,touched_at=NOW()
    WHERE key=$1 AND lease_token=$2 AND leased_until>NOW() RETURNING touched_at,expires_at`,
      [key, token, body, seconds]
    );
  }
  async release(key: string, token: string) {
    await this.execute(
      'UPDATE radar_http_cache SET lease_token=NULL,leased_until=NULL WHERE key=$1 AND lease_token=$2',
      [key, token]
    );
  }
}
const cache = new RadarHttpRepository();
export function reserveFootballDataAttempt(): Promise<boolean> {
  return cache.reserveFootballAttempt();
}
export function validateRadarUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !POLICY[url.hostname] ||
    !PATHS[url.hostname]?.test(url.pathname)
  )
    throw new RadarSourceError('invalid_source', 86400);
  if (url.hostname === 'futapi.p.rapidapi.com') {
    const names = [...url.searchParams.keys()];
    const match = url.pathname.endsWith('/matches');
    const team = url.pathname.endsWith('/teams');
    const allowed = match
      ? ['season', 'from', 'to', 'timezone', 'limit', 'cursor']
      : team
        ? ['season']
        : [];
    if (
      url.hash ||
      new Set(names).size !== names.length ||
      names.some((name) => !allowed.includes(name))
    )
      throw new RadarSourceError('invalid_source', 86400);
    if ((match || team) && !/^20\d{2}$/.test(url.searchParams.get('season') ?? ''))
      throw new RadarSourceError('invalid_source', 86400);
    if (match) {
      const from = url.searchParams.get('from') ?? '',
        to = url.searchParams.get('to') ?? '';
      const validDay = (day: string) =>
        /^20\d{2}-\d{2}-\d{2}$/.test(day) &&
        Number.isFinite(Date.parse(day)) &&
        new Date(day).toISOString().slice(0, 10) === day;
      if (
        !validDay(from) ||
        !validDay(to) ||
        Date.parse(to) < Date.parse(from) ||
        Date.parse(to) - Date.parse(from) > 6 * 86400000 ||
        url.searchParams.get('timezone') !== 'America/Sao_Paulo' ||
        url.searchParams.get('limit') !== '100' ||
        (url.searchParams.has('cursor') &&
          !/^[A-Za-z0-9_+/=-]{1,64}$/.test(url.searchParams.get('cursor')!))
      )
        throw new RadarSourceError('invalid_source', 86400);
    }
  }
  return url;
}
export interface RadarTextOptions {
  ttl?: number;
  json?: boolean;
  meta?: (metadata: RadarFetchMetadata) => void;
}
/** Fixed allowlist, no redirects, bounded streaming, distributed cache and provider budget. */
async function loadRadarText(raw: string, options: RadarTextOptions = {}): Promise<string> {
  const url = validateRadarUrl(raw);
  if (url.hostname === 'futapi.p.rapidapi.com' && options.json === false)
    throw new RadarSourceError('invalid_source', 86400);
  const policy = POLICY[url.hostname]!;
  const key = createHash('sha256').update(url.href).digest('hex');
  const cached = await cache.cached(key);
  if (cached !== null) {
    options.meta?.({
      fetchedAt: new Date(cached.touched_at).toISOString(),
      expiresAt: new Date(cached.expires_at).toISOString(),
    });
    return cached.body;
  }
  const token = randomUUID();
  if (!(await cache.claim(key, token))) throw new RadarSourceError('fetch_pending', 30);
  try {
    // Customer Radar never inherits an operator credential with private repository access.
    if (!(await radarRepo.reserveProvider(url.hostname, policy.interval)))
      throw new RadarSourceError(
        'rate_wait',
        url.hostname === 'futapi.p.rapidapi.com' ? 60 : Math.ceil(policy.interval / 1000)
      );
    const headers: Record<string, string> = {
      'User-Agent': 'Astra-Radar/1.0 (+https://astraacessor.pro)',
      Accept: options.json === false ? 'text/plain,text/csv' : 'application/json',
    };
    if (url.hostname === 'api.github.com') {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
    }
    if (url.hostname === 'futapi.p.rapidapi.com') {
      const key = process.env.ASTRA_FOOTBALL_DATA_KEY?.trim();
      if (!key || key.length > 512 || /[^\x21-\x7e]/.test(key))
        throw new RadarSourceError('source_not_configured', 3600);
      if (!(await cache.reserveFootballAttempt())) throw new RadarSourceError('daily_budget', 3600);
      headers['x-rapidapi-host'] = 'futapi.p.rapidapi.com';
      headers['x-rapidapi-key'] = key;
    }
    let res: Response;
    try {
      res = await fetch(url.href, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      // An authenticated public-data call must not carry request details into
      // a channel error, telemetry or a later model turn.
      if (url.hostname === 'futapi.p.rapidapi.com')
        throw new RadarSourceError('provider_unavailable');
      throw error;
    }
    if (res.status === 429 || (res.status === 403 && url.hostname === 'api.github.com')) {
      const retry = res.headers.get('retry-after');
      const until =
        retry && /^\d+$/.test(retry)
          ? Number(retry)
          : retry
            ? Math.max(1, (Date.parse(retry) - Date.now()) / 1000)
            : 60;
      const wait = Number.isFinite(until) ? Math.max(60, Math.min(until, 86400)) : 60;
      await res.body?.cancel();
      await radarRepo.blockProvider(url.hostname, wait);
      throw new RadarSourceError('provider_throttled', wait);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new RadarSourceError(
        res.status === 404 ? 'source_not_found' : 'provider_unavailable',
        res.status === 404 ? 3600 : 300
      );
    }
    const bodyLimit = url.hostname === 'futapi.p.rapidapi.com' ? 512 * 1024 : 1_500_000;
    if (Number(res.headers.get('content-length')) > bodyLimit) {
      await res.body?.cancel();
      throw new RadarSourceError('response_too_large', 3600);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new RadarSourceError('empty_response');
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > bodyLimit) {
        await reader.cancel();
        throw new RadarSourceError('response_too_large', 3600);
      }
      parts.push(part.value);
    }
    let body = Buffer.concat(parts).toString('utf8');
    if (options.json !== false) {
      try {
        body = JSON.stringify(minimizeRadarJson(url, JSON.parse(body)));
      } catch {
        throw new RadarSourceError('invalid_response');
      }
      if (Buffer.byteLength(body) > 200000) throw new RadarSourceError('response_too_large', 3600);
    }
    const expires = Date.parse(res.headers.get('expires') ?? '');
    const maxAge = res.headers.get('cache-control')?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
    const seconds =
      url.hostname === 'futapi.p.rapidapi.com'
        ? Math.min(options.ttl ?? policy.ttl, url.pathname.endsWith('/matches') ? 1200 : 86400)
        : Math.max(
            options.ttl ?? policy.ttl,
            Number.isFinite(expires) ? Math.ceil((expires - Date.now()) / 1000) : 0,
            Number(maxAge) || 0
          );
    const saved = await cache.finish(key, token, body, Math.min(seconds, 7 * 86400));
    if (!saved) throw new RadarSourceError('fetch_pending', 30);
    options.meta?.({
      fetchedAt: new Date(saved.touched_at).toISOString(),
      expiresAt: new Date(saved.expires_at).toISOString(),
    });
    return body;
  } finally {
    await cache.release(key, token);
  }
}
const flights = new Map<string, Promise<{ body: string; metadata?: RadarFetchMetadata }>>();
/** Coalesce same-process readers; the PostgreSQL lease also fences other collectors. */
export async function radarText(raw: string, options: RadarTextOptions = {}): Promise<string> {
  const url = validateRadarUrl(raw);
  const key = JSON.stringify([url.href, options.json !== false, options.ttl ?? null]);
  let flight = flights.get(key);
  if (!flight) {
    let metadata: RadarFetchMetadata | undefined;
    const started = loadRadarText(raw, {
      ...options,
      meta: (value) => {
        metadata = value;
      },
    })
      .then((body) => ({ body, metadata }))
      .finally(() => {
        if (flights.get(key) === started) flights.delete(key);
      });
    flights.set(key, started);
    flight = started;
  }
  const result = await flight;
  if (result.metadata) options.meta?.(result.metadata);
  return result.body;
}
export async function radarJson(
  raw: string,
  ttl?: number,
  meta?: (metadata: RadarFetchMetadata) => void
): Promise<unknown> {
  return JSON.parse(await radarText(raw, { ttl, meta }));
}
