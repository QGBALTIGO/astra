import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FallbackProvider, providerCooldownMs } from './fallback.js';
import { createProvider } from '../provider.js';
import type { OpenAICompatibleProvider } from './openai-compatible.js';
import type { CompletionRequest, ProviderConfig } from '../types.js';

vi.mock('../tools/dynamic-tool-permissions.js', () => ({
  isPrivateUrlAsync: vi.fn(async () => false),
}));
vi.mock('../../services/get-log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const baseUrl = 'https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai/v1';
const model = '@cf/zai-org/glm-4.7-flash';
let sequence = 0;

beforeEach(() => {
  sequence++;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T23:59:00Z'));
  // No live service calls or credentials are used by these contract tests.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected test fetch');
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'cloudflare-workers-ai',
    provider: 'openai-compatible',
    apiKey: `synthetic-cf-${sequence}`,
    baseUrl,
    timeout: 30,
    defaultModel: { model },
    ...overrides,
  };
}

function chain(timeoutMs = 100) {
  return new FallbackProvider({
    primary: config(),
    fallbacks: [
      {
        id: 'openrouter',
        provider: 'openai-compatible',
        apiKey: `synthetic-or-${sequence}`,
        baseUrl: 'https://openrouter.ai/api/v1',
        timeout: 50,
        defaultModel: { model: 'openrouter/free' },
      },
    ],
    completionTimeoutMs: timeoutMs,
    circuitBreakerThreshold: 1,
    sharedCircuitBreaker: true,
  });
}

function request(content = 'Customer A'): CompletionRequest {
  return {
    messages: [{ id: 'user-1', role: 'user', content }],
    model: { model, maxTokens: 256 },
    metadata: { conversationId: content },
  };
}

function response(content = 'Resposta pronta') {
  return Response.json({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

function sse(parts: string[], end = true, cancel = vi.fn()) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(`data: ${part}\n\n`));
        if (end) controller.close();
      },
      cancel,
    })
  );
}

function finalStream() {
  return sse([
    JSON.stringify({ choices: [{ delta: { content: 'Backup response' }, finish_reason: null }] }),
    '[DONE]',
  ]);
}

async function collect(provider: FallbackProvider, input = request()) {
  const chunks = [];
  for await (const chunk of provider.stream(input)) chunks.push(chunk);
  return chunks;
}

