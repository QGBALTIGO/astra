import { createHash } from 'node:crypto';
import { getExecContext } from '@ownpilot/core/agent';
import { MemoriesRepository } from '../db/repositories/memories.js';
import { BaseRepository } from '../db/repositories/base.js';
import { settingsRepo } from '../db/repositories/settings/index.js';

export interface WeatherCity {
  name: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
}
interface ForecastPoint {
  time: string;
  data: {
    instant: {
      details: { air_temperature: number; relative_humidity: number; wind_speed: number };
    };
    next_1_hours?: {
      summary?: { symbol_code?: string };
      details?: { precipitation_amount?: number };
    };
  };
}
interface Forecast {
  properties: { meta: { updated_at: string }; timeseries: ForecastPoint[] };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const SOURCE = 'astra-weather-city';
const headers = {
  'User-Agent': 'Astra/1.0 (+https://astraacessor.pro)',
  Accept: 'application/json',
};
const source = {
  weather: 'MET Norway',
  url: 'https://api.met.no/',
  license: 'https://creativecommons.org/licenses/by/4.0/',
  location: '© OpenStreetMap contributors',
  locationUrl: 'https://www.openstreetmap.org/copyright',
};

class WeatherStorage extends BaseRepository {
  /** One global lease across replicas; the public geocoder allows at most 1 request/second. */
  async reserveGeocode(): Promise<void> {
    const row = await this.queryOne(
      `INSERT INTO settings(key,value,updated_at) VALUES('weather:geocoder-lease','null',NOW())
       ON CONFLICT(key) DO UPDATE SET updated_at=NOW()
       WHERE settings.updated_at < NOW()-INTERVAL '1100 milliseconds' RETURNING key`
    );
    if (!row)
      throw new Error('Estou consultando outra cidade agora. Tente novamente em alguns segundos.');
  }
}
class WeatherCityRepository extends MemoriesRepository {
  constructor(private readonly scope: string) {
    super(scope);
  }
  async city(): Promise<WeatherCity | null> {
    const memories = await this.getBySource(SOURCE);
    return (memories[0]?.metadata?.city as WeatherCity | undefined) ?? null;
  }
  async remember(city: WeatherCity): Promise<void> {
    await this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [
        SOURCE + this.scope,
      ]);
      const previous = (await this.getBySource(SOURCE))[0];
      const input = {
        content: `Cidade preferida para o tempo: ${city.name}, ${city.region}, ${city.country}.`,
        importance: 0.8,
        tags: ['cidade', 'clima'],
        metadata: { city },
      };
      if (previous) await this.update(previous.id, input);
      else await this.create({ ...input, type: 'preference', source: SOURCE });
    });
  }
}
const storage = new WeatherStorage();
const cityLookups = new Map<string, Promise<WeatherCity[]>>();
const weatherLookups = new Map<string, Promise<{ data: Forecast; expires: number }>>();

