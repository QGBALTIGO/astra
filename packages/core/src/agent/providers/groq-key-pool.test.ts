import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionRequest } from '../types.js';
import type { ResolvedProviderConfig } from './configs/types.js';
import { fetchGroqPool, groqPoolKeys, groqPoolRead, groqRetryDelayMs } from './groq-key-pool.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { createProvider } from '../provider.js';
import { FallbackProvider, providerCooldownMs } from './fallback.js';

vi.mock('../tools/dynamic-tool-permissions.js', () => ({ isPrivateUrlAsync: async () => false }));
let round = 0;
let keys: string[];
const request = (model = 'model-a'): CompletionRequest => ({
  messages: [{ role: 'user', content: 'Conferir agenda' }],
  model: { model },
});
const config = (patch: Partial<ResolvedProviderConfig> = {}): ResolvedProviderConfig => ({
  id: 'groq',
  name: 'Groq',
  type: 'openai',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: keys[0],
  models: [],
  timeout: 500,
  maxRetries: 0,
  features: { streaming: true, toolUse: true, vision: false, jsonMode: true, systemMessage: true },
  ...patch,
});
const success = (content = 'Olá') =>
  Response.json({ id: 'reply', choices: [{ message: { content }, finish_reason: 'stop' }] });
const failure = (
  status: number,
  headers: Record<string, string> = {},
  text = 'provider unavailable'
) => new Response(text, { status, headers });
const authorization = (mock: ReturnType<typeof vi.fn>, index: number) =>
  new Headers(mock.mock.calls[index]![1].headers).get('authorization');
const body = (mock: ReturnType<typeof vi.fn>, index: number) =>
  JSON.parse(mock.mock.calls[index]![1].body as string);
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const independentOrganizations = () =>
  vi.stubEnv(
    'GROQ_QUOTA_GROUPS',
    JSON.stringify({
      GROQ_API_KEY: `test-${round}-a`,
      GROQ_API_KEY_2: `test-${round}-b`,
    })
  );
const sse = (content: string) =>
  'data: ' + JSON.stringify({ id: 'reply', choices: [{ delta: { content } }] }) + '\n\n';

beforeEach(() => {
  round++;
  keys = ['a', 'b', 'c', 'd', 'e'].map((suffix) => `synthetic-${round}-${suffix}`);
  vi.stubEnv('GROQ_API_KEY', keys[0]!);
  vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '');
  vi.stubEnv('GROQ_QUOTA_GROUPS', '');
  for (let n = 2; n <= 11; n++)
    vi.stubEnv('GROQ_API_KEY_' + n, n <= keys.length ? keys[n - 1]! : '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('operator credential boundary and retry hints', () => {
  it('deduplicates trimmed credentials and considers at most env suffix10', () => {
    const env = {
      GROQ_API_KEY: ' a ',
      GROQ_API_KEY_2: 'a',
      GROQ_API_KEY_3: ' b ',
      GROQ_API_KEY_10: 'c',
      GROQ_API_KEY_11: 'never-use',
    };
    expect(
      groqPoolKeys(
        {
          providerId: 'groq',
          baseUrl: 'https://api.groq.com/openai/v1/',
          authorization: 'Bearer a',
        },
        env
      )
    ).toEqual(['a', 'b', 'c']);
  });
  it.each([
    { providerId: 'openai' },
    { providerId: 'openrouter' },
    { authorization: 'Bearer tenant-key' },
    { baseUrl: 'https://proxy.example/openai/v1' },
    { baseUrl: 'http://api.groq.com/openai/v1' },
    { baseUrl: 'https://api.groq.com.evil.example/openai/v1' },
    { baseUrl: 'https://api.groq.com:444/openai/v1' },
    { baseUrl: 'https://api.groq.com/other/v1' },
    { baseUrl: 'https://api.groq.com/openai/v1?proxy=x' },
    { baseUrl: 'https://user@api.groq.com/openai/v1' },
    { endpoint: '/custom/completions' },
  ])('does not expose global extra keys outside the exact operator Groq scope: %j', (patch) => {
    expect(
      groqPoolKeys({
        providerId: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        authorization: 'Bearer ' + keys[0],
        ...patch,
      })
    ).toBeNull();
  });
  it('also admits a single distinct operator key through the bounded transport', () => {
    expect(
      groqPoolKeys(
        {
          providerId: 'groq',
          baseUrl: 'https://api.groq.com/openai/v1',
          authorization: 'Bearer a',
        },
        { GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'a' }
      )
    ).toEqual(['a']);
  });
  it('honors Retry-After dates, long durations, reset headers and body hints', () => {
    expect(groqRetryDelayMs(new Headers({ 'Retry-After': '120' }), '')).toBe(120_100);
    const now = Date.parse('2026-11-17T20:00:00Z');
    expect(
      groqRetryDelayMs(new Headers({ 'Retry-After': 'Tue, 17 Nov 2026 20:01:00 GMT' }), '', now)
    ).toBe(60_100);
    expect(
      groqRetryDelayMs(
        new Headers({
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-tokens': '2m59.56s',
        }),
        ''
      )
    ).toBe(179_660);
    expect(groqRetryDelayMs(new Headers(), 'Please try again in 4.6425s')).toBe(4_742.5);
  });
});

