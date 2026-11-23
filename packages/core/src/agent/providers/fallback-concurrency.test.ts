import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalError } from '../../types/errors.js';
import { err, ok, type Result } from '../../types/result.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ProviderConfig,
  StreamChunk,
} from '../types.js';

const mocks = vi.hoisted(() => ({ providers: new Map<string, unknown>() }));
vi.mock('../provider.js', () => ({
  createProvider: (config: ProviderConfig) => mocks.providers.get(config.id!),
}));
vi.mock('../../services/get-log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../debug.js', () => ({ logError: vi.fn(), logRetry: vi.fn() }));

import { FallbackProvider } from './fallback.js';

let sequence = 0;
const request: CompletionRequest = {
  messages: [{ id: 'user-1', role: 'user', content: 'Check my agenda' }],
  model: { model: 'primary-model' },
};
const completion = (content: string): CompletionResponse => ({
  id: 'response-1',
  content,
  model: 'test-model',
  createdAt: new Date(),
  finishReason: 'stop',
});
const limited = (retryAfterMs: number) =>
  Object.assign(new InternalError('Provider API error: 429 - quota exhausted'), { retryAfterMs });
function pendingCompletion() {
  let resolve: (result: Result<CompletionResponse, InternalError>) => void = () => {};
  const promise = new Promise<Result<CompletionResponse, InternalError>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(preferLastSuccessful = true) {
  const primary = {
    type: 'openai-compatible',
    isReady: () => true,
    complete: vi.fn<(_: CompletionRequest) => Promise<Result<CompletionResponse, InternalError>>>(
      async () => err(limited(1000))
    ),
    stream: vi.fn<(_: CompletionRequest) => AsyncGenerator<Result<StreamChunk, InternalError>>>(
      async function* () {
        yield err(limited(1000));
      }
    ),
  };
  const backup = {
    type: 'openai-compatible',
    isReady: () => true,
    complete: vi.fn<(_: CompletionRequest) => Promise<Result<CompletionResponse, InternalError>>>(
      async () => ok(completion('backup'))
    ),
    stream: vi.fn<(_: CompletionRequest) => AsyncGenerator<Result<StreamChunk, InternalError>>>(
      async function* () {
        yield ok({ id: 'backup-stream', content: 'backup', done: true });
      }
    ),
  };
  const config = {
    primary: {
      id: `concurrent-primary-${sequence}`,
      provider: 'openai-compatible',
      apiKey: `synthetic-${sequence}`,
      defaultModel: { model: 'primary-model' },
      timeout: 12_000,
    } as ProviderConfig,
    fallbacks: [
      {
        id: `concurrent-backup-${sequence}`,
        provider: 'openai-compatible',
        apiKey: `synthetic-backup-${sequence}`,
        defaultModel: { model: 'backup-model' },
        timeout: 12_000,
      } as ProviderConfig,
    ],
    sharedCircuitBreaker: true,
    preferLastSuccessful,
    circuitBreakerThreshold: 1,
    circuitBreakerCooldown: 60_000,
    completionTimeoutMs: 24_000,
  };
  mocks.providers.set(config.primary.id!, primary);
  mocks.providers.set(config.fallbacks[0]!.id!, backup);
  return { primary, backup, config, provider: new FallbackProvider(config) };
}

beforeEach(() => {
  sequence++;
  mocks.providers.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fallback health under concurrent requests', () => {
  it('does not open a remote circuit because local Groq concurrency is occupied', async () => {
    const { primary, provider, config } = setup();
    primary.complete.mockResolvedValueOnce(
      err(
        new InternalError(
          'Provider API error: 429 - Groq local admission concurrency. Please try again in 1s'
        )
      )
    );
    const first = await provider.complete(request);
    expect(first.ok && first.value.content).toBe('backup');
    primary.complete.mockResolvedValue(ok(completion('primary recovered')));
    const second = await new FallbackProvider(config).complete(request);
    expect(second.ok && second.value.content).toBe('primary recovered');
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });

  it('spreads simultaneous customer completions across healthy cloud routes and releases capacity', async () => {
    const { primary, backup, config } = setup(false);
    const balancedConfig = { ...config, balanceConcurrentLoad: true };
    const deferred = pendingCompletion();
    primary.complete
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue(ok(completion('primary')));
    const first = new FallbackProvider(balancedConfig).complete(request);
    await vi.advanceTimersByTimeAsync(0);
    const second = await new FallbackProvider(balancedConfig).complete(request);
    expect(second.ok && second.value.content).toBe('backup');
    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(backup.complete).toHaveBeenCalledTimes(1);
    deferred.resolve(ok(completion('primary')));
    expect((await first).ok).toBe(true);
    const third = await new FallbackProvider(balancedConfig).complete(request);
    expect(third.ok && third.value.content).toBe('primary');
  });

  it('does not let a success from an older in-flight request erase a newer quota cooldown', async () => {
    const { primary, provider, config } = setup();
    const old = pendingCompletion();
    primary.complete
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(err(limited(120_000)));
    const first = provider.complete(request);
    await vi.advanceTimersByTimeAsync(0);
    expect((await new FallbackProvider(config).complete(request)).ok).toBe(true);
    old.resolve(ok(completion('older success')));
    expect((await first).ok).toBe(true);
    primary.complete.mockResolvedValue(ok(completion('primary')));
    const third = await new FallbackProvider(config).complete(request);
    expect(third.ok && third.value.content).toBe('backup');
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });

  it('does not shorten a quota cooldown when another in-flight request fails transiently', async () => {
    const { primary, provider, config } = setup();
    const old = pendingCompletion();
    primary.complete
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(err(limited(120_000)));
    const first = provider.complete(request);
    await vi.advanceTimersByTimeAsync(0);
    expect((await new FallbackProvider(config).complete(request)).ok).toBe(true);
    old.resolve(err(new InternalError('Provider API error: 503 - temporarily unavailable')));
    expect((await first).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(16_000);
    primary.complete.mockResolvedValue(ok(completion('primary')));
    const third = await new FallbackProvider(config).complete(request);
    expect(third.ok && third.value.content).toBe('backup');
    expect(primary.complete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(104_001);
    const recovered = await new FallbackProvider(config).complete(request);
    expect(recovered.ok && recovered.value.content).toBe('primary');
    expect(primary.complete).toHaveBeenCalledTimes(3);
  });

  it('keeps only one recovery probe while a valid 12-second attempt is still running', async () => {
    const { primary, provider, config } = setup(false);
    await provider.complete(request);
    await vi.advanceTimersByTimeAsync(1000);
    const deferred = pendingCompletion();
    primary.complete
      .mockReset()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue(ok(completion('primary')));
    const probe = new FallbackProvider(config).complete(request);
    await vi.advanceTimersByTimeAsync(10_001);
    const concurrent = await new FallbackProvider(config).complete(request);
    const attemptCount = primary.complete.mock.calls.length;
    deferred.resolve(ok(completion('recovered')));
    await probe;
    expect(concurrent.ok && concurrent.value.content).toBe('backup');
    expect(attemptCount).toBe(1);
  });

  it('releases a cancelled recovery probe without making later callers wait for a lease timer', async () => {
    const { primary, provider, config } = setup();
    await provider.complete(request);
    await vi.advanceTimersByTimeAsync(1000);
    const deferred = pendingCompletion();
    primary.complete
      .mockReset()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue(ok(completion('recovered')));
    const controller = new AbortController();
    const probe = new FallbackProvider(config).complete({ ...request, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await probe).ok).toBe(false);
    deferred.resolve(err(new InternalError('Aborted')));
    const next = await new FallbackProvider(config).complete(request);
    expect(next.ok && next.value.content).toBe('recovered');
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });

  it('counts a 503 as an outage when its body also contains the number 400', async () => {
    const { primary, provider, config } = setup();
    primary.complete.mockResolvedValue(
      err(new InternalError('Provider API error: 503 - rejected batch of 400 tokens'))
    );
    await provider.complete(request);
    await new FallbackProvider(config).complete(request);
    expect(primary.complete).toHaveBeenCalledTimes(1);
  });

  it('closes a recovery circuit on a moderation refusal without trying the reserve', async () => {
    const { primary, backup, provider, config } = setup();
    await provider.complete(request);
    await vi.advanceTimersByTimeAsync(1000);
    primary.complete
      .mockResolvedValueOnce(ok({ ...completion(''), finishReason: 'content_filter' }))
      .mockResolvedValue(ok(completion('primary')));
    const refusal = await new FallbackProvider(config).complete({
      ...request,
      toolChoice: 'required',
    });
    expect(refusal.ok && refusal.value.finishReason).toBe('content_filter');
    const next = await new FallbackProvider(config).complete(request);
    expect(next.ok && next.value.content).toBe('primary');
    expect(backup.complete).toHaveBeenCalledTimes(1);
  });

  it('closes a successful stream probe even when the consumer stops at its terminal chunk', async () => {
    const { primary, provider, config } = setup();
    await provider.complete(request);
    await vi.advanceTimersByTimeAsync(1000);
    primary.stream.mockImplementation(async function* () {
      yield ok({ id: 'recovered', content: 'recovered', done: true });
    });
    for await (const result of new FallbackProvider(config).stream(request)) {
      if (result.ok && result.value.done) break;
    }
    const deferred = pendingCompletion();
    primary.complete
      .mockReset()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue(ok(completion('primary')));
    const first = new FallbackProvider(config).complete(request);
    await vi.advanceTimersByTimeAsync(0);
    const second = await new FallbackProvider(config).complete(request);
    deferred.resolve(ok(completion('primary')));
    expect((await first).ok).toBe(true);
    expect(second.ok && second.value.content).toBe('primary');
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });

  it.each(['return', 'timeout'])(
    'does not let an expired stream probe %s disturb a newer recovery attempt',
    async (mode) => {
      const { primary, provider, config } = setup();
      await provider.complete(request);
      await vi.advanceTimersByTimeAsync(1000);
      primary.stream.mockImplementation(async function* () {
        yield ok({ id: 'expired-probe', content: '', done: false });
        yield ok({ id: 'expired-probe', content: 'late response', done: true });
      });
      const expired = new FallbackProvider(config).stream(request);
      await expired.next();
      await vi.advanceTimersByTimeAsync(12_001);

      const deferred = pendingCompletion();
      primary.complete
        .mockReset()
        .mockImplementationOnce(() => deferred.promise)
        .mockResolvedValue(ok(completion('primary')));
      const recovery = new FallbackProvider(config).complete(request);
      await vi.advanceTimersByTimeAsync(0);
      if (mode === 'return') await expired.return();
      else {
        await expired.next();
        await expired.return();
      }
      const concurrent = await new FallbackProvider(config).complete(request);
      deferred.resolve(ok(completion('recovered')));
      const result = await recovery;
      expect(result.ok && result.value.content).toBe('recovered');
      expect(concurrent.ok && concurrent.value.content).toBe('backup');
      expect(primary.complete).toHaveBeenCalledTimes(1);
      const next = await new FallbackProvider(config).complete(request);
      expect(next.ok && next.value.content).toBe('primary');
    }
  );
});

describe('fallback after stream metadata', () => {
  it('can try a reserve after empty role or usage chunks without replaying output', async () => {
    const { provider, primary, backup } = setup();
    primary.stream.mockImplementation(async function* () {
      yield ok({ id: 'primary-stream', content: '', done: false });
      yield ok({
        id: 'primary-stream',
        usage: { promptTokens: 2, completionTokens: 0, totalTokens: 2 },
        done: false,
      });
      yield err(new InternalError('Provider stream error: 503 - unavailable'));
    });
    const chunks = await Array.fromAsync(provider.stream(request));
    expect(chunks.every((chunk) => chunk.ok)).toBe(true);
    expect(chunks.at(-1)).toEqual(ok({ id: 'backup-stream', content: 'backup', done: true }));
    expect(backup.stream).toHaveBeenCalledTimes(1);
  });

  it.each([
    { content: 'partial output' },
    { toolCalls: [{ id: 'tool-1', name: 'add_task', arguments: '' }] },
    { toolCalls: [{ arguments: '{"title":' }] },
  ])('does not replay after a response delta: %j', async (delta) => {
    const { provider, primary, backup } = setup();
    primary.stream.mockImplementation(async function* () {
      yield ok({ id: 'primary-stream', ...delta, done: false });
      yield err(new InternalError('Provider stream error: 503 - unavailable'));
    });
    const chunks = await Array.fromAsync(provider.stream(request));
    expect(chunks.at(-1)?.ok).toBe(false);
    expect(backup.stream).not.toHaveBeenCalled();
  });

  it('preserves an empty terminal moderation refusal without trying a reserve', async () => {
    const { provider, primary, backup } = setup();
    primary.stream.mockImplementation(async function* () {
      yield ok({ id: 'refusal', done: true, finishReason: 'content_filter' });
    });
    const chunks = await Array.fromAsync(provider.stream(request));
    expect(chunks).toEqual([ok({ id: 'refusal', done: true, finishReason: 'content_filter' })]);
    expect(backup.stream).not.toHaveBeenCalled();
  });
});

describe('provider cancellation', () => {
  it.each(['result', 'throw'])(
    'stops a cancelled completion (%s) without poisoning provider health',
    async (mode) => {
      const { provider, primary, backup, config } = setup();
      const cancelled = Object.assign(new InternalError('Request cancelled'), {
        name: 'AbortError',
      });
      primary.complete
        .mockImplementationOnce(async () => {
          if (mode === 'throw') throw cancelled;
          return err(cancelled);
        })
        .mockResolvedValue(ok(completion('primary')));
      expect((await provider.complete(request)).ok).toBe(false);
      expect(backup.complete).not.toHaveBeenCalled();
      const next = await new FallbackProvider(config).complete(request);
      expect(next.ok && next.value.content).toBe('primary');
    }
  );

  it.each(['result', 'throw'])(
    'stops a cancelled stream (%s) without poisoning provider health',
    async (mode) => {
      const { provider, primary, backup, config } = setup();
      const cancelled = Object.assign(new InternalError('Request cancelled'), {
        name: 'AbortError',
      });
      primary.stream
        .mockImplementationOnce(async function* () {
          if (mode === 'throw') throw cancelled;
          yield err(cancelled);
        })
        .mockImplementation(async function* () {
          yield ok({ id: 'primary', content: 'primary', done: true });
        });
      const chunks = await Array.fromAsync(provider.stream(request));
      expect(chunks.at(-1)?.ok).toBe(false);
      expect(backup.stream).not.toHaveBeenCalled();
      const next = await Array.fromAsync(new FallbackProvider(config).stream(request));
      expect(next).toEqual([ok({ id: 'primary', content: 'primary', done: true })]);
    }
  );
});