describe('Cloudflare Workers AI with the real fallback transport', () => {
  it('uses the documented GLM parameters, JSON mode and tool schema on the official route', async () => {
    const fetchMock = vi.fn(async () => response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    const input: CompletionRequest = {
      ...request(),
      model: { ...request().model, responseFormat: 'json' },
      tools: [
        {
          name: 'core.lookup',
          description: 'Look up data',
          parameters: { type: 'object', properties: {} },
        },
      ],
      toolChoice: 'auto',
    };
    const result = await chain().complete(input);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/chat/completions`);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model,
      max_completion_tokens: 256,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_object' },
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'core__lookup' } }],
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer synthetic-cf-${sequence}`);
  });

  it.each([
    { id: 'other-provider' },
    { baseUrl: 'https://proxy.example.test/ai/v1' },
    { defaultModel: { model: '@cf/other-model' } },
  ])(
    'does not apply the GLM contract outside its provider, endpoint and model: %j',
    async (overrides) => {
      const fetchMock = vi.fn(async () => response());
      vi.stubGlobal('fetch', fetchMock);
      const input = {
        ...request(),
        model: { model: overrides.defaultModel?.model ?? model, maxTokens: 256 },
      };
      expect((await createProvider(config(overrides)).complete(input)).ok).toBe(true);
      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body));
      expect(body.max_tokens).toBe(256);
      expect(body).not.toHaveProperty('chat_template_kwargs');
      expect(body).not.toHaveProperty('max_completion_tokens');
    }
  );

  it('uses the documented model search route for health and model discovery', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: [{ name: model }] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createProvider(config()) as OpenAICompatibleProvider;
    const health = await provider.healthCheck();
    expect(health.ok && health.value.status).toBe('ok');
    expect(await provider.fetchModelsFromAPI()).toEqual({ ok: true, value: [model] });
    for (const [url] of vi.mocked(fetch).mock.calls)
      expect(url).toBe(baseUrl.replace('/v1', '/models/search'));
  });

  it.each([401, 403, 408, 410, 429, 503])(
    'moves past provider HTTP %i without implicit retries',
    async (status) => {
      const fetchMock = vi.fn(async (url: string) =>
        url.startsWith(baseUrl)
          ? Response.json(
              { error: { message: 'Provider unavailable or not configured' } },
              { status }
            )
          : response()
      );
      vi.stubGlobal('fetch', fetchMock);
      expect((await chain().complete(request())).ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const backup = JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]?.body));
      expect(backup.model).toBe('openrouter/free');
      expect(backup.messages).toEqual([{ role: 'user', content: 'Customer A' }]);
    }
  );

  it('preserves Retry-After through the circuit across instances', async () => {
    let primaryAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.startsWith(baseUrl)) return response();
        primaryAttempts++;
        return Response.json(
          { error: 'Rate limited' },
          { status: 429, headers: { 'retry-after': '120' } }
        );
      })
    );
    expect((await chain().complete(request())).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await chain().complete(request())).ok).toBe(true);
    expect(primaryAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await chain().complete(request())).ok).toBe(true);
    expect(primaryAttempts).toBe(2);
  });

  it('keeps a synthetic 3036 quota response out of the chain until the next UTC day', async () => {
    let primaryAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.startsWith(baseUrl)) return response();
        primaryAttempts++;
        // Synthetic envelope; the documented error code and reset time are the contract.
        return Response.json(
          { errors: [{ code: 3036, message: 'Daily allocation exhausted' }] },
          { status: 429 }
        );
      })
    );
    expect((await chain().complete(request())).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(59_000);
    expect((await chain().complete(request())).ok).toBe(true);
    expect(primaryAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_101);
    expect((await chain().complete(request())).ok).toBe(true);
    expect(primaryAttempts).toBe(2);
  });

  it('does not classify Cloudflare capacity code 3040 as a daily quota', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ errors: [{ code: 3040, message: 'Capacity exhausted' }] }, { status: 429 })
      )
    );
    const result = await createProvider(config({ maxRetries: 0 })).complete(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(providerCooldownMs(result.error, 300_000)).toBe(15_000);
  });

  it('aborts a stalled JSON body before trying the backup', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);
        return url.startsWith(baseUrl) ? new Response(new ReadableStream()) : response();
      })
    );
    const pending = chain().complete(request());
    await vi.advanceTimersByTimeAsync(30);
    expect((await pending).ok).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('cancels one caller without a fallback or interrupting another caller on the same instance', async () => {
    const signals = new Map<string, AbortSignal>();
    let resolveSecond: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const name = JSON.parse(String(init.body)).messages[0].content as string;
        signals.set(name, init.signal as AbortSignal);
        if (name === 'first') return new Response(new ReadableStream());
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      })
    );
    const provider = chain();
    const firstController = new AbortController();
    const first = provider.complete({ ...request('first'), signal: firstController.signal });
    const second = provider.complete(request('second'));
    await vi.advanceTimersByTimeAsync(0);
    firstController.abort();
    expect((await first).ok).toBe(false);
    expect(signals.get('first')?.aborted).toBe(true);
    expect(signals.get('second')?.aborted).toBe(false);
    resolveSecond(response());
    expect((await second).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds the complete chain and aborts each exhausted attempt', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);
        return new Response(new ReadableStream());
      })
    );
    const pending = chain(70).complete(request());
    await vi.advanceTimersByTimeAsync(70);
    expect((await pending).ok).toBe(false);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('times out one concurrent caller without cancelling the other caller', async () => {
    const signals = new Map<string, AbortSignal>();
    let resolveSecond: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (!url.startsWith(baseUrl)) return response();
        const name = JSON.parse(String(init.body)).messages[0].content as string;
        signals.set(name, init.signal as AbortSignal);
        if (name === 'first') return new Response(new ReadableStream());
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      })
    );
    const provider = chain();
    const first = provider.complete(request('first'));
    await vi.advanceTimersByTimeAsync(20);
    const second = provider.complete(request('second'));
    await vi.advanceTimersByTimeAsync(10);
    expect((await first).ok).toBe(true);
    expect(signals.get('first')?.aborted).toBe(true);
    expect(signals.get('second')?.aborted).toBe(false);
    resolveSecond(response());
    expect((await second).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('returns one failure when every route is exhausted, then observes their circuits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'Unavailable' }, { status: 503 }))
    );
    expect((await chain().complete(request())).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await chain().complete(request())).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves an executed tool receipt through a fallback without replaying a write', async () => {
    const received: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        received.push(JSON.parse(String(init.body)).messages);
        return url.startsWith(baseUrl)
          ? Response.json({ error: 'Unavailable' }, { status: 503 })
          : response('Saved once');
      })
    );
    const executeWrite = vi.fn(() => ({ saved: true, receipt: 'receipt-1' }));
    const receipt = executeWrite();
    const input: CompletionRequest = {
      ...request(),
      toolChoice: 'none',
      messages: [
        ...request().messages,
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'write-1', name: 'core.record_expense', arguments: '{"amount":35}' }],
        },
        {
          id: 'tool-1',
          role: 'tool',
          content: '',
          toolResults: [
            {
              toolCallId: 'write-1',
              name: 'core.record_expense',
              content: JSON.stringify(receipt),
            },
          ],
        },
      ],
    };
    expect((await chain().complete(input)).ok).toBe(true);
    expect(executeWrite).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(received[0]);
    expect(received[1]).toContainEqual({
      role: 'tool',
      tool_call_id: 'write-1',
      content: JSON.stringify(receipt),
    });
  });

  it('falls back on a streaming authentication failure before publishing output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith(baseUrl)
          ? Response.json({ error: 'Invalid API key' }, { status: 401 })
          : finalStream()
      )
    );
    const chunks = await collect(chain());
    expect(chunks.every((chunk) => chunk.ok)).toBe(true);
    expect(chunks.some((chunk) => chunk.ok && chunk.value.content === 'Backup response')).toBe(
      true
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled first stream read and cancels it before using a backup', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith(baseUrl) ? sse([], false, cancelled) : finalStream()
      )
    );
    const pending = collect(chain());
    await vi.advanceTimersByTimeAsync(30);
    const chunks = await pending;
    expect(chunks.every((chunk) => chunk.ok)).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops a cancelled stream without activating a backup or poisoning provider health', async () => {
    const fetchMock = vi.fn(async () => sse([], false));
    vi.stubGlobal('fetch', fetchMock);
    const provider = chain();
    const pending = collect(provider);
    await vi.advanceTimersByTimeAsync(0);
    provider.cancel();
    const chunks = await pending;
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () => response());
    expect((await provider.complete(request())).ok).toBe(true);
    expect(String(vi.mocked(fetch).mock.calls[1]![0]).startsWith(baseUrl)).toBe(true);
  });

  it.each([
    { content: 'Partial answer' },
    {
      tool_calls: [
        {
          index: 0,
          id: 'write-1',
          function: { name: 'core__record_expense', arguments: '{"amount":35}' },
        },
      ],
    },
  ])('never replays a stream after publishing text or tool fragments: %j', async (delta) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([JSON.stringify({ choices: [{ delta, finish_reason: null }] })], false))
    );
    const pending = collect(chain());
    await vi.advanceTimersByTimeAsync(30);
    const chunks = await pending;
    expect(chunks[0]?.ok).toBe(true);
    expect(chunks.at(-1)?.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports EOF without a terminal event as failure instead of accepting partial tool arguments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'write-1',
                      function: { name: 'core__record_expense', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
        ])
      )
    );
    const chunks = await collect(chain());
    expect(chunks[0]?.ok).toBe(true);
    expect(chunks.at(-1)?.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