describe('bounded Groq pool transport', () => {
  it('rejects an oversized opt-in request before using quota and leaves a later small request healthy', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '8000');
    const fetch = vi.fn().mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetch);
    const provider = new OpenAICompatibleProvider(config());
    const large = {
      ...request(),
      messages: [{ role: 'user' as const, content: 'x'.repeat(40_000) }],
    };
    const response = await provider.complete(large);
    expect(response.ok).toBe(false);
    if (!response.ok)
      expect(response.error.message).toContain('413 - request_too_large: groq_local_admission');
    expect(fetch).not.toHaveBeenCalled();
    expect((await provider.complete(request())).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fits the default output reserve inside the total budget without refusing a valid request', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '8000');
    const fetch = vi.fn().mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetch);
    expect(
      (
        await new OpenAICompatibleProvider(config()).complete({
          ...request(),
          model: { model: 'model-a', maxTokens: 8192 },
        })
      ).ok
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = body(fetch, 0);
    expect(sent.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(sent.max_tokens).toBeLessThan(8000);
    expect(
      Math.ceil(Buffer.byteLength(fetch.mock.calls[0]![1].body) / 4) + sent.max_tokens
    ).toBeLessThanOrEqual(8000);
  });
  it('rejects context without a useful response allowance before credentials or admission hooks are used', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '8000');
    const fetch = vi.fn();
    const beforeFetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const original = JSON.stringify({
      messages: [{ role: 'user', content: 'x'.repeat(30_800) }],
      max_completion_tokens: 8192,
    });
    const result = await fetchGroqPool({
      keys,
      model: 'model-a',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      options: { body: original },
      controller,
      timeoutMs: 500,
      beforeFetch,
    });
    expect(result.response.status).toBe(413);
    expect(result.errorText).toContain('groq_local_admission');
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeFetch).not.toHaveBeenCalled();
    expect(result.signal).toBe(controller.signal);
  });
  it('uses the same bounded completion allowance across independently budgeted retry credentials', async () => {
    independentOrganizations();
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '8000');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failure(429, { 'Retry-After': '30' }))
      .mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetch);
    const original = JSON.stringify({
      messages: [{ role: 'user', content: 'Agenda '.repeat(900) }],
      max_completion_tokens: 8192,
    });
    const result = await fetchGroqPool({
      keys,
      model: 'budget-retry',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      options: {
        body: original,
        headers: { 'Content-Length': String(Buffer.byteLength(original)) },
      },
      controller: new AbortController(),
      timeoutMs: 500,
    });
    expect(result.response.ok).toBe(true);
    result.finish();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body(fetch, 0)).toEqual(body(fetch, 1));
    expect(body(fetch, 0).max_completion_tokens).toBeGreaterThanOrEqual(1024);
    expect(body(fetch, 0).max_completion_tokens).toBeLessThan(8192);
    expect(body(fetch, 0)).not.toHaveProperty('max_tokens');
    expect(new Headers(fetch.mock.calls[0]![1].headers).has('content-length')).toBe(false);
    expect(authorization(fetch, 0)).not.toBe(authorization(fetch, 1));
  });
  it('does not start a budgeted request that was already cancelled', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '8000');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchGroqPool({
        keys,
        model: 'cancelled-budget',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        options: { body: JSON.stringify({ messages: [], max_tokens: 8192 }) },
        controller,
        timeoutMs: 500,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps a budgeted SSE request complete while preserving the streaming contract', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '8000');
    const ending =
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n';
    const fetch = vi.fn(
      async () =>
        new Response(sse('Bom dia, sua agenda está livre.') + ending + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
    );
    vi.stubGlobal('fetch', fetch);
    const output = [];
    for await (const chunk of new OpenAICompatibleProvider(config()).stream({
      ...request(),
      model: { model: 'model-a', maxTokens: 8192 },
    }))
      output.push(chunk);
    expect(output.some((chunk) => chunk.ok && chunk.value.content?.includes('Bom dia'))).toBe(true);
    expect(
      output.some((chunk) => chunk.ok && chunk.value.done && chunk.value.finishReason === 'stop')
    ).toBe(true);
    const sent = body(fetch, 0);
    expect(sent.stream).toBe(true);
    expect(sent.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(sent.max_tokens).toBeLessThan(8192);
    expect(
      Math.ceil(Buffer.byteLength(fetch.mock.calls[0]![1].body) / 4) + sent.max_tokens
    ).toBeLessThanOrEqual(8000);
    expect(output.every((chunk) => chunk.ok)).toBe(true);
  });
  it('bounds the operator by default without applying its budget to tenant-owned credentials', async () => {
    const fetch = vi.fn().mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetch);
    const large = {
      ...request(),
      messages: [{ role: 'user' as const, content: 'x'.repeat(40_000) }],
    };
    expect((await new OpenAICompatibleProvider(config()).complete(large)).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '1');
    expect(
      (await new OpenAICompatibleProvider(config({ apiKey: 'tenant-owned-key' })).complete(large))
        .ok
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('passes an oversized original request intact to the real fallback without contacting Groq', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '8000');
    const originalText = 'x'.repeat(40_000);
    const fetch = vi.fn().mockImplementation(async (url) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
      return success('Reserva atendeu');
    });
    vi.stubGlobal('fetch', fetch);
    const provider = new FallbackProvider({
      primary: { provider: 'groq', apiKey: keys[0], maxRetries: 0, timeout: 500 },
      fallbacks: [
        {
          provider: 'openai-compatible',
          id: 'openrouter',
          apiKey: 'synthetic-router',
          baseUrl: 'https://openrouter.ai/api/v1',
          maxRetries: 0,
          timeout: 500,
          defaultModel: { model: 'openrouter/free' },
        },
      ],
      sharedCircuitBreaker: true,
      preferLastSuccessful: false,
    });
    expect(
      (
        await provider.complete({
          ...request(),
          messages: [{ role: 'user', content: originalText }],
        })
      ).ok
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body(fetch, 0).messages[0].content).toBe(originalText);
  });
  it('observes a pending body rejection even if cancellation already happened', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      groqPoolRead(Promise.reject(new Error('body closed')), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
  });
  it('rotates on429 only when keys belong to explicitly distinct organizations', async () => {
    independentOrganizations();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failure(429, { 'Retry-After': '3600' }))
      .mockResolvedValueOnce(success('recuperado'));
    vi.stubGlobal('fetch', fetch);
    const result = await new OpenAICompatibleProvider(config()).complete(request());
    expect(result.ok && result.value.content).toBe('recuperado');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(authorization(fetch, 0)).toBe('Bearer ' + keys[0]);
    expect(authorization(fetch, 1)).toBe('Bearer ' + keys[1]);
    expect(body(fetch, 1)).toEqual(body(fetch, 0));
    expect(fetch.mock.calls[1]![1].redirect).toBe('error');
  });
  it('shares per-model cooldown between new provider instances while other models remain usable', async () => {
    const fetch = vi.fn().mockImplementation(async () => failure(429, { 'Retry-After': '3600' }));
    vi.stubGlobal('fetch', fetch);
    expect((await new OpenAICompatibleProvider(config()).complete(request())).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await new OpenAICompatibleProvider(config()).complete(request())).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => success());
    expect((await new OpenAICompatibleProvider(config()).complete(request('model-b'))).ok).toBe(
      true
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('releases rate-limited credentials only after their provider-directed reset', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => failure(429, { 'Retry-After': '60' }));
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatibleProvider(config()).complete(request());
    await vi.advanceTimersByTimeAsync(60_000);
    await new OpenAICompatibleProvider(config()).complete(request());
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(101);
    fetch.mockImplementation(async () => success());
    expect((await new OpenAICompatibleProvider(config()).complete(request())).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('communicates the next pool reset to fallback without a five-minute cooldown', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => failure(429, { 'Retry-After': '2' }));
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatibleProvider(config()).complete(request());
    const blocked = await new OpenAICompatibleProvider(config()).complete(request());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.message).toContain('Please try again in 3s');
      // The pool's explicit Retry-After takes precedence over the body-only hint margin.
      expect(blocked.error).toHaveProperty('retryAfterMs', 3_000);
      expect(providerCooldownMs(blocked.error, 300_000)).toBe(3_000);
    }
  });
  it.each(['completion', 'stream'] as const)(
    'keeps the longer token reset when Retry-After is shorter for %s',
    async (mode) => {
      const fetch = vi.fn().mockResolvedValue(
        failure(429, {
          'Retry-After': '1',
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-tokens': '2m',
        })
      );
      vi.stubGlobal('fetch', fetch);
      const provider = new OpenAICompatibleProvider(config());
      const result =
        mode === 'completion'
          ? await provider.complete(request())
          : await (async () => {
              let last;
              for await (const value of provider.stream(request())) last = value;
              return last;
            })();
      expect(result?.ok).toBe(false);
      if (result && !result.ok) {
        expect(result.error).toHaveProperty('retryAfterMs', 120_100);
        expect(providerCooldownMs(result.error, 300_000)).toBe(120_100);
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
  it('deduplicates the actual attempts when several env suffixes contain the same key', async () => {
    for (let n = 2; n <= 10; n++) vi.stubEnv('GROQ_API_KEY_' + n, n === 2 ? keys[1]! : keys[0]!);
    const fetch = vi.fn().mockImplementation(async () => failure(429));
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatibleProvider(config()).complete(request());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403])(
    'temporarily disables an invalid credential across models after%s',
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(failure(status))
        .mockImplementation(async () => success());
      vi.stubGlobal('fetch', fetch);
      expect((await new OpenAICompatibleProvider(config()).complete(request())).ok).toBe(true);
      expect((await new OpenAICompatibleProvider(config()).complete(request('model-b'))).ok).toBe(
        true
      );
      expect(authorization(fetch, 2)).not.toBe('Bearer ' + keys[0]);
    }
  );
  it('allows an auth-disabled credential again after the temporary five-minute cooldown', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failure(401))
      .mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatibleProvider(config()).complete(request());
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await new OpenAICompatibleProvider(config()).complete(request('new-model'));
    expect(authorization(fetch, 2)).toBe('Bearer ' + keys[0]);
  });
  it.each(['500', 'network'])(
    'degrades a transient%s key and tries another distinct key',
    async (cause) => {
      const fetch = vi
        .fn()
        .mockImplementationOnce(async () => {
          if (cause === 'network') throw new Error('network ' + keys[0]);
          return failure(500);
        })
        .mockImplementation(async () => success());
      vi.stubGlobal('fetch', fetch);
      expect((await new OpenAICompatibleProvider(config()).complete(request())).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(authorization(fetch, 0)).not.toBe(authorization(fetch, 1));
    }
  );
  it('does not rotate a bad request or retry a schema/tool contract error', async () => {
    const fetch = vi.fn().mockResolvedValue(failure(400));
    vi.stubGlobal('fetch', fetch);
    expect((await new OpenAICompatibleProvider(config()).complete(request())).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reserves credentials before await and balances concurrent requests on one instance', async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi
      .fn()
      .mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal('fetch', fetch);
    const provider = new OpenAICompatibleProvider(config());
    const results = [
      provider.complete(request()),
      provider.complete(request()),
      provider.complete(request()),
    ];
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set([0, 1, 2].map((index) => authorization(fetch, index))).size).toBe(3);
    pending.forEach((resolve) => resolve(success()));
    expect((await Promise.all(results)).every((result) => result.ok)).toBe(true);
  });
  it('holds in-flight leases until the body completes, not only until headers arrive', async () => {
    const enc = new TextEncoder();
    let finishBody!: () => void;
    const waitingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        finishBody = () => {
          controller.enqueue(
            enc.encode(JSON.stringify({ choices: [{ message: { content: 'first' } }] }))
          );
          controller.close();
        };
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(waitingBody))
      .mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetch);
    const first = new OpenAICompatibleProvider(config()).complete(request());
    await tick();
    const second = await new OpenAICompatibleProvider(config()).complete(request());
    expect(second.ok).toBe(true);
    expect(authorization(fetch, 1)).not.toBe(authorization(fetch, 0));
    finishBody();
    expect((await first).ok).toBe(true);
  });
  it('bounds the whole sequence by one deadline even when fetch ignores abort', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const result = new OpenAICompatibleProvider(config({ timeout: 50 })).complete(request());
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(51);
    const response = await result;
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('TIMEOUT');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not reset the overall deadline when rotating after a slow429', async () => {
    independentOrganizations();
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => setTimeout(() => resolve(failure(429)), 40))
      )
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const result = new OpenAICompatibleProvider(config({ timeout: 50 })).complete(request());
    await tick();
    await vi.advanceTimersByTimeAsync(51);
    expect((await result).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps the deadline active during stalled JSON consumption', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream())));
    const result = new OpenAICompatibleProvider(config({ timeout: 30 })).complete(request());
    await tick();
    await vi.advanceTimersByTimeAsync(31);
    expect((await result).ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels all concurrent pooled requests in this instance without rotating or cancelling another instance', async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi
      .fn()
      .mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal('fetch', fetch);
    const provider = new OpenAICompatibleProvider(config());
    const results = [provider.complete(request()), provider.complete(request())];
    const independent = new OpenAICompatibleProvider(config()).complete(request());
    await tick();
    provider.cancel();
    expect((await Promise.all(results)).every((result) => !result.ok)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    pending[2]!(success());
    expect((await independent).ok).toBe(true);
  });
  it.each(['completion', 'stream'] as const)(
    'releases only the cancelled caller quota lease while another %s body remains active',
    async (mode) => {
      vi.useFakeTimers();
      vi.stubEnv('GROQ_MAX_CONCURRENT_REQUESTS', '2');
      const encoder = new TextEncoder();
      const bodies = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
      const signals = new Map<string, AbortSignal>();
      const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
        const id = JSON.parse(String(options.body)).messages[0].content as string;
        signals.set(id, options.signal as AbortSignal);
        if (id === 'replacement')
          return mode === 'completion' ? success() : new Response('data: [DONE]\n\n');
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodies.set(id, controller);
            },
          })
        );
      });
      vi.stubGlobal('fetch', fetch);
      const provider = new OpenAICompatibleProvider(config());
      const run = (id: string, signal?: AbortSignal) => {
        const input: CompletionRequest = {
          ...request(),
          messages: [{ role: 'user', content: id }],
          model: { model: 'model-a', maxTokens: 64 },
          signal,
        };
        return mode === 'completion'
          ? provider.complete(input)
          : (async () => {
              let last;
              for await (const value of provider.stream(input)) last = value;
              return last;
            })();
      };
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = run('first', firstController.signal);
      const second = run('second', secondController.signal);
      try {
        await tick();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect((await run('blocked'))?.ok).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(2);

        firstController.abort();
        expect((await first)?.ok).toBe(false);
        expect(signals.get('first')?.aborted).toBe(true);
        expect(signals.get('second')?.aborted).toBe(false);
        expect((await run('replacement'))?.ok).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(3);

        const secondBody = bodies.get('second')!;
        secondBody.enqueue(
          encoder.encode(
            mode === 'completion'
              ? JSON.stringify({ choices: [{ message: { content: 'second reply' } }] })
              : 'data: [DONE]\n\n'
          )
        );
        secondBody.close();
        expect((await second)?.ok).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        firstController.abort();
        secondController.abort();
        await Promise.allSettled([first, second]);
      }
    }
  );
  it('honors cancellation before DNS validation finishes without issuing a request', async () => {
    const fetch = vi.fn().mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetch);
    const provider = new OpenAICompatibleProvider(config());
    const result = provider.complete(request());
    provider.cancel();
    expect((await result).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails a finite all-network outage without exposing a credential or leaving timers', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(new Error('socket failure ' + keys.join(',')));
    vi.stubGlobal('fetch', fetch);
    const response = await new OpenAICompatibleProvider(config()).complete(request());
    expect(response.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
    if (!response.ok) for (const key of keys) expect(response.error.message).not.toContain(key);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('redacts all operator keys from returned provider errors', async () => {
    const fetch = vi.fn().mockImplementation(async () => failure(429, {}, keys.join(' ')));
    vi.stubGlobal('fetch', fetch);
    const result = await new OpenAICompatibleProvider(config()).complete(request());
    expect(result.ok).toBe(false);
    if (!result.ok) for (const key of keys) expect(result.error.message).not.toContain(key);
  });
  it('reuses the exact tool-result body and never invokes a tool while rotating', async () => {
    independentOrganizations();
    const fetch = vi.fn().mockResolvedValueOnce(failure(429)).mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatibleProvider(config()).complete({
      ...request(),
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tool-a', name: 'core.list_tasks', arguments: '{}' }],
        },
        {
          role: 'tool',
          content: '',
          toolResults: [{ toolCallId: 'tool-a', content: '{"tasks":[]}' }],
        },
      ],
    });
    expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body);
    expect(body(fetch, 1).messages[1].tool_call_id).toBe('tool-a');
  });
});

