import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { InternalError } from '../../types/errors.js';
import { ok, err } from '../../types/result.js';
import type { ProviderConfig, CompletionRequest } from '../types.js';
const mocks = vi.hoisted(() => ({ providers: new Map<string, unknown>() }));
vi.mock('../provider.js', () => ({
  createProvider: (config: { id: string }) => mocks.providers.get(config.id),
}));
vi.mock('../../services/get-log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../debug.js', () => ({ logError: vi.fn(), logRetry: vi.fn() }));
import { FallbackProvider, providerCooldownMs } from './fallback.js';
let caseId = 0;
const request = { messages: [], model: { model: 'test' } } as unknown as CompletionRequest;
beforeEach(() => {
  mocks.providers.clear();
  caseId++;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(extra: Record<string, unknown> = {}) {
  const primary = {
    type: 'openai',
    isReady: () => true,
    complete: vi.fn(async () =>
      err(new InternalError('429 tokens per day TPD. Please try again in 2m30s'))
    ),
  };
  const backup = {
    type: 'openai',
    isReady: () => true,
    complete: vi.fn(async (_request?: CompletionRequest) =>
      ok({ content: 'Resposta da IA', usage: {} })
    ),
  };
  mocks.providers.set('primary' + caseId, primary);
  mocks.providers.set('backup' + caseId, backup);
  const config = {
    primary: {
      id: 'primary' + caseId,
      provider: 'openai',
      apiKey: 'fake-key-' + caseId,
      defaultModel: { model: 'primary' },
      timeout: 40,
    } as ProviderConfig,
    fallbacks: [
      {
        id: 'backup' + caseId,
        provider: 'openai',
        apiKey: 'fake-backup-' + caseId,
        defaultModel: { model: 'backup' },
        timeout: 40,
      } as ProviderConfig,
    ],
    sharedCircuitBreaker: true,
    preferLastSuccessful: true,
    circuitBreakerThreshold: 1,
    circuitBreakerCooldown: 60000,
    ...extra,
  };
  return { primary, backup, config, provider: new FallbackProvider(config) };
}
describe('opt-in channel fallback latency', () => {
  it('keeps the healthy model after a normal pause instead of replaying exhausted providers', async () => {
    vi.useFakeTimers();
    const { provider, config, primary, backup } = setup();
    await provider.complete(request);
    vi.setSystemTime(Date.now() + 6 * 60000);
    await new FallbackProvider(config).complete(request);
    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(backup.complete).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 61 * 60000);
    await new FallbackProvider(config).complete(request);
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });
  it('tries another model when a required live lookup receives only invented prose', async () => {
    const { provider, primary, backup } = setup();
    primary.complete.mockResolvedValue(ok({ content: 'The temperature is 30 C' }) as never);
    backup.complete.mockResolvedValue(
      ok({ content: '', toolCalls: [{ id: 'lookup', name: 'weather', arguments: '{}' }] }) as never
    );
    const result = await provider.complete({ ...request, toolChoice: 'required' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.toolCalls?.[0]?.name).toBe('weather');
    expect(backup.complete).toHaveBeenCalledTimes(1);
  });
  it('shares an exhausted model cooldown between customer agents', async () => {
    const { provider, config, primary, backup } = setup();
    await provider.complete(request);
    await new FallbackProvider(config).complete(request);
    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(backup.complete).toHaveBeenCalledTimes(2);
  });
  it('keeps separate credentials out of each other’s circuits', async () => {
    const { provider, config, primary } = setup();
    await provider.complete(request);
    await new FallbackProvider({
      ...config,
      primary: { ...config.primary, apiKey: 'different-key' },
    }).complete(request);
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });
  it('prefers the last healthy model while the primary recovers', async () => {
    let now = 100000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { provider, config, primary } = setup();
    await provider.complete(request);
    now += 152000;
    await new FallbackProvider(config).complete(request);
    expect(primary.complete).toHaveBeenCalledTimes(1);
  });
  it('sends the backup model after changing preference order', async () => {
    const { provider, config, backup } = setup();
    await provider.complete(request);
    await new FallbackProvider(config).complete(request);
    expect(backup.complete.mock.calls.at(-1)?.[0]?.model.model).toBe('backup');
  });
  it('does not enable shared state by default', async () => {
    const { primary, config } = setup({ sharedCircuitBreaker: false, preferLastSuccessful: false });
    await new FallbackProvider(config).complete(request);
    await new FallbackProvider(config).complete(request);
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });
  it('moves to a healthy backup when a transport hangs', async () => {
    vi.useFakeTimers();
    const { provider, primary, backup } = setup({ completionTimeoutMs: 120 });
    primary.complete.mockImplementation(() => new Promise(() => {}));
    const pending = provider.complete(request);
    await vi.advanceTimersByTimeAsync(40);
    expect((await pending).ok).toBe(true);
    expect(backup.complete).toHaveBeenCalledTimes(1);
  });
  it('bounds the whole chain instead of adding every provider timeout', async () => {
    vi.useFakeTimers();
    const { provider, primary, backup, config } = setup({ completionTimeoutMs: 70 });
    primary.complete.mockImplementation(() => new Promise(() => {}));
    backup.complete.mockImplementation(() => new Promise(() => {}));
    const pending = provider.complete(request);
    await vi.advanceTimersByTimeAsync(70);
    expect((await pending).ok).toBe(false);
    expect(config.primary.timeout).toBe(40);
  });
  it('honors short minute-limit recovery without imposing an outage cooldown', () =>
    expect(providerCooldownMs(new Error('429 Please try again in 2.9s'), 300000)).toBe(3900));
  it('keeps daily token limits out of the retry loop for the reported period', () =>
    expect(providerCooldownMs(new Error('429 TPD Please try again in 21m48.528s'), 60000)).toBe(
      1309528
    ));
});
