import { BRAZIL_TEAMS } from './football.js';
import { RadarSourceError, type RadarFetchMetadata, type radarJson } from './http.js';
import type { RadarItem, RadarSnapshot } from './contracts.js';

const BASE = 'https://futapi.p.rapidapi.com/v1/competitions';
const SOURCE = 'https://www.apidadosfutebol.com/api-futebol-brasileiro';
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const extraNames: Record<string, string[]> = {
  'ca-mineiro': ['Atlético Mineiro', 'Clube Atlético Mineiro'],
  'ca-paranaense': ['Athletico Paranaense', 'Atlético Paranaense', 'Club Athletico Paranaense'],
  'ec-bahia': ['Esporte Clube Bahia'],
  'botafogo-fr': ['Botafogo de Futebol e Regatas', 'Botafogo RJ'],
  'rb-bragantino': ['Red Bull Bragantino'],
  'chapecoense-af': ['Associação Chapecoense de Futebol'],
  'sc-corinthians-paulista': ['SC Corinthians', 'Sport Club Corinthians Paulista'],
  'coritiba-fbc': ['Coritiba Foot Ball Club'],
  'cruzeiro-ec': ['Cruzeiro Esporte Clube'],
  'cr-flamengo': ['Clube de Regatas do Flamengo'],
  'fluminense-fc': ['Fluminense Football Club'],
  'gremio-fbpa': ['Grêmio Foot Ball Porto Alegrense'],
  'sc-internacional': ['Sport Club Internacional'],
  'mirassol-fc': ['Mirassol Futebol Clube'],
  'se-palmeiras': ['Sociedade Esportiva Palmeiras'],
  'clube-do-remo': [],
  'santos-fc': ['Santos Futebol Clube'],
  'sao-paulo-fc': ['São Paulo Futebol Clube'],
  'cr-vasco-da-gama': ['Vasco da Gama', 'Club de Regatas Vasco da Gama'],
  'ec-vitoria': ['Esporte Clube Vitória'],
};
const teamAliases = new Map<string, string>();
for (const [id, label, official] of BRAZIL_TEAMS)
  for (const alias of [label, official, ...(extraNames[id] ?? [])])
    teamAliases.set(fold(alias), 'br:' + id);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RadarSourceError('invalid_response');
  return value as Record<string, unknown>;
};
const opaque = (value: unknown, prefix: 'cp' | 'tm' | 'mt') => {
  if (typeof value !== 'string' || !new RegExp('^' + prefix + '_[A-Za-z0-9]{12}$').test(value))
    throw new RadarSourceError('invalid_response');
  return value;
};
function envelope(value: unknown) {
  const data = object(value);
  if (!Array.isArray(data.data) || data.data.length > 100)
    throw new RadarSourceError('invalid_response');
  const next = data.paging == null ? null : object(data.paging).next_cursor;
  if (next != null && (typeof next !== 'string' || !/^[A-Za-z0-9_+/=-]{1,64}$/.test(next)))
    throw new RadarSourceError('invalid_response');
  return { rows: data.data.map(object), next: next as string | null | undefined };
}
const dateInBrazil = (value: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(value);
function kickoffInstant(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(
      value
    )
  )
    return undefined;
  const day = value.slice(0, 10);
  const calendar = new Date(day + 'T12:00:00Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day)
    return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

/** Public Série A data only; no customer identifier or credential enters these URLs. */
export async function fetchBrazilFootballData(
  target: string,
  now: Date,
  read: typeof radarJson
): Promise<RadarSnapshot> {
  if (!BRAZIL_TEAMS.some((team) => 'br:' + team[0] === target))
    throw new RadarSourceError('unsupported_team');
  const year = dateInBrazil(now).slice(0, 4);
  const competitions = envelope(await read(BASE, 86400));
  if (competitions.next) throw new RadarSourceError('incomplete_response');
  const competition = competitions.rows.filter(
    (row) =>
      ['BR', 'BRA'].includes(String(row.country_code)) &&
      typeof row.name === 'string' &&
      [
        'serie a',
        'brasileirao serie a',
        'campeonato brasileiro serie a',
        'brazil serie a',
        'brasileirao',
      ].includes(fold(row.name))
  );
  if (competition.length !== 1 || competition[0]!.current_season !== year)
    throw new RadarSourceError('unsupported_season');
  const competitionId = opaque(competition[0]!.id, 'cp');
  const teamUrl = new URL(BASE + '/' + competitionId + '/teams');
  teamUrl.searchParams.set('season', year);
  const teamData = envelope(await read(teamUrl.href, 86400));
  if (teamData.next || teamData.rows.length !== BRAZIL_TEAMS.length)
    throw new RadarSourceError('incomplete_coverage');
  const teams = new Map<string, string>();
  const mapped = new Set<string>();
  for (const row of teamData.rows) {
    const id = opaque(row.id, 'tm');
    const labels = [row.name, row.short_name].filter((s): s is string => typeof s === 'string');
    const matches = new Set(labels.map((name) => teamAliases.get(fold(name))).filter(Boolean));
    if (matches.size !== 1 || teams.has(id)) throw new RadarSourceError('ambiguous_team');
    const canonical = [...matches][0]!;
    if (mapped.has(canonical)) throw new RadarSourceError('ambiguous_team');
    teams.set(id, canonical);
    mapped.add(canonical);
  }
  const from = dateInBrazil(now);
  const to = new Date(Date.parse(from + 'T12:00:00Z') + 6 * 86400000).toISOString().slice(0, 10);
  const fixturesUrl = new URL(BASE + '/' + competitionId + '/matches');
  for (const [key, value] of Object.entries({
    season: year,
    from,
    to,
    timezone: 'America/Sao_Paulo',
    limit: '100',
  }))
    fixturesUrl.searchParams.set(key, value);
  const rows: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  let fetchedAt = Infinity,
    expiresAt = Infinity;
  for (let page = 0; page < 2; page++) {
    let observed = false;
    const data = envelope(
      await read(fixturesUrl.href, 1200, (meta: RadarFetchMetadata) => {
        const fetched = Date.parse(meta.fetchedAt),
          expiry = Date.parse(meta.expiresAt);
        if (
          !Number.isFinite(fetched) ||
          !Number.isFinite(expiry) ||
          fetched > now.getTime() + 60000 ||
          expiry <= now.getTime() ||
          now.getTime() - fetched > 30 * 60000
        )
          throw new RadarSourceError('stale_source');
        observed = true;
        fetchedAt = Math.min(fetchedAt, fetched);
        expiresAt = Math.min(expiresAt, expiry, fetched + 20 * 60000);
      })
    );
    if (!observed) throw new RadarSourceError('missing_observation');
    rows.push(...data.rows);
    if (!data.next) break;
    if (page === 1 || seenCursors.has(data.next)) throw new RadarSourceError('incomplete_response');
    seenCursors.add(data.next);
    fixturesUrl.searchParams.set('cursor', data.next);
  }
  if (expiresAt <= now.getTime()) throw new RadarSourceError('stale_source');
  const items = new Map<string, RadarItem>();
  const identities = new Map<string, string>();
  const label = (id: string) => BRAZIL_TEAMS.find((team) => 'br:' + team[0] === id)![1];
  for (const row of rows) {
    const providerMatchId = opaque(row.id, 'mt');
    if (object(row.competition).id !== competitionId || row.season !== year)
      throw new RadarSourceError('invalid_response');
    const home = teams.get(opaque(object(row.home_team).id, 'tm'));
    const away = teams.get(opaque(object(row.away_team).id, 'tm'));
    if (!home || !away || home === away) throw new RadarSourceError('invalid_response');
    const instant = kickoffInstant(row.kickoff_at);
    const day = instant ? dateInBrazil(new Date(instant)) : undefined;
    if (day && (day < from || day > to)) throw new RadarSourceError('invalid_response');
    const status = ['scheduled', 'live', 'finished', 'cancelled'].includes(String(row.status))
      ? (row.status as 'scheduled' | 'live' | 'finished' | 'cancelled')
      : 'unknown';
    const roundMatch =
      typeof row.round === 'string'
        ? /^(?:(?:Matchday|Rodada)\s+)?([1-9]|[12]\d|3[0-8])$/i.exec(row.round.trim())
        : null;
    // An unmatched round must not create a new date-based notification for an
    // existing matchday subscription. Before notifications use the provider id.
    const id = roundMatch
      ? `${year}:${roundMatch[1]}:${home}:${away}`
      : 'football-data:' + providerMatchId;
    const score = row.score == null ? null : object(row.score);
    const reportedScore =
      score &&
      [score.home, score.away].every(
        (goals) => typeof goals === 'number' && Number.isInteger(goals) && goals >= 0 && goals <= 99
      )
        ? score.home + ' × ' + score.away
        : undefined;
    const item: RadarItem = {
      id,
      title: label(home) + ' × ' + label(away),
      provider: 'football-data',
      providerMatchId,
      status,
      ...(roundMatch && day ? { date: day } : {}),
      ...(status === 'scheduled' && instant ? { at: instant } : {}),
      text:
        status === 'cancelled'
          ? 'Partida cancelada.'
          : status === 'live'
            ? 'Partida em andamento.'
            : status === 'finished'
              ? reportedScore
                ? 'Resultado informado: ' + reportedScore
                : 'Partida encerrada · resultado ainda não informado.'
              : status === 'unknown'
                ? 'Situação da partida a confirmar.'
                : instant
                  ? 'Horário divulgado · Brasileirão Série A.'
                  : 'Horário a confirmar · Brasileirão Série A.',
      url: SOURCE,
    };
    const fingerprint = JSON.stringify(item);
    if (
      (identities.has(providerMatchId) && identities.get(providerMatchId) !== fingerprint) ||
      (items.has(id) && items.get(id)!.providerMatchId !== providerMatchId)
    )
      throw new RadarSourceError('conflicting_match');
    identities.set(providerMatchId, fingerprint);
    if (home === target || away === target) items.set(id, item);
  }
  return {
    items: [...items.values()]
      .sort((a, b) => (a.at ?? a.date ?? '').localeCompare(b.at ?? b.date ?? ''))
      .slice(0, 8),
    observedAt: new Date(fetchedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    sourceLabel: 'API Dados Futebol',
    sourceUrl: SOURCE,
    notice:
      'Brasileirão Série A. Horários divulgados podem mudar; partidas sem horário ou sem situação agendada não geram aviso antecipado.',
  };
}
