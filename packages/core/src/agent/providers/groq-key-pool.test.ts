import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionRequest } from '../types.js';
import type { ResolvedProviderConfig } from './configs/types.js';
import { groqPoolKeys, groqPoolRead, groqRetryDelayMs } from './groq-key-pool.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { createProvider } from '../provider.js';
import { providerCooldownMs } from './fallback.js';

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
const sse = (content: string) =>
  'data: ' + JSON.stringify({ id: 'reply', choices: [{ delta: { content } }] }) + '\n\n';

beforeEach(() => {
  round++;
  keys = ['a', 'b', 'c', 'd', 'e'].map((suffix) => `synthetic-${round}-${suffix}`);
  vi.stubEnv('GROQ_API_KEY', keys[0]!);
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
  it('leaves a single distinct key on the unchanged legacy transport', () => {
    expect(
      groqPoolKeys(
        {
          providerId: 'groq',
          baseUrl: 'https://api.groq.com/openai/v1',
          authorization: 'Bearer a',
        },
        { GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'a' }
      )
    ).toBeNull();
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
  it('observes a pending body rejection even if cancellation already happened', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      groqPoolRead(Promise.reject(new Error('body closed')), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
  });
  it('rotates on429 without waiting or repeating a key, even when maxRetries is zero', async () => {
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
    expect(fetch).toHaveBeenCalledTimes(5);
    expect((await new OpenAICompatibleProvider(config()).complete(request())).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(5);
    fetch.mockImplementation(async () => success());
    expect((await new OpenAICompatibleProvider(config()).complete(request('model-b'))).ok).toBe(
      true
    );
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('releases rate-limited credentials only after their provider-directed reset', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => failure(429, { 'Retry-After': '60' }));
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatibleProvider(config()).complete(request());
    await vi.advanceTimersByTimeAsync(60_000);
    await new OpenAICompatibleProvider(config()).complete(request());
    expect(fetch).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(101);
    fetch.mockImplementation(async () => success());
    expect((await new OpenAICompatibleProvider(config()).complete(request())).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('communicates the next pool reset to fallback without a five-minute cooldown', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => failure(429, { 'Retry-After': '2' }));
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatibleProvider(config()).complete(request());
    const blocked = await new OpenAICompatibleProvider(config()).complete(request());
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.message).toContain('Please try again in 3s');
      expect(providerCooldownMs(blocked.error, 300_000)).toBe(4_000);
    }
  });
  it('deduplicates the actual attempts when several env suffixes contain the same key', async () => {
    for (let n = 2; n <= 10; n++) vi.stubEnv('GROQ_API_KEY_' + n, n === 2 ? keys[1]! : keys[0]!);
    const fetch = vi.fn().mockImplementation(async () => failure(429));
    vi.stubGlobal('fetch', fetch);
    await new OpenAICompatibleProvider(config()).complete(request());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Set([authorization(fetch, 0), authorization(fetch, 1)]).size).toBe(2);
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
    await vi.advanceTimersByTimeAsync(51);
    const response = await result;
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('TIMEOUT');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not reset the overall deadline when rotating after a slow429', async () => {
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
    expect(fetch).toHaveBeenCalledTimes(5);
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
  it('can rotate an HTTP429 before streaming begins', async () => {
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
