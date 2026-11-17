import { describe, it, expect, vi } from 'vitest';
import { BRAZIL_TEAMS } from './football.js';
import { fetchBrazilFootballData } from './football-data.js';
import type { radarJson } from './http.js';

const now = new Date('2026-11-16T11:00:00Z');
const competitionId = 'cp_000000000001';
const teamId = (index: number) => 'tm_' + String(index + 1).padStart(12, '0');
const target = 'br:cr-vasco-da-gama';
function fixtures() {
  const competition = {
    id: competitionId,
    name: 'Brasileirão Série A',
    country_code: 'BRA',
    current_season: '2026',
  };
  const teams = BRAZIL_TEAMS.map((team, index) => ({
    id: teamId(index),
    name: team[2],
    short_name: team[1],
  }));
  const match = {
    id: 'mt_000000000001',
    competition: { id: competitionId, name: competition.name },
    season: '2026',
    round: '35',
    kickoff_at: '2026-11-18T20:00:00-03:00',
    status: 'scheduled',
    home_team: teams[18]!,
    away_team: teams[12]!,
  };
  return { competition, teams, match };
}
function reader(
  data = fixtures(),
  options: { fetchedAt?: string; expiresAt?: string; noMetadata?: boolean; pages?: unknown[] } = {}
) {
  let page = 0;
  const read = vi.fn(async (raw: string, _ttl?: number, meta?: Parameters<typeof radarJson>[2]) => {
    if (raw.endsWith('/competitions')) return { data: [data.competition], paging: null };
    if (new URL(raw).pathname.endsWith('/teams')) return { data: data.teams, paging: null };
    if (!options.noMetadata)
      meta?.({
        fetchedAt: options.fetchedAt ?? now.toISOString(),
        expiresAt: options.expiresAt ?? new Date(now.getTime() + 1200000).toISOString(),
      });
    return options.pages?.[page++] ?? { data: [data.match], paging: null };
  });
  return read;
}
describe('API Dados Futebol public Série A adapter', () => {
  it('maps the exact public club names observed in the provider without fuzzy matching', async () => {
    const data = fixtures();
    const names: Record<string, string> = {
      'ca-mineiro': 'Atletico MG',
      'ca-paranaense': 'Athletico Paranaense',
      'ec-bahia': 'Bahia',
      'botafogo-fr': 'Botafogo RJ',
      'rb-bragantino': 'Red Bull Bragantino',
      'chapecoense-af': 'Chapecoense AF',
      'sc-corinthians-paulista': 'Corinthians',
      'coritiba-fbc': 'Coritiba',
      'cruzeiro-ec': 'Cruzeiro',
      'cr-flamengo': 'Flamengo',
      'fluminense-fc': 'Fluminense',
      'gremio-fbpa': 'Gremio',
      'sc-internacional': 'Internacional',
      'mirassol-fc': 'Mirassol',
      'se-palmeiras': 'Palmeiras',
      'clube-do-remo': 'Remo',
      'santos-fc': 'Santos FC',
      'sao-paulo-fc': 'Sao Paulo',
      'cr-vasco-da-gama': 'Vasco da Gama',
      'ec-vitoria': 'Vitoria',
    };
    for (const [index, team] of BRAZIL_TEAMS.entries()) {
      data.teams[index]!.name = names[team[0]]!;
      data.teams[index]!.short_name = names[team[0]]!;
    }
    expect((await fetchBrazilFootballData(target, now, reader(data))).items[0]!.title).toBe(
      'Vasco × Internacional'
    );
    data.match.home_team = data.teams[3]!;
    expect(
      (await fetchBrazilFootballData('br:botafogo-fr', now, reader(data))).items[0]
    ).toMatchObject({
      title: 'Botafogo × Internacional',
      id: '2026:35:br:botafogo-fr:br:sc-internacional',
    });
    data.teams[3]!.name = 'Botafogo SP';
    data.teams[3]!.short_name = 'Botafogo SP';
    await expect(fetchBrazilFootballData(target, now, reader(data))).rejects.toThrow();
  });
  it('maps a scheduled match to a stable legacy identity and an offset-qualified UTC kickoff', async () => {
    const read = reader();
    const result = await fetchBrazilFootballData(target, now, read);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: '2026:35:br:cr-vasco-da-gama:br:sc-internacional',
      title: 'Vasco × Internacional',
      date: '2026-11-18',
      at: '2026-11-18T23:00:00.000Z',
      provider: 'football-data',
      providerMatchId: 'mt_000000000001',
      status: 'scheduled',
    });
    expect(result.sourceLabel).toBe('API Dados Futebol');
    expect(result.notice).toContain('Brasileirão Série A');
    expect(read.mock.calls).toHaveLength(3);
    const request = new URL(read.mock.calls[2]![0]);
    expect(request.origin).toBe('https://futapi.p.rapidapi.com');
    expect(request.searchParams.get('team')).toBeNull();
    expect(request.searchParams.get('from')).toBe('2026-11-16');
    expect(request.searchParams.get('to')).toBe('2026-11-22');
    expect(request.searchParams.get('season')).toBe('2026');
  });
  it.each(['cancelled', 'live', 'finished', 'postponed', 'rescheduled', 'SCHEDULED', ''])(
    'never exposes a trigger instant for status %s',
    async (status) => {
      const data = fixtures();
      data.match.status = status;
      const item = (await fetchBrazilFootballData(target, now, reader(data))).items[0]!;
      expect(item.at).toBeUndefined();
      expect(item.status).toBe(
        ['cancelled', 'live', 'finished'].includes(status) ? status : 'unknown'
      );
    }
  );
  it.each([
    null,
    undefined,
    'TBD',
    '2026-02-30T21:00:00Z',
    '2026-11-18T20:00:00',
    '2026-11-18T24:00:00Z',
  ])('does not invent a kickoff from %s', async (kickoff) => {
    const data = fixtures();
    Object.assign(data.match, { kickoff_at: kickoff });
    const item = (await fetchBrazilFootballData(target, now, reader(data))).items[0]!;
    expect(item.at).toBeUndefined();
    expect(item.date).toBeUndefined();
    expect(item.text).toContain('Horário a confirmar');
  });
  it('renders only a score actually supplied for a finished match', async () => {
    const data = fixtures();
    data.match.status = 'finished';
    Object.assign(data.match, { score: { home: 0, away: 2 } });
    const item = (await fetchBrazilFootballData(target, now, reader(data))).items[0]!;
    expect(item.text).toContain('0 × 2');
    expect(item.at).toBeUndefined();
    Object.assign(data.match, { score: { home: null, away: null } });
    expect((await fetchBrazilFootballData(target, now, reader(data))).items[0]!.text).not.toContain(
      '0 × 0'
    );
  });
  it('keeps an unresolved round out of matchday deduplication while preserving the provider event', async () => {
    const data = fixtures();
    data.match.round = 'Final';
    const item = (await fetchBrazilFootballData(target, now, reader(data))).items[0]!;
    expect(item.id).toBe('football-data:mt_000000000001');
    expect(item.date).toBeUndefined();
    expect(item.at).toBe('2026-11-18T23:00:00.000Z');
  });
  it('uses the Brazilian day at a UTC boundary without a customer-specific query', async () => {
    const time = new Date('2026-11-17T01:00:00Z');
    const read = reader(fixtures(), {
      fetchedAt: time.toISOString(),
      expiresAt: '2026-11-17T01:20:00Z',
    });
    await fetchBrazilFootballData(target, time, read);
    expect(new URL(read.mock.calls[2]![0]).searchParams.get('from')).toBe('2026-11-16');
  });
  it('retains the oldest actual fixture observation and never extends it through metadata or response headers', async () => {
    const read = reader(fixtures(), {
      fetchedAt: '2026-11-16T10:50:00Z',
      expiresAt: '2026-11-20T00:00:00Z',
    });
    const result = await fetchBrazilFootballData(target, now, read);
    expect(result.observedAt).toBe('2026-11-16T10:50:00.000Z');
    expect(result.expiresAt).toBe('2026-11-16T11:10:00.000Z');
  });
  it.each([
    { fetchedAt: '2026-11-16T10:20:00Z' },
    { fetchedAt: '2026-11-16T11:02:00Z' },
    { expiresAt: '2026-11-16T10:59:00Z' },
    { noMetadata: true },
  ])('rejects a missing, stale or future observation %j', async (options) => {
    await expect(
      fetchBrazilFootballData(target, now, reader(fixtures(), options))
    ).rejects.toThrow();
  });
  it('requires the current Brazilian competition instead of another Série A or an outdated season', async () => {
    const data = fixtures();
    data.competition.country_code = 'ITA';
    await expect(fetchBrazilFootballData(target, now, reader(data))).rejects.toThrow();
    data.competition.country_code = 'BRA';
    data.competition.current_season = '2025';
    await expect(fetchBrazilFootballData(target, now, reader(data))).rejects.toThrow();
  });
  it('rejects incomplete, foreign or ambiguous team mapping instead of using fuzzy names', async () => {
    const data = fixtures();
    data.teams[18]!.name = 'Outro Vasco';
    data.teams[18]!.short_name = 'Outro';
    await expect(fetchBrazilFootballData(target, now, reader(data))).rejects.toThrow();
    const other = fixtures();
    other.teams[18]!.short_name = 'Palmeiras';
    await expect(fetchBrazilFootballData(target, now, reader(other))).rejects.toThrow();
    const missing = fixtures();
    missing.teams.pop();
    await expect(fetchBrazilFootballData(target, now, reader(missing))).rejects.toThrow();
  });
  it.each(['br:not-available', '5567999991111', 'https://private.example/'])(
    'rejects unsupported targets before fetching %s',
    async (target) => {
      const read = reader();
      await expect(fetchBrazilFootballData(target, now, read)).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    }
  );
  it('rejects a provider row from another competition, season or team', async () => {
    for (const patch of [
      { competition: { id: 'cp_999999999999' } },
      { season: '2025' },
      { home_team: { id: 'tm_999999999999' } },
    ]) {
      const data = fixtures();
      Object.assign(data.match, patch);
      await expect(fetchBrazilFootballData(target, now, reader(data))).rejects.toThrow();
    }
  });
  it('rejects conflicting revisions and endless pagination without returning a partial trustworthy schedule', async () => {
    const data = fixtures();
    const pages = [
      { data: [data.match], paging: { next_cursor: 'opaque-next' } },
      { data: [{ ...data.match, kickoff_at: '2026-11-18T22:00:00Z' }], paging: null },
    ];
    await expect(fetchBrazilFootballData(target, now, reader(data, { pages }))).rejects.toThrow();
    const endless = Array.from({ length: 2 }, () => ({
      data: [],
      paging: { next_cursor: 'opaque-next' },
    }));
    await expect(
      fetchBrazilFootballData(target, now, reader(data, { pages: endless }))
    ).rejects.toThrow();
  });
});
