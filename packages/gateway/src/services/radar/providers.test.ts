import { beforeEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ json: vi.fn(), text: vi.fn(), weather: vi.fn(), cities: vi.fn() }));
vi.mock('./http.js', () => ({
  radarJson: m.json,
  radarText: m.text,
  RadarSourceError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock('../customer-weather.js', () => ({
  forecastWeatherCity: m.weather,
  searchWeatherCities: m.cities,
}));
import { fetchRadarResource, parseRadarCsv, searchRadar } from './providers.js';
import type { RadarSourceId } from './contracts.js';
const now = new Date('2026-11-16T11:00:00Z');
const fetchSource = (source: RadarSourceId, target: string, query?: string) =>
  fetchRadarResource({ id: 'resource', source, target, label: 'Minha escolha', query }, now);
function forecast() {
  return {
    properties: {
      meta: { updated_at: now.toISOString() },
      timeseries: Array.from({ length: 24 }, (_, i) => ({
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        data: {
          instant: { details: { air_temperature: 20 + i / 2 } },
          next_1_hours: { details: { precipitation_amount: 0.5 } },
        },
      })),
    },
  };
}
beforeEach(() => vi.resetAllMocks());
describe('free Radar provider contracts', () => {
  it('returns a real normalized currency observation', async () => {
    m.json.mockResolvedValue([{ date: '2026-11-16', base: 'USD', quote: 'BRL', rate: 5.651 }]);
    const s = await fetchSource('currency', 'USD');
    expect(s.items[0]).toMatchObject({ value: '5.651' });
    expect(s.sourceUpdatedAt).toBe('2026-11-16');
  });
  it.each([null, 0, -1, '5.65', NaN, Infinity])(
    'refuses a missing or malformed price %s',
    async (rate) => {
      m.json.mockResolvedValue([{ date: '2026-11-16', base: 'USD', quote: 'BRL', rate }]);
      await expect(fetchSource('currency', 'USD')).rejects.toThrow();
    }
  );
  it.each(['2026-02-30', '2026-10-01', 'malformed'])(
    'rejects an invalid or obsolete quote day %s',
    async (date) => {
      m.json.mockResolvedValue([{ date, base: 'USD', quote: 'BRL', rate: 5 }]);
      await expect(fetchSource('currency', 'USD')).rejects.toThrow();
    }
  );
  it('does not mix inverse base and quote', async () => {
    m.json.mockResolvedValue([{ date: '2026-11-16', base: 'BRL', quote: 'USD', rate: 0.17 }]);
    await expect(fetchSource('currency', 'USD')).rejects.toThrow();
  });
  it('preserves PTAX bulletin date and avoids treating a weekend as zero', async () => {
    m.json.mockResolvedValue({
      value: [
        { dataHoraCotacao: '2026-11-13 13:10:00.0', cotacaoVenda: 5.6, tipoBoletim: 'Fechamento' },
      ],
    });
    expect((await fetchSource('ptax', 'USD')).items[0]!.text).toContain('2026-11-13');
    m.json.mockResolvedValue({ value: [] });
    await expect(fetchSource('ptax', 'USD')).rejects.toThrow();
  });
  it('encodes OData spaces as percent-20 because the real BCB rejects plus signs', async () => {
    m.json.mockResolvedValue({
      value: [
        {
          dataHoraCotacao: '2026-11-13 13:03:27.375047',
          cotacaoVenda: 5.6518,
          tipoBoletim: 'Fechamento',
        },
      ],
    });
    await fetchSource('ptax', 'USD');
    const raw = m.json.mock.calls[0]![0] as string;
    expect(raw).not.toContain('+');
    expect(raw).toContain('%20');
  });
  it('uses the Brazilian reference day at a UTC month boundary', async () => {
    m.text.mockResolvedValue(
      'DatCompetencia;NomBandeiraAcionada;DatGeracaoConjuntoDados\n2026-11-01;Verde;2026-11-30\n2026-12-01;Vermelha;2026-11-30\n'
    );
    const s = await fetchRadarResource(
      { id: 'energy', source: 'energy', target: 'bandeira-tarifaria', label: 'Bandeira' },
      new Date('2026-12-01T01:00:00Z')
    );
    expect(s.items[0]!.title).toContain('Verde');
  });
  it('does not rejuvenate a shared response when another resource consumes it later', async () => {
    m.json.mockImplementation(async (_url, _ttl, meta) => {
      meta({ fetchedAt: '2026-11-16T10:30:00Z', expiresAt: '2026-11-16T11:10:00Z' });
      return [{ date: '2026-11-16', base: 'USD', quote: 'BRL', rate: 5 }];
    });
    const s = await fetchSource('currency', 'USD');
    expect(s.observedAt).toBe('2026-11-16T10:30:00Z');
    expect(s.expiresAt).toBe('2026-11-16T11:10:00.000Z');
  });
  it('shares the existing commercial forecast reader', async () => {
    m.weather.mockResolvedValue(forecast());
    const s = await fetchSource('weather', '-20.47,-55.79');
    expect(m.weather).toHaveBeenCalledOnce();
    expect(s.items[0]!.text).toContain('12.0 mm');
    expect(s.notice).toContain('Previsão de modelo');
  });
  it('does not call missing precipitation zero', async () => {
    const f = forecast();
    delete (f.properties.timeseries[0]!.data as { next_1_hours?: unknown }).next_1_hours;
    m.weather.mockResolvedValue(f);
    expect((await fetchSource('weather', '-20.47,-55.79')).items[0]!.text).toContain(
      'dados incompletos'
    );
  });
  it('does not turn one forecast point into a complete 24h forecast', async () => {
    const f = forecast();
    f.properties.timeseries = f.properties.timeseries.slice(0, 1);
    m.weather.mockResolvedValue(f);
    await expect(fetchSource('weather', '0,0')).rejects.toThrow();
  });
  it('weights overlapping forecast hours and does not count duplicate points twice', async () => {
    const f = forecast();
    f.properties.timeseries.push(
      { ...f.properties.timeseries[0]! },
      { ...f.properties.timeseries[23]!, time: '2026-11-17T11:00:00Z' }
    );
    m.weather.mockResolvedValue(f);
    const s = await fetchRadarResource(
      { id: 'weather', source: 'weather', target: '0,0', label: 'Cidade' },
      new Date('2026-11-16T11:30:00Z')
    );
    expect(s.items[0]!.text).toContain('12.0 mm');
  });
  it('does not call a partial precipitation horizon a complete 24h total', async () => {
    m.weather.mockResolvedValue(forecast());
    const s = await fetchRadarResource(
      { id: 'weather', source: 'weather', target: '0,0', label: 'Cidade' },
      new Date('2026-11-16T11:30:00Z')
    );
    expect(s.items[0]!.text).toContain('dados incompletos');
  });
  it('refuses a weather model from the future', async () => {
    const f = forecast();
    f.properties.meta.updated_at = '2026-11-16T12:00:00Z';
    m.weather.mockResolvedValue(f);
    await expect(fetchSource('weather', '0,0')).rejects.toThrow();
  });
  const match = (
    status: string,
    utcDate: string | undefined,
    score: unknown = { fullTime: { home: null, away: null } }
  ) => ({
    id: 1,
    status,
    utcDate,
    homeTeam: { id: 1783, name: 'Flamengo' },
    awayTeam: { id: 1769, name: 'Palmeiras' },
    score,
  });
  it.each(['SCHEDULED', 'POSTPONED', 'CANCELLED', 'SUSPENDED', 'FINISHED'])(
    'never invents a pregame instant for status %s',
    async (status) => {
      m.json.mockResolvedValue({ matches: [match(status, '2026-11-16T12:00:00Z')] });
      const s = await fetchSource('football', '1783');
      expect(s.items[0]?.at).toBeUndefined();
    }
  );
  it('does not render null scores as a goalless draw', async () => {
    m.json.mockResolvedValue({ matches: [match('FINISHED', '2026-11-16T10:00:00Z')] });
    expect((await fetchSource('football', '1783')).items[0]!.text).not.toContain('0 × 0');
  });
  it('rejects a match without a stable source ID', async () => {
    m.json.mockResolvedValue({
      matches: [{ ...match('TIMED', '2026-11-16T12:00:00Z'), id: undefined }],
    });
    await expect(fetchSource('football', '1783')).rejects.toThrow();
  });
  it('renders confirmed full-time scores only for the followed club', async () => {
    m.json.mockResolvedValue({
      matches: [match('FINISHED', '2026-11-16T10:00:00Z', { fullTime: { home: 2, away: 1 } })],
    });
    expect((await fetchSource('football', '1783')).items[0]!.text).toBe('Resultado: 2 × 1');
    expect((await fetchSource('football', '9999')).items).toHaveLength(0);
  });
  it('deduplicates tracking variants of the same news URL', async () => {
    m.json.mockResolvedValue({
      articles: [
        { title: 'Notícia', url: 'https://example.com/artigo?utm_source=a', domain: 'example.com' },
        { title: 'Notícia', url: 'https://example.com/artigo?utm_source=b', domain: 'example.com' },
      ],
    });
    expect((await fetchSource('news', 'Tecnologia')).items).toHaveLength(1);
  });
  it('drops malicious news URLs and strips external markup', async () => {
    m.json.mockResolvedValue({
      articles: [
        { title: '<img src=x>Olá', url: 'https://example.com/a' },
        { title: 'malicioso', url: 'javascript:alert(1)' },
      ],
    });
    expect((await fetchSource('news', 'Tecnologia')).items).toMatchObject([{ title: 'Olá' }]);
  });
  it('does not generate a countdown for a TV episode without airstamp', async () => {
    m.json.mockResolvedValue({
      id: 1,
      name: 'Série',
      _embedded: {
        nextepisode: {
          id: 2,
          name: 'Episódio',
          season: 2,
          number: 1,
          airdate: '2026-11-17',
          airstamp: null,
        },
      },
    });
    const s = await fetchSource('series', '1');
    expect(s.items[0]!.at).toBeUndefined();
    expect(s.notice).toContain('não garante');
  });
  it('does not fabricate an episode if none is scheduled', async () => {
    m.json.mockResolvedValue({ id: 1, name: 'Série', _embedded: {} });
    expect((await fetchSource('series', '1')).items).toEqual([]);
  });
  it('omits unknown season and episode numbers instead of displaying null', async () => {
    m.json.mockResolvedValue({
      id: 1,
      name: 'Série',
      _embedded: {
        nextepisode: { id: 2, name: 'Especial', season: null, number: null, airdate: '2026-11-17' },
      },
    });
    const s = await fetchSource('series', '1');
    expect(s.items[0]!.text).not.toMatch(/null|undefined/);
  });
  it('does not expose gazette excerpts with unnecessary personal data', async () => {
    m.json.mockResolvedValue({
      gazettes: [
        {
          territory_id: '5002704',
          territory_name: 'Campo Grande',
          date: '2026-11-16',
          url: 'https://example.com/diario',
          file_checksum: 'abc',
          excerpts: ['CPF 111.111.111-11 salário R$ 1'],
        },
      ],
    });
    const s = await fetchSource('gazettes', '5002704', 'concurso');
    expect(JSON.stringify(s)).not.toContain('111.111');
    expect(JSON.stringify(s)).not.toContain('salário');
  });
  it('does not silently substitute another gazette municipality', async () => {
    m.json.mockResolvedValue({
      gazettes: [
        {
          territory_id: '9999999',
          territory_name: 'Outra cidade',
          date: '2026-11-16',
          url: 'https://example.com/diario',
        },
      ],
    });
    expect((await fetchSource('gazettes', '5002704', 'concurso')).items).toEqual([]);
  });
  it('uses only the effective energy month, not a future announcement', async () => {
    m.text.mockResolvedValue(
      'DatCompetencia;NomBandeiraAcionada;DatGeracaoConjuntoDados\n2026-12-01;Vermelha;2026-11-16\n2026-11-01;Verde;2026-11-16\n'
    );
    const s = await fetchSource('energy', 'bandeira-tarifaria');
    expect(s.items[0]!.title).toContain('Verde');
  });
  it('fails safely when the CSV schema changes', async () => {
    m.text.mockResolvedValue('data;tipo\n2026-11-01;Verde');
    await expect(fetchSource('energy', 'bandeira-tarifaria')).rejects.toThrow();
  });
  it.each([true, false])('rejects draft or preview releases: draft=%s', async (draft) => {
    m.json.mockResolvedValue({
      id: 1,
      draft,
      prerelease: !draft,
      tag_name: 'v1',
      published_at: now.toISOString(),
    });
    await expect(fetchSource('releases', 'owner/repo')).rejects.toThrow();
  });
  it('uses a stable release ID instead of sorting version text lexically', async () => {
    m.json.mockResolvedValue({
      id: 19,
      draft: false,
      prerelease: false,
      tag_name: 'v10.0.0',
      name: 'Nova versão',
      published_at: now.toISOString(),
      html_url: 'https://github.com/owner/repo/releases/tag/v10',
    });
    expect((await fetchSource('releases', 'owner/repo')).items[0]!.id).toBe('19');
  });
  it('searches only covered gazette municipalities using the real documented route', async () => {
    m.json.mockResolvedValue({
      cities: [{ territory_id: '5002704', territory_name: 'Campo Grande', state_code: 'MS' }],
    });
    expect(await searchRadar('gazettes', 'Campo Grande')).toEqual([
      { id: '5002704', label: 'Campo Grande / MS' },
    ]);
    expect(m.json.mock.calls[0]![0]).toContain('/cities?city_name=');
  });
});
describe('ANEEL CSV encoding and quoting', () => {
  it('handles BOM, CRLF and embedded separators', () => {
    expect(
      parseRadarCsv(
        '\uFEFFDatCompetencia;NomBandeiraAcionada\r\n2026-11-01;"Vermelha; patamar 1"\r\n'
      )[0]!.NomBandeiraAcionada
    ).toBe('Vermelha; patamar 1');
  });
  it('rejects truncated quoted data', () =>
    expect(() => parseRadarCsv('DatCompetencia;NomBandeiraAcionada\n2026-11-01;"Verde')).toThrow());
});
