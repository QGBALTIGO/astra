import { describe, it, expect } from 'vitest';
import { minimizeRadarJson, validateRadarUrl } from './http.js';

const fixtures =
  'https://futapi.p.rapidapi.com/v1/competitions/cp_000000000001/matches?season=2026&from=2026-11-16&to=2026-11-22&timezone=America%2FSao_Paulo&limit=100';
describe('authenticated public football destination contract', () => {
  it('allows only the documented shared competition, team and fixture queries', () => {
    for (const url of [
      'https://futapi.p.rapidapi.com/v1/competitions',
      'https://futapi.p.rapidapi.com/v1/competitions/cp_000000000001/teams?season=2026',
      fixtures,
    ])
      expect(validateRadarUrl(url).hostname).toBe('futapi.p.rapidapi.com');
  });
  it.each([
    'https://api.apidadosfutebol.com/v1/competitions',
    'https://futapi.p.rapidapi.com/v1/players',
    'https://futapi.p.rapidapi.com/v1/competitions?api_key=secret',
    'https://futapi.p.rapidapi.com/v1/competitions/cp_000000000001/teams?season=2026&team=private-user',
    fixtures + '&team=tm_000000000001',
    fixtures + '&from=2026-11-17',
    fixtures.replace('2026-11-16', '2026-02-30'),
    fixtures.replace('2026-11-22', '2026-11-30'),
    fixtures.replace('America%2FSao_Paulo', 'America%2FCuiaba'),
    fixtures.replace('limit=100', 'limit=1000'),
    fixtures + '&cursor=https%3A%2F%2Fprivate.example',
    fixtures + '#another-cache-key',
  ])('refuses secret, customer-specific or off-contract URL %s', (url) => {
    expect(() => validateRadarUrl(url)).toThrow();
  });
  it('strips raw player data, source notes and credential-like fields from cached match rows', () => {
    const result = minimizeRadarJson(new URL(fixtures), {
      data: [
        {
          id: 'mt_000000000001',
          season: '2026',
          round: '35',
          status: 'scheduled',
          kickoff_at: '2026-11-18T23:00:00Z',
          competition: { id: 'cp_000000000001', name: 'Série A', unused: 'PRIVATE' },
          home_team: { id: 'tm_000000000001', name: 'Vasco', image: 'PRIVATE' },
          away_team: { id: 'tm_000000000002', name: 'Internacional', owner: 'PRIVATE' },
          api_key: 'PRIVATE',
          notes: 'PRIVATE',
          raw_statistics: ['PRIVATE'],
        },
      ],
      paging: { next_cursor: null, token: 'PRIVATE' },
      meta: { contact: 'PRIVATE' },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result).toMatchObject({ data: [{ id: 'mt_000000000001', status: 'scheduled' }] });
  });
  it('does not turn a malformed provider envelope or oversized page into an empty schedule', () => {
    for (const data of [{ error: 'outage' }, { data: null }, { data: Array.from({ length: 101 }) }])
      expect(() => minimizeRadarJson(new URL(fixtures), data)).toThrow();
  });
});