describe('streaming and privacy boundaries', () => {
  it('routes the native Groq factory through the real pool and preserves OSS latency controls', async () => {
    independentOrganizations();
    const fetch = vi.fn().mockResolvedValueOnce(failure(429)).mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetch);
    const provider = createProvider({
      provider: 'groq',
      apiKey: keys[0],
      maxRetries: 0,
      timeout: 500,
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(
      (
        await provider.complete({
          ...request('openai/gpt-oss-20b'),
          model: { model: 'openai/gpt-oss-20b', maxTokens: 700 },
        })
      ).ok
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(body(fetch, 0)).toMatchObject({
      include_reasoning: false,
      reasoning_effort: 'low',
      max_tokens: 700,
    });
  });
  it('can rotate an HTTP429 to a distinct organization before streaming begins', async () => {
    independentOrganizations();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failure(429))
      .mockResolvedValueOnce(new Response(sse('ok') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    const values = [];
    for await (const value of new OpenAICompatibleProvider(config()).stream(request()))
      values.push(value);
    expect(values.some((value) => value.ok && value.value.content === 'ok')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { content: 'partial' },
    { reasoning_content: 'thinking' },
    {
      tool_calls: [
        { index: 0, id: 'tool-a', function: { name: 'core__list_tasks', arguments: '{' } },
      ],
    },
  ])('never replays a stream after a content/reasoning/tool chunk %j', async (delta) => {
    const enc = new TextEncoder();
    let fail!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n')
        );
        fail = () => controller.error(new Error('socket closed'));
      },
    });
    const fetch = vi.fn().mockResolvedValue(new Response(stream));
    vi.stubGlobal('fetch', fetch);
    const generator = new OpenAICompatibleProvider(config()).stream(request());
    expect((await generator.next()).value?.ok).toBe(true);
    fail();
    expect((await generator.next()).value?.ok).toBe(false);
    await generator.return();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds a stream that stalls after its first chunk and never retries it', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse('partial')));
          },
        })
      )
    );
    vi.stubGlobal('fetch', fetch);
    const generator = new OpenAICompatibleProvider(config({ timeout: 30 })).stream(request());
    expect((await generator.next()).value?.ok).toBe(true);
    const next = generator.next();
    await vi.advanceTimersByTimeAsync(31);
    expect((await next).value?.ok).toBe(false);
    await generator.return();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not pool effective auth overrides or a custom Groq tenant credential', async () => {
    const fetch = vi.fn().mockImplementation(async () => failure(429));
    vi.stubGlobal('fetch', fetch);
    for (const patch of [
      { apiKey: 'tenant-key' },
      { headers: { Authorization: 'Bearer tenant-key' } },
      { resolvedAuth: { method: 'api_key' as const, value: 'tenant-key' } },
    ]) {
      await new OpenAICompatibleProvider(config(patch)).complete(request());
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) expect(authorization(fetch, i)).toBe('Bearer tenant-key');
  });
  it.each([false, true])(
    'adds OpenRouter privacy only to the official endpoint, stream=%s',
    async (stream) => {
      const fetch = vi
        .fn()
        .mockImplementation(async () => (stream ? new Response('data: [DONE]\n\n') : success()));
      vi.stubGlobal('fetch', fetch);
      for (const patch of [
        { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
        { id: 'openrouter', baseUrl: 'https://custom.example/api/v1' },
        { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1' },
      ]) {
        const provider = new OpenAICompatibleProvider(config(patch));
        if (stream) {
          for await (const _value of provider.stream(request())) {
            /* drain */
          }
        } else await provider.complete(request());
      }
      expect(body(fetch, 0).provider).toEqual({
        data_collection: 'deny',
        require_parameters: true,
      });
      expect(body(fetch, 1).provider).toBeUndefined();
      expect(body(fetch, 2).provider).toBeUndefined();
    }
  );
  it('retains legacy single-key maxRetries0 behavior', async () => {
    for (let n = 2; n <= 10; n++) vi.stubEnv('GROQ_API_KEY_' + n, keys[0]!);
    const fetch = vi.fn().mockResolvedValue(failure(429));
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatibleProvider(config()).complete(request());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
