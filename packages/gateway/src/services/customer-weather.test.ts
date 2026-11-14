import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInExecContext } from '@ownpilot/core/agent';
const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  memories: new Map<string, any[]>(),
  lease: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('../db/repositories/settings/index.js', () => ({
  settingsRepo: {
    getAsync: async (key: string) => mocks.settings.get(key) ?? null,
    set: async (key: string, value: unknown) => mocks.settings.set(key, value),
  },
}));
vi.mock('../db/repositories/base.js', () => ({
  BaseRepository: class {
    queryOne = mocks.lease;
  },
}));
vi.mock('../db/repositories/memories.js', () => ({
  MemoriesRepository: class {
    constructor(private userId: string) {}
    async getBySource() {
      return mocks.memories.get(this.userId) ?? [];
    }
    async transaction(fn: () => unknown) {
      return fn();
    }
    async execute() {}
    async create(input: unknown) {
      mocks.memories.set(this.userId, [{ id: 'city', ...(input as object) }]);
    }
    async update(_id: string, input: unknown) {
      mocks.memories.set(this.userId, [{ id: 'city', ...(input as object) }]);
    }
  },
}));
import { customerWeather } from './customer-weather.js';
import { executeCustomerWeatherTool } from '../tools/customer-weather-tools.js';
const city = {
  name: 'Cuiabá',
  region: 'Mato Grosso',
  country: 'Brasil',
  latitude: -15.6,
  longitude: -56.1,
};
const geo = [
  {
    name: city.name,
    lat: '-15.598',
    lon: '-56.099',
    addresstype: 'city',
    address: { state: city.region, country: city.country },
  },
];
const weather = () => ({
  properties: {
    meta: { updated_at: new Date().toISOString() },
    timeseries: [
      {
        time: new Date().toISOString(),
        data: {
          instant: { details: { air_temperature: 31.7, relative_humidity: 54, wind_speed: 4.5 } },
          next_1_hours: {
            summary: { symbol_code: 'clearsky_day' },
            details: { precipitation_amount: 0 },
          },
        },
      },
    ],
  },
});
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { expires: new Date(Date.now() + 3600000).toUTCString() },
  });
beforeEach(() => {
  mocks.settings.clear();
  mocks.memories.clear();
  mocks.lease.mockReset().mockResolvedValue({ key: 'lease' });
  mocks.fetch
    .mockReset()
    .mockImplementation(async (url: string) =>
      response(url.includes('nominatim') ? geo : weather())
    );
  vi.stubGlobal('fetch', mocks.fetch);
});
describe('customer weather and city preference', () => {
  it('asks for a missing city without inferring from phone/timezone or calling a provider', async () => {
    expect(await customerWeather('whatsapp:5567999999999')).toMatchObject({ needsCity: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('persists the stated city and reuses it in later messages for only that customer', async () => {
    expect(await customerWeather('alice', 'Cuiabá, MT, Brasil', true)).toMatchObject({
      saved: true,
      city: 'Cuiabá',
    });
    expect(await customerWeather('alice')).toMatchObject({
      city: 'Cuiabá',
      temperatureC: 31.7,
      windKmH: 16,
      kind: 'model_estimate',
    });
    expect(await customerWeather('bob')).toMatchObject({ needsCity: true });
    expect(mocks.memories.get('alice')?.[0]).toMatchObject({
      type: 'preference',
      source: 'astra-weather-city',
    });
  });
  it('does not replace the default when checking a different city occasionally', async () => {
    mocks.memories.set('alice', [{ metadata: { city: { ...city, name: 'Campo Grande' } } }]);
    await customerWeather('alice', 'Cuiabá, MT');
    expect(mocks.memories.get('alice')?.[0].metadata.city.name).toBe('Campo Grande');
  });
  it('updates the preference without creating conflicting memories', async () => {
    await customerWeather('alice', 'Cuiabá, MT', true);
    mocks.fetch.mockImplementation(async () =>
      response([
        {
          ...geo[0],
          name: 'Campo Grande',
          address: { state: 'Mato Grosso do Sul', country: 'Brasil' },
        },
      ])
    );
    await customerWeather('alice', 'Campo Grande, MS', true);
    expect(mocks.memories.get('alice')).toHaveLength(1);
    expect(mocks.memories.get('alice')?.[0].metadata.city.name).toBe('Campo Grande');
  });
  it('asks which city when the place is ambiguous and stores nothing', async () => {
    mocks.fetch.mockResolvedValueOnce(
      response([geo[0], { ...geo[0], address: { state: 'Outro estado', country: 'Brasil' } }])
    );
    expect(await customerWeather('alice', 'Santa Rita', true)).toMatchObject({
      needsCity: true,
      candidates: [{ name: 'Cuiabá' }, { region: 'Outro estado' }],
    });
    expect(mocks.memories.size).toBe(0);
  });
  it('handles unknown cities without saving a guessed place', async () => {
    mocks.fetch.mockResolvedValueOnce(response([]));
    expect(await customerWeather('alice', 'Lugar desconhecido', true)).toMatchObject({
      needsCity: true,
      candidates: [],
    });
    expect(mocks.memories.size).toBe(0);
  });
  it.each(['Rua A, 123', 'https://example.com', '67 99929-4876'])(
    'rejects addresses, numbers and URLs before transmission: %s',
    async (input) => {
      await expect(customerWeather('alice', input)).rejects.toThrow('somente a cidade');
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  );
  it('reuses public weather data across customers without sharing their preferences', async () => {
    await customerWeather('alice', 'Cuiabá, MT');
    await customerWeather('bob', 'Cuiabá, MT');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.lease).toHaveBeenCalledTimes(1);
    expect(mocks.memories.size).toBe(0);
    const urls = mocks.fetch.mock.calls.map(([url]) => url).join(' ');
    expect(urls).not.toMatch(/alice|bob/);
    expect(urls).toContain('lat=-15.6&lon=-56.1');
  });
  it('does not save preferences based on previously read external content', async () => {
    await expect(
      runInExecContext({ externalContentGuard: { seen: true } }, () =>
        customerWeather('alice', 'Cuiabá, MT', true)
      )
    ).rejects.toThrow('nova mensagem');
    expect(mocks.memories.size).toBe(0);
  });
  it('marks the forecast as external data and preserves source attribution', async () => {
    const guard = { seen: false };
    const result = await runInExecContext({ externalContentGuard: guard }, () =>
      customerWeather('alice', 'Cuiabá, MT')
    );
    expect(guard.seen).toBe(true);
    expect(result).toMatchObject({
      source: { weather: 'MET Norway', location: '© OpenStreetMap contributors' },
    });
  });
  it('rejects stale or malformed data instead of inventing the current temperature', async () => {
    mocks.memories.set('alice', [{ metadata: { city } }]);
    const data = weather();
    data.properties.timeseries[0]!.time = '2020-01-01T00:00:00Z';
    mocks.fetch.mockResolvedValueOnce(response(data));
    await expect(customerWeather('alice')).rejects.toThrow('desatualizada');
  });
  it('keeps upstream errors out of customer replies', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('secret key + provider HTML response'));
    const result = await executeCustomerWeatherTool(
      'get_local_weather',
      { city: 'Cuiabá, MT' },
      'alice'
    );
    expect(result).toEqual({
      success: false,
      error: 'Não consegui consultar o tempo agora. Tente novamente em instantes.',
    });
  });
  it('does not consult or write a shared default user', async () => {
    await expect(customerWeather('default', 'Cuiabá', true)).rejects.toThrow('sua conta');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
