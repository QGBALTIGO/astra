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
  'api.football-data.org': { interval: 7000, ttl: 900 },
  'api.gdeltproject.org': { interval: 5500, ttl: 3600 },
  'api.tvmaze.com': { interval: 600, ttl: 3600 },
  'api.queridodiario.ok.org.br': { interval: 1500, ttl: 14400 },
  'dadosabertos.aneel.gov.br': { interval: 1500, ttl: 86400 },
  'api.github.com': { interval: 65000, ttl: 3600 },
};
const PATHS: Record<string, RegExp> = {
  'api.frankfurter.dev': /^\/v2\/rates$/,
  'olinda.bcb.gov.br':
    /^\/olinda\/servico\/PTAX\/versao\/v1\/odata\/CotacaoMoedaPeriodo\(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao\)$/,
  'api.football-data.org': /^\/v4\/competitions\/BSA\/(?:teams|matches)$/,
  'api.gdeltproject.org': /^\/api\/v2\/doc\/doc$/,
  'api.tvmaze.com': /^(?:\/search\/shows|\/shows\/\d+)$/,
  'api.queridodiario.ok.org.br': /^\/(?:cities|gazettes)$/,
  'dadosabertos.aneel.gov.br':
    /^\/dataset\/[a-f0-9-]+\/resource\/[a-f0-9-]+\/download\/bandeira-tarifaria-acionamento\.csv$/,
  'api.github.com': /^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/releases\/latest$/,
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
    case 'api.football-data.org': {
      const data = record(value);
      if (url.pathname.endsWith('/teams'))
        return { teams: list(data.teams, 40).map((r) => pick(r, ['id', 'name'])) };
      return {
        matches: list(data.matches, 200).map((raw) => {
          const m = record(raw),
            score = m.score && typeof m.score === 'object' ? record(m.score) : {};
          return {
            ...pick(m, ['id', 'status', 'utcDate', 'lastUpdated']),
            homeTeam: pick(m.homeTeam, ['id', 'name']),
            awayTeam: pick(m.awayTeam, ['id', 'name']),
            score: { fullTime: score.fullTime ?? null },
          };
        }),
      };
    }
    case 'api.gdeltproject.org':
      return {
        articles: list(record(value).articles, 20).map((r) =>
          pick(r, ['title', 'url', 'domain', 'seendate'])
        ),
      };
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
    default:
      throw new RadarSourceError('invalid_source');
  }
}
export interface RadarFetchMetadata {
  fetchedAt: string;
  expiresAt: string;
}
class RadarHttpRepository extends BaseRepository {
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
  return url;
}
/** Fixed allowlist, no redirects, bounded streaming, distributed cache and provider budget. */
export async function radarText(
  raw: string,
  options: { ttl?: number; json?: boolean; meta?: (metadata: RadarFetchMetadata) => void } = {}
): Promise<string> {
  const url = validateRadarUrl(raw);
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
      throw new RadarSourceError('rate_wait', Math.ceil(policy.interval / 1000));
    const headers: Record<string, string> = {
      'User-Agent': 'Astra-Radar/1.0 (+https://astraacessor.pro)',
      Accept: options.json === false ? 'text/csv' : 'application/json',
    };
    if (url.hostname === 'api.football-data.org') {
      if (
        !process.env.ASTRA_RADAR_FOOTBALL_KEY ||
        process.env.ASTRA_RADAR_FOOTBALL_APPROVED !== 'true'
      )
        throw new RadarSourceError('source_not_configured', 3600);
      headers['X-Auth-Token'] = process.env.ASTRA_RADAR_FOOTBALL_KEY;
    }
    if (url.hostname === 'api.github.com') {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
    }
    const res = await fetch(url.href, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
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
    if (Number(res.headers.get('content-length')) > 1_500_000) {
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
      if (length > 1_500_000) {
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
    const seconds = Math.max(
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
export async function radarJson(
  raw: string,
  ttl?: number,
  meta?: (metadata: RadarFetchMetadata) => void
): Promise<unknown> {
  return JSON.parse(await radarText(raw, { ttl, meta }));
}