function cityQuery(value: string): string {
  const query = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  // Only coarse city names reach a third party. Never send an address, phone or URL.
  if (query.length < 2 || query.length > 120 || !/^[\p{L}\p{M}\s,.'()–-]+$/u.test(query))
    throw new Error('Me diga somente a cidade e o estado ou país, sem endereço.');
  return query;
}
async function jsonRequest<T>(url: string): Promise<{ data: T; expires: number }> {
  const response = await fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok)
    throw new Error('Não consegui consultar o tempo agora. Tente novamente em instantes.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('A consulta do tempo veio incompleta.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 512000) {
      await reader.cancel();
      throw new Error('A consulta do tempo veio incompleta.');
    }
    chunks.push(part.value);
  }
  const bytes = Buffer.concat(chunks);
  return {
    data: JSON.parse(bytes.toString('utf8')) as T,
    expires: Date.parse(response.headers.get('expires') ?? '') || Date.now() + 600000,
  };
}
async function resolveCity(query: string): Promise<WeatherCity[]> {
  const key = 'weather:geocode:' + hash(query.toLocaleLowerCase('pt-BR'));
  const cached = await settingsRepo.getAsync<{ cities: WeatherCity[]; expires: number }>(key);
  if (cached && cached.expires > Date.now()) return cached.cities;
  const pending = cityLookups.get(key);
  if (pending) return pending;
  const lookup = (async () => {
    await storage.reserveGeocode();
    // Replaceable by the operator without a code change if the public service requests it.
    const url = new URL(
      process.env.ASTRA_CITY_GEOCODER_URL || 'https://nominatim.openstreetmap.org/search'
    );
    url.search = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '5',
      featureType: 'city',
      'accept-language': 'pt-BR',
    }).toString();
    const { data } = await jsonRequest<
      Array<{
        name: string;
        lat: string;
        lon: string;
        addresstype: string;
        address: { state?: string; country?: string };
      }>
    >(url.toString());
    const cities: WeatherCity[] = [];
    for (const row of data) {
      if (!['city', 'town', 'village', 'municipality'].includes(row.addresstype)) continue;
      const latitude = Number(Number(row.lat).toFixed(2)),
        longitude = Number(Number(row.lon).toFixed(2));
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      )
        continue;
      const city = {
        name: String(row.name).slice(0, 120),
        region: String(row.address?.state ?? '').slice(0, 120),
        country: String(row.address?.country ?? '').slice(0, 100),
        latitude,
        longitude,
      };
      if (
        !cities.some(
          (c) => c.name === city.name && c.region === city.region && c.country === city.country
        )
      )
        cities.push(city);
    }
    await settingsRepo.set(key, {
      cities,
      expires: Date.now() + (cities.length ? 30 * 86400000 : 60000),
    });
    return cities;
  })();
  cityLookups.set(key, lookup);
  try {
    return await lookup;
  } finally {
    cityLookups.delete(key);
  }
}
async function forecast(city: WeatherCity): Promise<Forecast> {
  const key = `weather:forecast:${city.latitude},${city.longitude}`;
  const cached = await settingsRepo.getAsync<{ data: Forecast; expires: number }>(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  let pending = weatherLookups.get(key);
  if (!pending) {
    if (weatherLookups.size >= 4)
      throw new Error('O tempo está sendo consultado agora. Tente novamente em alguns segundos.');
    pending = jsonRequest<Forecast>(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${city.latitude}&lon=${city.longitude}`
    );
    weatherLookups.set(key, pending);
  }
  try {
    const result = await pending;
    await settingsRepo.set(key, result);
    return result.data;
  } finally {
    weatherLookups.delete(key);
  }
}
export async function customerWeather(userId: string, city?: string, remember = false) {
  if (!userId || userId === 'default')
    throw new Error('Entre na sua conta para consultar o tempo.');
  if (remember && getExecContext()?.externalContentGuard?.seen)
    throw new Error('Me informe sua cidade em uma nova mensagem para eu salvar a preferência.');
  const repo = new WeatherCityRepository(userId);
  let selected: WeatherCity | null;
  if (city) {
    const cities = await resolveCity(cityQuery(city));
    if (cities.length !== 1)
      return {
        needsCity: true,
        question: cities.length
          ? 'Qual dessas cidades? Me diga também o estado ou país.'
          : 'Não encontrei essa cidade. Pode informar o nome e o estado ou país?',
        candidates: cities.map(({ name, region, country }) => ({ name, region, country })),
      };
    selected = cities[0]!;
  } else selected = await repo.city();
  if (!selected)
    return {
      needsCity: true,
      question:
        'Em qual cidade você está? Me diga também o estado para eu guardar e consultar o tempo por aqui.',
    };
  if (remember) {
    await repo.remember(selected);
    return { saved: true, city: selected.name, region: selected.region, country: selected.country };
  }
  const data = await forecast(selected);
  const now = Date.now();
  const point = data.properties?.timeseries?.reduce<ForecastPoint | undefined>(
    (best, next) =>
      Math.abs(Date.parse(next.time) - now) < Math.abs(Date.parse(best?.time ?? '') - now) || !best
        ? next
        : best,
    undefined
  );
  const details = point?.data?.instant?.details;
  if (
    !point ||
    !details ||
    !Number.isFinite(details.air_temperature) ||
    !Number.isFinite(Date.parse(point.time)) ||
    Math.abs(Date.parse(point.time) - now) > 90 * 60000 ||
    !Number.isFinite(Date.parse(data.properties.meta.updated_at)) ||
    Date.parse(data.properties.meta.updated_at) - now > 10 * 60000 ||
    now - Date.parse(data.properties.meta.updated_at) > 12 * 3600000
  )
    throw new Error(
      'A previsão disponível está desatualizada. Prefiro consultar novamente mais tarde.'
    );
  const guard = getExecContext()?.externalContentGuard;
  if (guard) guard.seen = true;
  return {
    city: selected.name,
    region: selected.region,
    country: selected.country,
    temperatureC: Math.round(details.air_temperature * 10) / 10,
    humidityPercent: details.relative_humidity,
    windKmH: Math.round(details.wind_speed * 3.6),
    conditionCode: point.data.next_1_hours?.summary?.symbol_code,
    precipitationNextHourMm: point.data.next_1_hours?.details?.precipitation_amount,
    forecastTime: point.time,
    updatedAt: data.properties.meta.updated_at,
    kind: 'model_estimate',
    source,
    instruction:
      'Responda naturalmente em português com emoji discreto, cidade e temperatura estimada agora. Não chame de medição de uma estação. Inclua Fonte: MET Norway · localização © OpenStreetMap e os links de atribuição. Nunca invente sensação térmica nem chuva certa.',
  };
}
