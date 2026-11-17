import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapters/types.js';
const state = vi.hoisted(() => ({ adapter: null as DatabaseAdapter | null }));
vi.mock('../../db/adapters/index.js', () => ({
  getAdapter: async () => {
    if (!state.adapter) throw new Error('Test DB missing');
    return state.adapter;
  },
}));
import { radarTestDatabase } from '../../db/repositories/radar-pg-fixture.js';
import { radarJson, radarText, validateRadarUrl, reserveFootballDataAttempt } from './http.js';

describe('Radar source destination restrictions', () => {
  it.each([
    'http://api.github.com/repos/a/b/releases/latest',
    'https://evil.example/',
    'https://user:pass@api.github.com/',
    'https://api.github.com:444/',
    'https://api.github.com/user',
    'https://api.frankfurter.dev/private',
  ])('rejects off-contract destinations %s', (u) => expect(() => validateRadarUrl(u)).toThrow());
});
describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'Radar real PostgreSQL shared HTTP cache',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    const url = 'https://api.frankfurter.dev/v2/rates?base=usd&quotes=brl';
    const quote = [{ date: '2026-11-16', base: 'USD', quote: 'BRL', rate: 5.651 }];
    const fetchMock = vi.fn();
    beforeAll(async () => {
      fixture = await radarTestDatabase();
      state.adapter = fixture.adapter;
    });
    beforeEach(async () => {
      await fixture.adapter.exec('TRUNCATE radar_http_cache,radar_provider_limits');
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(new Response(JSON.stringify(quote)));
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
    afterAll(async () => {
      state.adapter = null;
      await fixture?.close();
    });
    it('does one external request for concurrent subscribers and shares the persisted response', async () => {
      const first = await Promise.allSettled(Array.from({ length: 30 }, () => radarJson(url)));
      expect(first.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const next = await Promise.all(Array.from({ length: 30 }, () => radarJson(url)));
      expect(next.every((x) => JSON.stringify(x) === JSON.stringify(quote))).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('does not cache an API error as an empty valid dataset', async () => {
      fetchMock.mockResolvedValue(new Response('upstream error', { status: 503 }));
      await expect(radarJson(url)).rejects.toMatchObject({ code: 'provider_unavailable' });
      expect(
        (await fixture.adapter.queryOne<{ n: string }>(
          'SELECT COUNT(*) AS n FROM radar_http_cache WHERE body IS NOT NULL'
        ))!.n
      ).toBe('0');
    });
    it('preserves original fetch time and expiry on a shared cache hit', async () => {
      const fresh = vi.fn(),
        cached = vi.fn();
      await radarJson(url, undefined, fresh);
      const original = {
        fetchedAt: '2026-11-16T10:00:00.000Z',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
      await fixture.adapter.execute('UPDATE radar_http_cache SET touched_at=$1,expires_at=$2', [
        original.fetchedAt,
        original.expiresAt,
      ]);
      await radarJson(url, undefined, cached);
      expect(cached).toHaveBeenCalledWith(original);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('backs off all collectors when a provider returns 429', async () => {
      fetchMock.mockResolvedValue(
        new Response('{}', { status: 429, headers: { 'Retry-After': '600' } })
      );
      await expect(radarJson(url)).rejects.toMatchObject({
        code: 'provider_throttled',
        retrySeconds: 600,
      });
      await expect(radarJson(url + '&x=2')).rejects.toMatchObject({ code: 'rate_wait' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const r = await fixture.adapter.queryOne<{ seconds: number }>(
        `SELECT EXTRACT(EPOCH FROM(blocked_until-NOW()))::float AS seconds FROM radar_provider_limits`
      );
      expect(r!.seconds).toBeGreaterThan(590);
    });
    it('refuses redirects without following an untrusted target', async () => {
      fetchMock.mockResolvedValue(
        new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/' } })
      );
      await expect(radarJson(url)).rejects.toMatchObject({ code: 'provider_unavailable' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1].redirect).toBe('error');
    });
    it('bounds streaming even if content-length is missing', async () => {
      fetchMock.mockResolvedValue(new Response('x'.repeat(1_500_001)));
      await expect(radarText(url)).rejects.toMatchObject({ code: 'response_too_large' });
    });
    it('refuses non-JSON provider pages instead of treating HTML as news', async () => {
      fetchMock.mockResolvedValue(new Response('<html>outage</html>'));
      await expect(radarJson(url)).rejects.toMatchObject({ code: 'invalid_response' });
    });
    it('does not persist unnecessary article text, images or secrets in a public cache', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: 1,
              title: { rendered: 'Manchete' },
              link: 'https://pt.globalvoices.org/a',
              date_gmt: '2026-11-16T10:00:00',
              body: 'TEXTO_INTEGRAL_NAO_LICENCIADO',
              socialimage: 'https://example.com/privado.jpg',
              private_note: 'SEGREDO',
            },
          ])
        )
      );
      await radarJson('https://pt.globalvoices.org/wp-json/wp/v2/posts?search=tecnologia');
      const r = await fixture.adapter.queryOne<{ body: string }>(
        'SELECT body FROM radar_http_cache WHERE body IS NOT NULL'
      );
      expect(r!.body).not.toContain('TEXTO_INTEGRAL');
      expect(r!.body).not.toContain('SEGREDO');
      expect(r!.body).not.toContain('socialimage');
    });
    it('does not cache unused release assets, source code or author profiles', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 19,
            tag_name: 'v1',
            name: 'Versão',
            published_at: '2026-11-16T12:00:00Z',
            html_url: 'https://github.com/a/b/releases/tag/v1',
            draft: false,
            prerelease: false,
            body: 'TEXTO_INTEGRAL',
            assets: [{ browser_download_url: 'https://example.com/asset' }],
            author: { email: 'EMAIL_NAO_NECESSARIO' },
          })
        )
      );
      await radarJson('https://api.github.com/repos/a/b/releases/latest');
      const r = await fixture.adapter.queryOne<{ body: string }>(
        'SELECT body FROM radar_http_cache WHERE body IS NOT NULL'
      );
      expect(r!.body).not.toContain('TEXTO_INTEGRAL');
      expect(r!.body).not.toContain('EMAIL_NAO_NECESSARIO');
      expect(r!.body).not.toContain('assets');
    });
    it('never uses an operator credential to expose a private repository to customers', async () => {
      vi.stubEnv('ASTRA_RADAR_GITHUB_TOKEN', 'synthetic-operator-private-scope');
      fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));
      await expect(
        radarJson('https://api.github.com/repos/a/private/releases/latest')
      ).rejects.toMatchObject({ code: 'source_not_found' });
      expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBeUndefined();
      vi.unstubAllEnvs();
    });
    const footballUrl =
      'https://futapi.p.rapidapi.com/v1/competitions/cp_000000000001/matches?season=2026&from=2026-11-16&to=2026-11-22&timezone=America%2FSao_Paulo&limit=100';
    it('shares one football call and one quota slot among 500 concurrent customers', async () => {
      vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-football-read-key');
      vi.stubEnv('GROQ_API_KEY', 'synthetic-unrelated-operator-key');
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ data: [], paging: null, private: 'SECRET' }))
      );
      const replies = await Promise.all(Array.from({ length: 500 }, () => radarJson(footballUrl)));
      expect(replies).toHaveLength(500);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = fetchMock.mock.calls[0]!;
      expect(request[0]).toBe(footballUrl);
      expect(request[0]).not.toContain('synthetic-football');
      expect(request[1].headers['x-rapidapi-key']).toBe('synthetic-football-read-key');
      expect(request[1].headers['x-rapidapi-host']).toBe('futapi.p.rapidapi.com');
      expect(request[1].headers.Authorization).toBeUndefined();
      const rows = await fixture.adapter.query<{ key: string; body: string }>(
        'SELECT key,body FROM radar_http_cache WHERE body IS NOT NULL'
      );
      expect(rows.find((row) => row.key.startsWith('budget:futapi:'))!.body).toBe('1');
      expect(JSON.stringify(rows)).not.toMatch(/synthetic-football|synthetic-unrelated|SECRET/);
    });
    it('atomically caps attempts at 90 for 500 contenders, independent of cache keys and restarts', async () => {
      const reservations = await Promise.all(
        Array.from({ length: 500 }, () => reserveFootballDataAttempt())
      );
      expect(reservations.filter(Boolean)).toHaveLength(90);
      expect(await reserveFootballDataAttempt()).toBe(false);
      vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-football-read-key');
      await expect(radarJson(footballUrl)).rejects.toMatchObject({ code: 'daily_budget' });
      expect(fetchMock).not.toHaveBeenCalled();
      const row = await fixture.adapter.queryOne<{ body: string }>(
        "SELECT body FROM radar_http_cache WHERE key LIKE 'budget:futapi:%'"
      );
      expect(row!.body).toBe('90');
    });
    it('uses a new UTC day slot rather than clearing prior reservations', async () => {
      await fixture.adapter.execute(
        "INSERT INTO radar_http_cache(key,body,expires_at) VALUES('budget:futapi:2000-01-01','90',NOW()-INTERVAL '1 day')"
      );
      expect(await reserveFootballDataAttempt()).toBe(true);
      const rows = await fixture.adapter.query<{ body: string }>(
        "SELECT body FROM radar_http_cache WHERE key LIKE 'budget:futapi:%' ORDER BY key"
      );
      expect(rows.map((row) => row.body)).toEqual(['90', '1']);
    });
    it('counts failed attempts and sanitizes authenticated request failures', async () => {
      vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-football-read-key');
      fetchMock.mockRejectedValue(new Error('synthetic-football-read-key failure details'));
      await expect(radarJson(footballUrl)).rejects.toMatchObject({ code: 'provider_unavailable' });
      await expect(radarJson(footballUrl)).rejects.not.toThrow('synthetic-football-read-key');
      const row = await fixture.adapter.queryOne<{ body: string }>(
        "SELECT body FROM radar_http_cache WHERE key LIKE 'budget:futapi:%'"
      );
      expect(row!.body).toBe('2');
    });
    it('caps football cache freshness even when upstream advertises a much longer TTL', async () => {
      vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-football-read-key');
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ data: [], paging: null }), {
          headers: {
            'Cache-Control': 'max-age=31536000',
            Expires: 'Wed, 01 Jan 2031 00:00:00 GMT',
          },
        })
      );
      const observation = vi.fn();
      await radarJson(footballUrl, undefined, observation);
      const meta = observation.mock.calls[0]![0];
      expect(Date.parse(meta.expiresAt) - Date.parse(meta.fetchedAt)).toBeLessThanOrEqual(1201000);
      expect(Date.parse(meta.expiresAt) - Date.parse(meta.fetchedAt)).toBeGreaterThan(1190000);
    });
    it('bounds football bodies and rejects an unminimized text read before any request', async () => {
      vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-football-read-key');
      await expect(radarText(footballUrl, { json: false })).rejects.toMatchObject({
        code: 'invalid_source',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock.mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1)));
      await expect(radarJson(footballUrl)).rejects.toMatchObject({ code: 'response_too_large' });
    });
  }
);
