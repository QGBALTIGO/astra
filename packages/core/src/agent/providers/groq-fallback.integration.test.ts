import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionRequest, ProviderConfig } from '../types.js';

vi.mock('../tools/dynamic-tool-permissions.js', () => ({
  isPrivateUrlAsync: vi.fn(async () => false),
}));
vi.mock('../../services/get-log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let sequence = 0;
let keys: string[];
beforeEach(() => {
  sequence++;
  keys = Array.from({ length: 5 }, (_, i) => `gsk-synthetic-${sequence}-${i}`);
  keys.forEach((key, i) => vi.stubEnv(i ? `GROQ_API_KEY_${i + 1}` : 'GROQ_API_KEY', key));
  for (let i = 6; i <= 10; i++) vi.stubEnv(`GROQ_API_KEY_${i}`, '');
  vi.stubEnv('GROQ_QUOTA_GROUPS', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function response(content: string) {
  return Response.json({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

function input(customer: string): CompletionRequest {
  return {
    messages: [{ id: 'user-1', role: 'user', content: customer }],
    model: { model: 'openai/gpt-oss-20b', maxTokens: 256 },
    metadata: { conversationId: customer },
    toolChoice: 'none',
  } as CompletionRequest;
}

async function provider() {
  const { FallbackProvider } = await import('./fallback.js');
  const primary: ProviderConfig = {
    id: 'groq',
    provider: 'groq',
    apiKey: keys[0],
    baseUrl: 'https://api.groq.com/openai/v1',
    timeout: 1000,
    maxRetries: 0,
  };
  return new FallbackProvider({
    primary,
    fallbacks: [
      {
        id: 'openrouter',
        provider: 'openai-compatible',
        apiKey: `or-synthetic-${sequence}`,
        baseUrl: 'https://openrouter.ai/api/v1',
        timeout: 1000,
        maxRetries: 0,
        defaultModel: { model: 'openrouter/free' },
      },
    ],
    circuitBreakerThreshold: 1,
    sharedCircuitBreaker: true,
    preferLastSuccessful: true,
    completionTimeoutMs: 3000,
  });
}

describe('Groq credential pool with the real fallback transport', () => {
  it('fits an oversized channel history without losing the recent or current user turns', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '5000');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return response('Lembrete confirmado.');
      })
    );
    const request: CompletionRequest = {
      ...input('customer-history'),
      metadata: { fitGroqChannelHistory: true, conversationId: 'customer-history' },
      messages: [
        { id: 'system', role: 'system', content: 'Use only confirmed facts.' },
        { id: 'old-user', role: 'user', content: 'Previous request' },
        { id: 'old-answer', role: 'assistant', content: 'x'.repeat(28_000) },
        { id: 'recent-user', role: 'user', content: 'Previous subject' },
        { id: 'recent-answer', role: 'assistant', content: 'Confirmed subject' },
        { id: 'new-user', role: 'user', content: 'Me lembre às 17h' },
      ],
    };
    expect((await (await provider()).complete(request)).ok).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe('openai/gpt-oss-20b');
    expect(bodies[0]?.messages).toEqual([
      { role: 'system', content: 'Use only confirmed facts.' },
      { role: 'user', content: 'Previous subject' },
      { role: 'assistant', content: 'Confirmed subject' },
      { role: 'user', content: 'Me lembre às 17h' },
    ]);
    expect(request.messages).toHaveLength(6);
  });

  it('passes the untouched active conversation to OpenRouter when the protected turn cannot fit', async () => {
    vi.stubEnv('GROQ_MAX_REQUEST_TOKENS', '5000');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return response('Resposta completa.');
      })
    );
    const longMessage = 'a'.repeat(28_000);
    const request: CompletionRequest = {
      ...input(longMessage),
      metadata: { fitGroqChannelHistory: true, conversationId: 'long-current-turn' },
    };
    expect((await (await provider()).complete(request)).ok).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe('openrouter/free');
    expect(bodies[0]?.messages).toEqual([{ role: 'user', content: longMessage }]);
  });

  it('respects one shared Groq organization quota, then uses a private tool-capable OpenRouter route', async () => {
    const calls: Array<{ url: string; key: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ url, key: new Headers(init.headers).get('authorization')!, body });
        if (url.startsWith('https://api.groq.com/')) {
          return Response.json(
            { error: { message: 'Rate limit reached' } },
            {
              status: 429,
              headers: { 'retry-after': '60' },
            }
          );
        }
        return response('Seu saldo está pronto.');
      })
    );
    const result = await (await provider()).complete(input('customer-A'));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.model).toBe('openrouter/free');
    expect(calls[1]!.body.provider).toMatchObject({
      data_collection: 'deny',
      require_parameters: true,
    });
    expect(JSON.stringify(calls[1]!.body.messages)).toContain('customer-A');
  });

  it('preserves an already executed tool receipt when the next completion changes credential', async () => {
    let round = 0;
    let finalAttempts = 0;
    const receipts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.messages.some((m: { role: string }) => m.role === 'tool')) {
          receipts.push(body.messages.filter((m: { role: string }) => m.role === 'tool'));
          if (finalAttempts++ === 0)
            return Response.json(
              { error: { message: 'Rate limit' } },
              {
                status: 429,
                headers: { 'retry-after': '30' },
              }
            );
          return response('🍕 Pizza registrada, Kayky!');
        }
        round++;
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'receipt-1',
                    type: 'function',
                    function: { name: 'core__record_expense', arguments: '{"amount":35}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      })
    );
    const transport = await provider();
    const request = { ...input('customer-pizza'), toolChoice: 'auto' as const };
    const first = await transport.complete(request);
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    expect(first.value.toolCalls).toHaveLength(1);
    const execute = vi.fn(() => ({ saved: true, amount: 35 }));
    const receipt = execute();
    const second = await transport.complete({
      ...request,
      toolChoice: 'none',
      messages: [
        ...request.messages,
        { id: 'assistant-1', role: 'assistant', content: '', toolCalls: first.value.toolCalls },
        {
          id: 'tool-1',
          role: 'tool',
          content: '',
          toolResults: [
            {
              toolCallId: 'receipt-1',
              name: 'core.record_expense',
              content: JSON.stringify(receipt),
            },
          ],
        },
      ],
    } as CompletionRequest);
    expect(second.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(round).toBe(1);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toEqual(receipts[1]);
  });

  it('keeps 500 synthetic requests isolated while bounding Groq concurrency and using the configured fallback', async () => {
    const observedKeys = new Set<string>();
    let groqCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.startsWith('https://api.groq.com/')) groqCalls++;
        observedKeys.add(new Headers(init.headers).get('authorization')!);
        const body = JSON.parse(String(init.body));
        await Promise.resolve();
        return response(body.messages[0].content);
      })
    );
    const transports = await Promise.all(Array.from({ length: 500 }, () => provider()));
    const results = await Promise.all(transports.map((p, i) => p.complete(input(`customer-${i}`))));
    results.forEach((result, i) => {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content).toBe(`customer-${i}`);
    });
    expect(groqCalls).toBe(4);
    expect(observedKeys.size).toBe(5); // Four Groq credentials plus the configured fallback.
  });
});
