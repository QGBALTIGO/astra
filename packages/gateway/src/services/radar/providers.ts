import { createHash } from 'node:crypto';
import {
  cleanText,
  publicLink,
  RADAR_CATALOG,
  normalizeRadarTarget,
  type RadarSourceId,
  type RadarChoice,
  type RadarResource,
  type RadarSnapshot,
  type RadarItem,
} from './contracts.js';
import { radarJson, radarText, RadarSourceError, type RadarFetchMetadata } from './http.js';
import { searchWeatherCities, forecastWeatherCity } from '../customer-weather.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const fold = (v: string) => v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function required(v: unknown): string {
  const s = cleanText(v);
  if (!s) throw new RadarSourceError('invalid_response');
  return s;
}
function sourceId(v: unknown): string {
  if (!Number.isSafeInteger(v) || Number(v) <= 0) throw new RadarSourceError('invalid_response');
  return String(v);
}
function validDay(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const date = new Date(v + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v ? v : undefined;
}
function instant(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(v)) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
function rate(v: unknown): string {
  const n = number(v);
  if (n === null || n <= 0 || n >= 1e9) throw new RadarSourceError('invalid_response');
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
const day = (d: Date) => d.toISOString().slice(0, 10);
const shift = (d: Date, n: number) => day(new Date(d.getTime() + n * 86400000));
const brazilDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
const url = (base: string, params: Record<string, string>) => {
  const u = new URL(base);
  // Olinda's OData parser does not decode form-style '+' spaces.
  u.search = new URLSearchParams(params).toString().replace(/\+/g, '%20');
  return u.href;
};
export const RADAR_POLL_SECONDS: Record<RadarSourceId, number> = {
  weather: 3600,
  ptax: 1800,
  currency: 21600,
  football: 900,
  news: 3600,
  series: 3600,
  gazettes: 14400,
  energy: 86400,
  releases: 3600,
};

export async function searchRadar(source: RadarSourceId, raw: string): Promise<RadarChoice[]> {
  const query = cleanText(raw, 100);
  if (query.length < 3 || query.length > 100 || /https?:|@|[{}<>\n\r]/i.test(raw))
    throw new Error('Digite ao menos 3 letras para buscar.');
  let choices: RadarChoice[] = [];
  if (source === 'weather') {
    choices = (await searchWeatherCities(query)).map((c) => ({
      id: c.latitude + ',' + c.longitude,
      label: [c.name, c.region, c.country].filter(Boolean).join(', '),
    }));
  } else if (source === 'series') {
    const data = await radarJson(url('https://api.tvmaze.com/search/shows', { q: query }));
    if (!Array.isArray(data)) throw new RadarSourceError('invalid_response');
    choices = array(data)
      .slice(0, 8)
      .map((x) => {
        const show = object(object(x).show);
        return {
          id: String(show.id),
          label: required(show.name),
          description: cleanText(show.premiered, 20),
        };
      })
      .filter((x) => /^\d+$/.test(x.id));
  } else if (source === 'football') {
    const data = object(
      await radarJson('https://api.football-data.org/v4/competitions/BSA/teams', 86400)
    );
    if (!Array.isArray(data.teams)) throw new RadarSourceError('invalid_response');
    choices = array(data.teams)
      .map((x) => {
        const team = object(x);
        return { id: String(team.id), label: required(team.name) };
      })
      .filter((x) => /^\d+$/.test(x.id) && fold(x.label).includes(fold(query)));
  } else if (source === 'gazettes') {
    const data = object(
      await radarJson(
        url('https://api.queridodiario.ok.org.br/cities', { city_name: query, levels: '3' }),
        86400
      )
    );
    if (!Array.isArray(data.cities)) throw new RadarSourceError('invalid_response');
    choices = array(data.cities)
      .map((x) => {
        const c = object(x);
        return {
          id: String(c.territory_id),
          label: required(c.territory_name) + ' / ' + required(c.state_code),
        };
      })
      .filter((x) => /^\d{7}$/.test(x.id));
  }
  return choices.slice(0, 8);
}

/** All adapters are read-only. No content from a provider reaches agent tools or private memories. */
export interface RadarReadClient {
  json: typeof radarJson;
  text: typeof radarText;
  weather: typeof forecastWeatherCity;
}
export async function fetchRadarResource(
  resource: RadarResource & { query?: string | null },
  now = new Date(),
  client: RadarReadClient = {
    json: radarJson,
    text: radarText,
    weather: (city) => forecastWeatherCity(city, 15000),
  }
): Promise<RadarSnapshot> {
  let observedAt = now.toISOString(),
    cacheExpiry = Infinity;
  const metadata = (m: RadarFetchMetadata) => {
    observedAt = m.fetchedAt;
    cacheExpiry = Date.parse(m.expiresAt);
  };
  const readJson = (raw: string, ttl?: number) => client.json(raw, ttl, metadata);
  const target = normalizeRadarTarget(resource.source, resource.target);
  const meta = RADAR_CATALOG.find((x) => x.id === resource.source)!;
  let items: RadarItem[] = [];
  let updated: string | undefined;
  let notice: string | undefined;
  if (resource.source === 'weather') {
    const [latitude, longitude] = target.split(',').map(Number);
    const raw = await client.weather({
      name: resource.label,
      region: '',
      country: '',
      latitude: latitude!,
      longitude: longitude!,
    });
    const data = object(raw),
      props = object(data.properties);
    updated = instant(object(props.meta).updated_at);
    if (
      !updated ||
      Date.parse(updated) > now.getTime() + 600000 ||
      now.getTime() - Date.parse(updated) > 12 * 3600000
    )
      throw new RadarSourceError('stale_source');
    const uniquePoints = new Map<number, Obj>();
    for (const x of array(props.timeseries).map(object)) {
      const t = instant(x.time);
      if (t && !uniquePoints.has(Date.parse(t))) uniquePoints.set(Date.parse(t), x);
    }
    const points = [...uniquePoints.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, x]) => x)
      .filter((x) => {
        const t = instant(x.time);
        return (
          !!t &&
          Date.parse(t) >= now.getTime() - 3600000 &&
          Date.parse(t) < now.getTime() + 24 * 3600000
        );
      });
    const validTemperatures = points.filter((x) => {
      const t = number(object(object(object(x.data).instant).details).air_temperature);
      return t !== null && t >= -100 && t <= 70;
    });
    const temperatures = validTemperatures.map((x) =>
      number(object(object(object(x.data).instant).details).air_temperature)!
    );
    const span =
      validTemperatures.length > 1
        ? Math.max(...validTemperatures.map((x) => Date.parse(String(x.time)))) -
          Math.min(...validTemperatures.map((x) => Date.parse(String(x.time))))
        : 0;
    if (temperatures.length < 6 || span < 18 * 3600000)
      throw new RadarSourceError('incomplete_forecast');
    let rainTotal = 0,
      coveredMs = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!,
        t = Date.parse(String(p.time));
      const amount = number(
        object(object(object(p.data).next_1_hours).details).precipitation_amount
      );
      const start = Math.max(now.getTime(), t),
        end = Math.min(
          now.getTime() + 24 * 3600000,
          t + 3600000,
          i + 1 < points.length ? Date.parse(String(points[i + 1]!.time)) : Infinity
        );
      if (end > start && amount !== null && amount >= 0) {
        coveredMs += end - start;
        rainTotal += (amount * (end - start)) / 3600000;
      }
    }
    const completeRain = coveredMs === 24 * 3600000;
    items = [
      {
        id: updated,
        title: resource.label,
        text:
          'Próximas 24h: ' +
          Math.round(Math.min(...temperatures)) +
          ' a ' +
          Math.round(Math.max(...temperatures)) +
          ' °C. ' +
          (completeRain
            ? 'Chuva estimada: ' + rainTotal.toFixed(1) + ' mm.'
            : 'Chuva: dados incompletos.'),
      },
    ];
    notice =
      'Previsão de modelo, não medição de estação nem alerta oficial. MET Norway · CC BY 4.0.';
  } else if (resource.source === 'ptax') {
    const referenceNow = new Date(brazilDay(now) + 'T12:00:00Z');
    const dateParam = (value: string) =>
      value.slice(5, 7) + '-' + value.slice(8, 10) + '-' + value.slice(0, 4);
    const data = object(
      await readJson(
        url(
          'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)',
          {
            '@moeda': "'" + target + "'",
            '@dataInicial': "'" + dateParam(shift(referenceNow, -7)) + "'",
            '@dataFinalCotacao': "'" + dateParam(day(referenceNow)) + "'",
            $format: 'json',
            $top: '1',
            $orderby: 'dataHoraCotacao desc',
            $filter: "tipoBoletim eq 'Fechamento'",
          }
        )
      )
    );
    if (!Array.isArray(data.value)) throw new RadarSourceError('invalid_response');
    const row = object(array(data.value)[0]);
    updated = validDay(
      typeof row.dataHoraCotacao === 'string' ? row.dataHoraCotacao.slice(0, 10) : undefined
    );
    if (
      !updated ||
      updated < shift(referenceNow, -7) ||
      updated > day(referenceNow) ||
      row.tipoBoletim !== 'Fechamento'
    )
      throw new RadarSourceError('no_recent_reference', 3600);
    const value = rate(row.cotacaoVenda);
    items = [
      {
        id: required(row.dataHoraCotacao),
        title: target + '/BRL · PTAX de venda',
        value,
        text: 'R$ ' + value.replace('.', ',') + ' · fechamento de ' + updated,
      },
    ];
    notice =
      'Referência de fechamento; não é preço para negociação em tempo real. Fonte: Banco Central · ODbL.';
  } else if (resource.source === 'currency') {
    const data = await readJson(
      url('https://api.frankfurter.dev/v2/rates', { base: target.toLowerCase(), quotes: 'brl' })
    );
    if (!Array.isArray(data)) throw new RadarSourceError('invalid_response');
    const row = object(
      array(data).find(
        (x) =>
          String(object(x).quote).toUpperCase() === 'BRL' &&
          String(object(x).base).toUpperCase() === target
      )
    );
    updated = validDay(row.date);
    if (!updated || updated < shift(now, -7) || updated > shift(now, 1))
      throw new RadarSourceError('no_recent_reference', 3600);
    const value = rate(row.rate);
    items = [
      {
        id: updated,
        title: target + '/BRL',
        value,
        text: 'R$ ' + value.replace('.', ',') + ' · referência de ' + updated,
      },
    ];
    notice = 'Taxa combinada de referência do Frankfurter; não é cotação de negociação ao vivo.';
  } else if (resource.source === 'football') {
    const data = object(
      await readJson(
        url('https://api.football-data.org/v4/competitions/BSA/matches', {
          dateFrom: shift(now, -3),
          dateTo: shift(now, 14),
        })
      )
    );
    if (!Array.isArray(data.matches)) throw new RadarSourceError('invalid_response');
    items = array(data.matches)
      .map(object)
      .filter(
        (m) => String(object(m.homeTeam).id) === target || String(object(m.awayTeam).id) === target
      )
      .map((m) => {
        const status = String(m.status);
        const home = required(object(m.homeTeam).name),
          away = required(object(m.awayTeam).name);
        const ft = object(object(m.score).fullTime);
        const a = number(ft.home),
          b = number(ft.away);
        const finished = status === 'FINISHED' && a !== null && b !== null && a >= 0 && b >= 0;
        return {
          id: sourceId(m.id),
          title: home + ' × ' + away,
          text: finished
            ? 'Resultado: ' + a + ' × ' + b
            : status === 'POSTPONED'
              ? 'Partida adiada.'
              : status === 'CANCELLED'
                ? 'Partida cancelada.'
                : status === 'TIMED'
                  ? 'Horário informado pela fonte.'
                  : 'Horário ou resultado ainda não confirmado.',
          ...(status === 'TIMED' && instant(m.utcDate) ? { at: instant(m.utcDate) } : {}),
        };
      });
    notice =
      'Brasileirão Série A. Calendário e resultados podem ter atraso no plano gratuito. Dados: football-data.org.';
  } else if (resource.source === 'news') {
    const data = object(
      await readJson(
        url('https://api.gdeltproject.org/api/v2/doc/doc', {
          query: '"' + target + '" sourcelang:portuguese',
          mode: 'artlist',
          format: 'json',
          sort: 'datedesc',
          maxrecords: '20',
          timespan: '24h',
        })
      )
    );
    if (!Array.isArray(data.articles)) throw new RadarSourceError('invalid_response');
    const seen = new Set<string>();
    items = array(data.articles)
      .map(object)
      .flatMap((a) => {
        const rawLink = publicLink(a.url),
          title = cleanText(a.title);
        const canonical = rawLink ? new URL(rawLink) : null;
        if (canonical) {
          canonical.hash = '';
          for (const k of [...canonical.searchParams.keys()])
            if (/^utm_|^(?:fbclid|gclid|mc_cid|mc_eid)$/i.test(k)) canonical.searchParams.delete(k);
          canonical.searchParams.sort();
        }
        const link = canonical?.href;
        if (!link || !title || seen.has(link)) return [];
        seen.add(link);
        return [{ id: link, title, text: cleanText(a.domain, 100), url: link }];
      });
    notice =
      'Manchetes encontradas pelo GDELT nas últimas 24h. Consulte o veículo original; não são fatos verificados pelo Astra.';
  } else if (resource.source === 'series') {
    const data = object(
      await readJson('https://api.tvmaze.com/shows/' + target + '?embed=nextepisode')
    );
    if (!data.id || !data.name) throw new RadarSourceError('invalid_response');
    const ep = object(object(data._embedded).nextepisode);
    if (ep.id) {
      const at = instant(ep.airstamp);
      items = [
        {
          id: sourceId(ep.id),
          title: required(data.name) + ' · ' + required(ep.name),
          text:
            (Number.isSafeInteger(ep.season) && Number.isSafeInteger(ep.number)
              ? 'Temporada ' + ep.season + ', episódio ' + ep.number + '. '
              : '') +
            'Data da fonte: ' +
            (validDay(ep.airdate) ?? 'a confirmar') +
            '.',
          ...(at ? { at } : {}),
          url: publicLink(ep.url),
        },
      ];
    }
    notice =
      'Calendário da TVmaze · CC BY-SA. A data não garante disponibilidade em um streaming brasileiro.';
  } else if (resource.source === 'gazettes') {
    if (!resource.query) throw new RadarSourceError('invalid_target', 86400);
    const data = object(
      await readJson(
        url('https://api.queridodiario.ok.org.br/gazettes', {
          territory_ids: target,
          querystring: resource.query,
          published_since: shift(now, -7),
          size: '8',
          excerpt_size: '100',
          number_of_excerpts: '0',
          sort_by: 'descending_date',
        })
      )
    );
    if (!Array.isArray(data.gazettes)) throw new RadarSourceError('invalid_response');
    items = array(data.gazettes)
      .map(object)
      .flatMap((g) => {
        const date = validDay(g.date),
          link = publicLink(g.url);
        if (!date || !link || String(g.territory_id) !== target) return [];
        return [
          {
            id: String(g.file_checksum ?? link),
            title: required(g.territory_name) + ' · diário de ' + date,
            text: 'Publicação com o assunto acompanhado. Confira prazos, retificações e condições no documento oficial.',
            url: link,
          },
        ];
      });
    notice =
      'Querido Diário · CC BY 4.0, salvo licença do material. Cobertura municipal parcial; não é catálogo completo de concursos.';
  } else if (resource.source === 'energy') {
    const csv = await client.text(
      'https://dadosabertos.aneel.gov.br/dataset/7f43a020-6dc5-44b8-80b4-d97eaa94436c/resource/0591b8f6-fe54-437b-b72b-1aa2efd46e42/download/bandeira-tarifaria-acionamento.csv',
      { json: false, meta: metadata }
    );
    const rows = parseRadarCsv(csv);
    const currentMonth = brazilDay(now).slice(0, 7);
    const matching = rows
      .filter((r) => csvDay(r.DatCompetencia)?.slice(0, 7) === currentMonth)
      .sort((a, b) =>
        String(b.DatGeracaoConjuntoDados).localeCompare(String(a.DatGeracaoConjuntoDados))
      );
    const row = matching[0];
    if (!row) throw new RadarSourceError('no_current_period', 3600);
    updated = csvDay(row.DatGeracaoConjuntoDados);
    items = [
      {
        id: currentMonth + ':' + required(row.NomBandeiraAcionada),
        title: 'Bandeira tarifária: ' + required(row.NomBandeiraAcionada),
        text: 'Competência: ' + currentMonth + '. Consulte as condições e adicionais da ANEEL.',
      },
    ];
    notice = 'Fonte: ANEEL · ODbL. Bandeira tarifária não representa o valor total da sua conta.';
  } else {
    const data = object(
      await readJson('https://api.github.com/repos/' + target + '/releases/latest')
    );
    if (!data.id || data.draft || data.prerelease)
      throw new RadarSourceError('no_stable_release', 3600);
    updated = instant(data.published_at);
    if (!updated) throw new RadarSourceError('invalid_response');
    items = [
      {
        id: String(data.id),
        title: target + ' · ' + required(data.tag_name),
        text: cleanText(data.name),
        url: publicLink(data.html_url),
      },
    ];
    notice =
      'Release estável publicada no GitHub. Conteúdo e arquivos mantêm a licença do projeto.';
  }
  const unique = new Map<string, RadarItem>();
  for (const i of items) {
    if (i.id && i.title && !unique.has(i.id)) unique.set(i.id, i);
  }
  return {
    items: [...unique.values()].slice(0, 8),
    sourceLabel: meta.provider,
    sourceUrl: meta.url,
    observedAt,
    expiresAt: new Date(
      Math.min(
        now.getTime() + RADAR_POLL_SECONDS[resource.source] * 1000,
        Number.isFinite(cacheExpiry) ? cacheExpiry : Infinity
      )
    ).toISOString(),
    ...(updated ? { sourceUpdatedAt: updated } : {}),
    ...(notice ? { notice } : {}),
  };
}
function csvDay(raw: unknown): string | undefined {
  const s = cleanText(raw, 30).split(' ')[0] ?? '';
  return (
    validDay(s.slice(0, 10)) ??
    (/^\d\d\/\d\d\/\d{4}$/.test(s)
      ? validDay(s.slice(6) + '-' + s.slice(3, 5) + '-' + s.slice(0, 2))
      : undefined)
  );
}
/** Small RFC4180-style parser supporting quoted delimiters and escaped quotes. */
export function parseRadarCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ';' && !quoted) {
      row.push(field);
      field = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new RadarSourceError('invalid_csv');
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  if (!headers.includes('DatCompetencia') || !headers.includes('NomBandeiraAcionada'))
    throw new RadarSourceError('invalid_csv');
  if (rows.length > 10000) throw new RadarSourceError('response_too_large');
  return rows.map((r) => Object.fromEntries(headers.map((k, i) => [k, r[i] ?? ''])));
}
export function snapshotFingerprint(s: RadarSnapshot): string {
  return createHash('sha256').update(JSON.stringify(s.items)).digest('hex');
}
