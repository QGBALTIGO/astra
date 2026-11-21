import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInExecContext } from '@ownpilot/core/agent';
import type { NormalizedMessage, PipelineContext, MessageProcessingResult } from '@ownpilot/core/services';
import { executeCustomerWeatherTool } from '../../tools/customer-weather-tools.js';
import { createDirectWeatherMiddleware, currentWeatherOnlyQuery } from './direct-weather.js';

vi.mock('../../tools/customer-weather-tools.js', () => ({
  executeCustomerWeatherTool: vi.fn(),
}));
vi.mock('../log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const weather = vi.mocked(executeCustomerWeatherTool);
const fact = {
  city: 'Ivinhema',
  region: 'Mato Grosso do Sul',
  temperatureC: 28.4,
  humidityPercent: 61,
  kind: 'model_estimate',
  source: { weather: 'MET Norway' },
};

function testContext(userId: string) {
  const store = new Map<string, unknown>([['userId', userId]]);
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    set: (key: string, value: unknown) => void store.set(key, value),
    has: (key: string) => store.has(key),
    addStage: vi.fn(),
    addWarning: vi.fn(),
    aborted: false,
  } as PipelineContext;
}
async function send(
  content: string,
  options: { userId?: string; channelIsPrivate?: boolean; source?: string; attachments?: unknown[] } = {}
) {
  const message = {
    id: 'synthetic-current-weather',
    sessionId: 'synthetic-session',
    role: 'user',
    content,
    metadata: { source: options.source ?? 'channel', platform: 'whatsapp' },
    attachments: options.attachments,
    timestamp: new Date(),
  } as NormalizedMessage;
  const ctx = testContext(options.userId ?? 'whatsapp:5567999991234');
  const nextResponse: MessageProcessingResult = {
    response: { id: 'next', sessionId: message.sessionId, role: 'assistant', content: 'normal-agent', metadata: { source: 'channel' }, timestamp: new Date() },
    streamed: false,
    durationMs: 1,
    stages: ['agent-execution'],
  };
  const next = vi.fn(async () => nextResponse);
  const result = await runInExecContext(
    { channelPluginId: 'channel.whatsapp', platformChatId: 'synthetic-phone', channelIsPrivate: options.channelIsPrivate ?? true },
    () => createDirectWeatherMiddleware()(message, ctx, next)
  );
  return { result, next, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  weather.mockResolvedValue({ success: true, result: fact });
});

describe('current weather only intent', () => {
  it.each([
    ['Temperatura', undefined],
    ['Qual é a temperatura agora?', undefined],
    ['Como está o tempo hoje?', undefined],
    ['Quantos graus tá fazendo?', undefined],
    ['Clima agora em Ivinhema, MS?', 'Ivinhema, MS'],
    ['Qual a temperatura em Campo Grande, MS?', 'Campo Grande, MS'],
    ['Tempo em minha cidade?', undefined],
  ])('routes only an immediate weather lookup: %s', (text, city) => {
    expect(currentWeatherOnlyQuery(text)).toEqual(city ? { city } : {});
  });

  it.each([
    'Avise quando a temperatura cair para 20 graus',
    'Qual a previsão do tempo para amanhã?',
    'Tem chuva durante a semana?',
    'Salve Ivinhema como minha cidade e diga a temperatura',
    'Qual a temperatura e quais são meus gastos?',
    'Qual a temperatura no meu endereço Rua A, 123?',
    'Quanto custou meu ar-condicionado?',
    'Temperatura em https://example.com',
  ])('does not intercept other intents: %s', (text) => {
    expect(currentWeatherOnlyQuery(text)).toBeNull();
  });
});

describe('deterministic weather read on WhatsApp', () => {
  it('returns verified temperature without any AI call or side effect', async () => {
    const { result, ctx, next } = await send('Qual a temperatura em Ivinhema, MS?');
    expect(weather).toHaveBeenCalledExactlyOnceWith(
      'get_local_weather', { city: 'Ivinhema, MS' }, 'whatsapp:5567999991234'
    );
    expect(next).not.toHaveBeenCalled();
    expect(result.response.content).toContain('28,4 °C');
    expect(result.response.content).toContain('Ivinhema');
    expect(result.response.content).not.toContain('sensação térmica');
    expect(result.stages).toEqual(['direct-weather']);
    expect(ctx.get('usage')).toBeUndefined();
    expect(ctx.get('pipelineResult')).toBe(result);
  });

  it('asks for a missing preferred city instead of inventing one from the phone', async () => {
    weather.mockResolvedValue({ success: true, result: {
      needsCity: true,
      question: 'Em qual cidade você está? Diga também o estado.',
    } });
    const { result } = await send('Temperatura');
    expect(result.response.content).toMatch(/qual cidade|em qual cidade/iu);
    expect(weather).toHaveBeenCalledWith('get_local_weather', {}, 'whatsapp:5567999991234');
  });

  it('does not claim a value when the provider failed, even with a success-shaped envelope', async () => {
    weather.mockResolvedValue({ success: false, error: 'PRIVATE_PROVIDER_HTML' });
    const { result } = await send('Qual a temperatura?');
    expect(result.response.content).toContain('Não consegui consultar o tempo');
    expect(result.response.content).not.toMatch(/PRIVATE_PROVIDER|28,4 °C/);
  });

  it('does not intercept inactive, public, nonchannel or multimedia messages', async () => {
    for (const options of [
      { userId: 'default' },
      { channelIsPrivate: false },
      { source: 'web' },
      { attachments: [{ mimeType: 'image/png' }] },
    ]) {
      const { result, next } = await send('Temperatura', options);
      expect(result.response.content).toBe('normal-agent');
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(weather).not.toHaveBeenCalled();
  });

  it('keeps simultaneous customer requests scoped to their own saved cities', async () => {
    weather.mockImplementation(async (_name, _args, userId) => ({ success: true, result: {
      ...fact, city: userId.endsWith('1111') ? 'Ivinhema' : 'Corumbá',
    } }));
    const [one, two] = await Promise.all([
      send('Temperatura', { userId: 'whatsapp:556799991111' }),
      send('Temperatura', { userId: 'whatsapp:556799992222' }),
    ]);
    expect(one.result.response.content).toContain('Ivinhema');
    expect(one.result.response.content).not.toContain('Corumbá');
    expect(two.result.response.content).toContain('Corumbá');
    expect(two.result.response.content).not.toContain('Ivinhema');
  });
});
