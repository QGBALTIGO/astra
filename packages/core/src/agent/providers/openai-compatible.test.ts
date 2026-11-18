/**
 * OpenAICompatibleProvider Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvedProviderConfig, ProviderConfig } from './configs/index.js';
import type { CompletionRequest, Message, StreamChunk } from '../types.js';
import type { Result } from '../../types/result.js';
import type { InternalError } from '../../types/errors.js';
import { OpenAICompatibleProvider, providerRateLimitRetryDelayMs } from './openai-compatible.js';

// Mock configs module — vi.hoisted ensures the fns exist before the hoisted vi.mock runs
const { mockLoadProviderConfig, mockResolveProviderConfig, mockDnsLookup } = vi.hoisted(() => ({
  mockLoadProviderConfig: vi.fn(),
  mockResolveProviderConfig: vi.fn(),
  mockDnsLookup: vi.fn(),
}));

vi.mock('./configs/index.js', () => ({
  loadProviderConfig: mockLoadProviderConfig,
  resolveProviderConfig: mockResolveProviderConfig,
}));

// Transport tests must not depend on the runner's DNS/proxy. Keep the actual
// SSRF validator and control only its network lookup; private answers still fail.
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns/promises')>()),
  lookup: mockDnsLookup,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockConfig: ResolvedProviderConfig = {
  id: 'openai',
  name: 'OpenAI',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test-key',
  models: [
    {
      id: 'gpt-4',
      name: 'GPT-4',
      contextWindow: 128_000,
      maxOutput: 4096,
      inputPrice: 10,
      outputPrice: 30,
      capabilities: ['chat', 'code', 'vision'],
      default: true,
    },
    {
      id: 'gpt-3.5-turbo',
      name: 'GPT-3.5 Turbo',
      contextWindow: 16_000,
      maxOutput: 4096,
      inputPrice: 0.5,
      outputPrice: 1.5,
      capabilities: ['chat', 'code'],
    },
  ],
  features: {
    streaming: true,
    toolUse: true,
    vision: true,
    jsonMode: true,
    systemMessage: true,
  },
};

/** ProviderConfig (includes apiKeyEnv, no apiKey) */
const mockRawConfig: ProviderConfig = {
  id: 'openai',
  name: 'OpenAI',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  models: mockConfig.models,
  features: mockConfig.features,
};

const makeRequest = (overrides?: Partial<CompletionRequest>): CompletionRequest => ({
  messages: [{ role: 'user' as const, content: 'Hello' }],
  model: {
    model: 'gpt-4',
    maxTokens: 1024,
    temperature: 0.7,
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    body: null,
  });
}

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function mockFetchStream(chunks: string[], ok = true, status = 200) {
  const body = createSSEStream(chunks);
  return vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => null },
    body,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDnsLookup.mockReset().mockImplementation(async (hostname: string) => {
    if (hostname !== 'api.openai.com') throw new Error('Unexpected fixture DNS hostname');
    return [{ address: '93.184.216.34', family: 4 }];
  });
  vi.stubEnv('OWNPILOT_ALLOW_LOCAL_LLM_URL', 'false');
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ===========================================================================
// Tests
// ===========================================================================

describe('providerRateLimitRetryDelayMs', () => {
  it('reads fractional Retry-After seconds and adds a small safety margin', () => {
    const headers = { get: (name: string) => (name === 'retry-after' ? '4.6425' : null) };
    expect(providerRateLimitRetryDelayMs(headers, '')).toBe(4743);
  });

  it('reads Groq-style retry hints from the error body', () => {
    const headers = { get: () => null };
    expect(providerRateLimitRetryDelayMs(headers, 'Please try again in 2.5s.')).toBe(2600);
  });

  it('refuses an unbounded provider wait', () => {
    const headers = { get: () => '60' };
    expect(providerRateLimitRetryDelayMs(headers, '')).toBeNull();
  });
});

describe('OpenAICompatibleProvider', () => {
  // -------------------------------------------------------------------------
  // Static factories
  // -------------------------------------------------------------------------
  describe('fromProviderId', () => {
    it('returns a provider when config is resolved', () => {
      mockResolveProviderConfig.mockReturnValue(mockConfig);

      const provider = OpenAICompatibleProvider.fromProviderId('openai');

      expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
      expect(provider!.type).toBe('openai');
      expect(mockResolveProviderConfig).toHaveBeenCalledWith('openai');
    });

    it('returns null when config is not found', () => {
      mockResolveProviderConfig.mockReturnValue(null);

      const provider = OpenAICompatibleProvider.fromProviderId('nonexistent');

      expect(provider).toBeNull();
    });
  });

  describe('fromProviderIdWithKey', () => {
    it('creates a provider with the given API key', () => {
      mockLoadProviderConfig.mockReturnValue(mockRawConfig);

      const provider = OpenAICompatibleProvider.fromProviderIdWithKey('openai', 'sk-custom-key');

      expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
      expect(provider!.isReady()).toBe(true);
    });

    it('returns null when raw config is not found', () => {
      mockLoadProviderConfig.mockReturnValue(null);

      const provider = OpenAICompatibleProvider.fromProviderIdWithKey('nonexistent', 'sk-key');

      expect(provider).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // isReady
  // -------------------------------------------------------------------------
  describe('isReady', () => {
    it('returns true when apiKey and baseUrl are present', () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      expect(provider.isReady()).toBe(true);
    });

    it('returns false when apiKey is missing', () => {
      const provider = new OpenAICompatibleProvider({ ...mockConfig, apiKey: '' });
      expect(provider.isReady()).toBe(false);
    });

    it('returns false when baseUrl is missing', () => {
      const provider = new OpenAICompatibleProvider({ ...mockConfig, baseUrl: '' });
      expect(provider.isReady()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getDefaultModel
  // -------------------------------------------------------------------------
  describe('getDefaultModel', () => {
    it('returns the model marked as default', () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      expect(provider.getDefaultModel()).toBe('gpt-4');
    });

    it('returns the first model when none is marked default', () => {
      const config: ResolvedProviderConfig = {
        ...mockConfig,
        models: mockConfig.models.map((m) => ({ ...m, default: undefined })),
      };
      const provider = new OpenAICompatibleProvider(config);
      expect(provider.getDefaultModel()).toBe('gpt-4');
    });

    it('returns undefined when models list is empty', () => {
      const provider = new OpenAICompatibleProvider({ ...mockConfig, models: [] });
      expect(provider.getDefaultModel()).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getConfig
  // -------------------------------------------------------------------------
  describe('getConfig', () => {
    it('returns raw provider config via loadProviderConfig', () => {
      mockLoadProviderConfig.mockReturnValue(mockRawConfig);
      const provider = new OpenAICompatibleProvider(mockConfig);

      const config = provider.getConfig();

      expect(config).toBe(mockRawConfig);
      expect(mockLoadProviderConfig).toHaveBeenCalledWith('openai');
    });

    it('returns undefined when loadProviderConfig returns null', () => {
      mockLoadProviderConfig.mockReturnValue(null);
      const provider = new OpenAICompatibleProvider(mockConfig);

      expect(provider.getConfig()).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getModels
  // -------------------------------------------------------------------------
  describe('getModels', () => {
    it('returns model IDs from config without an API call', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);

      const result = await provider.getModels();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(['gpt-4', 'gpt-3.5-turbo']);
      }
    });
  });

  // -------------------------------------------------------------------------
  // countTokens
  // -------------------------------------------------------------------------
  describe('countTokens', () => {
    it('counts string content as chars / 4 rounded up', () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      // "Hello" = 5 chars => ceil(5/4) = 2
      const messages: Message[] = [{ role: 'user', content: 'Hello' }];
      expect(provider.countTokens(messages)).toBe(2);
    });

    it('counts ContentPart[] content (text parts only)', () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      // "Hello World" = 11 chars => ceil(11/4) = 3
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' World' },
          ],
        },
      ];
      expect(provider.countTokens(messages)).toBe(3);
    });

    it('ignores non-text content parts', () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'image', data: 'base64data', mediaType: 'image/png' },
          ],
        },
      ];
      // Only "Hi" = 2 chars => ceil(2/4) = 1
      expect(provider.countTokens(messages)).toBe(1);
    });

    it('sums across multiple messages', () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' }, // 16 chars
        { role: 'user', content: 'Hi' }, // 2 chars
      ];
      // total = 18 chars => ceil(18/4) = 5
      expect(provider.countTokens(messages)).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------
  describe('cancel', () => {
    it('aborts the abort controller', () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      // Trigger creation of an abort controller by starting a request
      const fetchMock = mockFetchResponse({ choices: [{ message: { content: 'hi' } }] }, true, 200);
      vi.stubGlobal('fetch', fetchMock);

      // Start request (don't await it yet)
      const promise = provider.complete(makeRequest());
      // Cancel immediately
      provider.cancel();
      // The request may resolve or reject depending on timing; we just verify cancel doesn't throw
      return promise.then(() => {}).catch(() => {});
    });
  });

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------
  describe('complete', () => {
    it('blocks a private/internal base URL (SSRF) when local LLMs are not opted in', async () => {
      delete process.env.OWNPILOT_ALLOW_LOCAL_LLM_URL;
      const fetchMock = mockFetchResponse({ choices: [{ message: { content: 'hi' } }] });
      vi.stubGlobal('fetch', fetchMock);
      const provider = new OpenAICompatibleProvider({
        ...mockConfig,
        baseUrl: 'http://127.0.0.1:1234/v1',
      });

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('private/internal');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      { host: 'loopback.provider.test', addresses: [{ address: '127.0.0.1', family: 4 }] },
      { host: 'metadata.provider.test', addresses: [{ address: '169.254.169.254', family: 4 }] },
      { host: 'ipv6.provider.test', addresses: [{ address: '::1', family: 6 }] },
      {
        host: 'mixed.provider.test',
        addresses: [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
      },
    ])(
      'blocks private DNS answers for $host without transmitting the API key',
      async ({ host, addresses }) => {
        mockDnsLookup.mockResolvedValueOnce(addresses);
        const fetchMock = mockFetchResponse({
          choices: [{ message: { content: 'must not send' } }],
        });
        vi.stubGlobal('fetch', fetchMock);
        const provider = new OpenAICompatibleProvider({
          ...mockConfig,
          baseUrl: `https://${host}/v1`,
        });
        const result = await provider.complete(makeRequest());
        expect(mockDnsLookup).toHaveBeenCalledWith(host, { all: true });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain('private/internal');
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    it('fails closed when the provider DNS lookup is unavailable', async () => {
      mockDnsLookup.mockRejectedValueOnce(new Error('synthetic DNS unavailable'));
      const fetchMock = mockFetchResponse({ choices: [{ message: { content: 'must not send' } }] });
      vi.stubGlobal('fetch', fetchMock);
      const provider = new OpenAICompatibleProvider({
        ...mockConfig,
        baseUrl: 'https://unavailable.provider.test/v1',
      });
      expect((await provider.complete(makeRequest())).ok).toBe(false);
      expect(mockDnsLookup).toHaveBeenCalledWith('unavailable.provider.test', { all: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('allows a private base URL when OWNPILOT_ALLOW_LOCAL_LLM_URL=true (Ollama/LM Studio)', async () => {
      process.env.OWNPILOT_ALLOW_LOCAL_LLM_URL = 'true';
      try {
        const fetchMock = mockFetchResponse({ choices: [{ message: { content: 'hi' } }] });
        vi.stubGlobal('fetch', fetchMock);
        const provider = new OpenAICompatibleProvider({
          ...mockConfig,
          baseUrl: 'http://127.0.0.1:1234/v1',
        });

        const result = await provider.complete(makeRequest());

        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalled();
      } finally {
        delete process.env.OWNPILOT_ALLOW_LOCAL_LLM_URL;
      }
    });

    it('returns ValidationError when provider is not ready', async () => {
      const provider = new OpenAICompatibleProvider({ ...mockConfig, apiKey: '' });

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(result.error.message).toContain('not configured');
      }
    });

    it('returns ValidationError when no model is specified', async () => {
      const provider = new OpenAICompatibleProvider({ ...mockConfig, models: [] });
      const request = makeRequest({ model: { model: '' } });

      const result = await provider.complete(request);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(result.error.message).toBe('No model specified');
      }
    });

    it('makes a successful completion and parses the response', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const apiResponse = {
        id: 'chatcmpl-123',
        model: 'gpt-4',
        created: 1700000000,
        choices: [
          {
            message: { content: 'Hello there!' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };
      vi.stubGlobal('fetch', mockFetchResponse(apiResponse));

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('chatcmpl-123');
        expect(result.value.content).toBe('Hello there!');
        expect(result.value.finishReason).toBe('stop');
        expect(result.value.model).toBe('gpt-4');
        expect(result.value.usage).toEqual({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        });
        expect(result.value.createdAt).toEqual(new Date(1700000000 * 1000));
      }
    });

    it('sends correct request body to the API', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const fetchMock = mockFetchResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      });
      vi.stubGlobal('fetch', fetchMock);

      const request = makeRequest({
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        ],
        toolChoice: 'auto',
        user: 'user-123',
      });

      await provider.complete(request);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({ method: 'POST' })
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4');
      expect(body.stream).toBe(false);
      expect(body.max_tokens).toBe(1024);
      expect(body.temperature).toBe(0.7);
      expect(body.user).toBe('user-123');
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ]);
      expect(body.tool_choice).toBe('auto');
    });

    it('handles reasoning_content (DeepSeek R1 style)', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const apiResponse = {
        choices: [
          {
            message: {
              content: 'The answer is 42.',
              reasoning_content: 'Let me think step by step...',
            },
            finish_reason: 'stop',
          },
        ],
      };
      vi.stubGlobal('fetch', mockFetchResponse(apiResponse));

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe(
          '<thinking>\nLet me think step by step...\n</thinking>\n\nThe answer is 42.'
        );
      }
    });

    it.each([false, true])(
      'serializes a named tool choice with its sanitized name (stream=%s)',
      async (stream) => {
        const provider = new OpenAICompatibleProvider(mockConfig);
        const fetchMock = stream
          ? mockFetchStream(['data: [DONE]\n\n'])
          : mockFetchResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        vi.stubGlobal('fetch', fetchMock);
        const request = makeRequest({
          tools: [
            {
              name: 'core.add_task',
              description: 'Create a task',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          ],
          toolChoice: { name: 'core.add_task' },
        });

        if (stream) {
          for await (const chunk of provider.stream(request)) expect(chunk.ok).toBe(true);
        } else {
          expect((await provider.complete(request)).ok).toBe(true);
        }

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.tools[0].function.name).toBe('core__add_task');
        expect(body.tool_choice).toEqual({
          type: 'function',
          function: { name: 'core__add_task' },
        });
      }
    );

    it('handles tool calls in the response', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const apiResponse = {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_abc123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"London"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      vi.stubGlobal('fetch', mockFetchResponse(apiResponse));

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe('');
        expect(result.value.finishReason).toBe('tool_calls');
        expect(result.value.toolCalls).toEqual([
          {
            id: 'call_abc123',
            name: 'get_weather',
            arguments: '{"location":"London"}',
          },
        ]);
      }
    });

    it('preserves an explicit refusal instead of returning an empty completion', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal(
        'fetch',
        mockFetchResponse({
          choices: [
            {
              message: { content: null, refusal: 'I cannot help with that request.' },
              finish_reason: 'stop',
            },
          ],
        })
      );

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe('I cannot help with that request.');
        expect(result.value.finishReason).toBe('content_filter');
        expect(result.value.toolCalls).toBeUndefined();
      }
    });

    it.each([
      { refusal: 'I cannot perform that action.', finish_reason: 'stop' },
      { refusal: null, finish_reason: 'content_filter' },
    ])(
      'does not return tool calls from a declined completion: $finish_reason',
      async (declined) => {
        const provider = new OpenAICompatibleProvider(mockConfig);
        vi.stubGlobal(
          'fetch',
          mockFetchResponse({
            choices: [
              {
                message: {
                  content: null,
                  refusal: declined.refusal,
                  tool_calls: [
                    {
                      id: 'task-1',
                      type: 'function',
                      function: { name: 'add_task', arguments: '{}' },
                    },
                  ],
                },
                finish_reason: declined.finish_reason,
              },
            ],
          })
        );

        const result = await provider.complete(makeRequest());

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.finishReason).toBe('content_filter');
          expect(result.value.toolCalls).toBeUndefined();
        }
      }
    );

    it('returns InternalError on non-ok response', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal('fetch', mockFetchResponse({ error: { message: 'Rate limited' } }, false, 429));

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
        expect(result.error.message).toContain('429');
      }
    });

    it('retries one 429 after the provider delay and succeeds', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const rateLimited = {
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === 'retry-after' ? '0' : null) },
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('{"error":{"message":"Rate limited"}}'),
        body: null,
      };
      const success = {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            id: 'retry-ok',
            choices: [{ message: { content: 'Recovered' }, finish_reason: 'stop' }],
          }),
        text: () => Promise.resolve(''),
        body: null,
      };
      const fetchMock = vi.fn().mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(success);
      vi.stubGlobal('fetch', fetchMock);

      const result = await provider.complete(makeRequest());

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content).toBe('Recovered');
    });

    it('does not retry a non-rate-limit provider error', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const fetchMock = mockFetchResponse({ error: { message: 'Bad tool call' } }, false, 400);
      vi.stubGlobal('fetch', fetchMock);

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns InternalError when response has no choices', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal('fetch', mockFetchResponse({ choices: [] }));

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
        expect(result.error.message).toContain('No response');
      }
    });

    it('returns TimeoutError on AbortError', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TIMEOUT');
      }
    });

    it('returns InternalError on other fetch errors', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

      const result = await provider.complete(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
        expect(result.error.message).toContain('Network failure');
      }
    });

    it('uses defaultModel when request model is empty', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const fetchMock = mockFetchResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      });
      vi.stubGlobal('fetch', fetchMock);

      await provider.complete(makeRequest({ model: { model: '' } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4'); // default model
    });

    it('includes custom headers from config', async () => {
      const provider = new OpenAICompatibleProvider({
        ...mockConfig,
        headers: { 'X-Custom': 'value' },
      });
      const fetchMock = mockFetchResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      });
      vi.stubGlobal('fetch', fetchMock);

      await provider.complete(makeRequest());

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['X-Custom']).toBe('value');
      expect(headers['Authorization']).toBe('Bearer sk-test-key');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  // -------------------------------------------------------------------------
  // stream
  // -------------------------------------------------------------------------
  describe('stream', () => {
    it('yields error when provider is not ready', async () => {
      const provider = new OpenAICompatibleProvider({ ...mockConfig, apiKey: '' });

      const chunks: unknown[] = [];
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
        })
      );
    });

    it('retries a 429 before any stream chunks are emitted', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const rateLimited = {
        ok: false,
        status: 429,
        headers: { get: () => null },
        body: null,
        text: () => Promise.resolve('Please try again in 0s'),
      };
      const recovered = {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: createSSEStream([
          'data: {"id":"x","choices":[{"delta":{"content":"Recovered"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
        text: () => Promise.resolve(''),
      };
      const fetchMock = vi.fn().mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(recovered);
      vi.stubGlobal('fetch', fetchMock);

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) chunks.push(chunk);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(chunks.some((chunk) => chunk.ok && chunk.value.content === 'Recovered')).toBe(true);
    });

    it('yields error when no model is specified', async () => {
      const provider = new OpenAICompatibleProvider({ ...mockConfig, models: [] });
      const request = makeRequest({ model: { model: '' } });

      const chunks: unknown[] = [];
      for await (const chunk of provider.stream(request)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
        })
      );
    });

    it('parses SSE chunks and yields content', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const sseLines = [
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" World"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      vi.stubGlobal('fetch', mockFetchStream(sseLines));

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) {
        if (chunk.ok) {
          chunks.push(chunk);
        }
      }

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].value.content).toBe('Hello');
      expect(chunks[1].value.content).toBe(' World');
      // The last chunk is the [DONE] marker
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.value.done).toBe(true);
    });

    it('handles [DONE] marker and terminates', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const sseLines = [
        'data: {"id":"x","choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      vi.stubGlobal('fetch', mockFetchStream(sseLines));

      const chunks: unknown[] = [];
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk);
      }

      // Content chunk + DONE chunk
      expect(chunks.length).toBe(2);
    });

    it('handles reasoning_content in streaming with metadata.type', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const sseLines = [
        'data: {"id":"x","choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n',
        'data: {"id":"x","choices":[{"delta":{"content":"Answer"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      vi.stubGlobal('fetch', mockFetchStream(sseLines));

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) {
        if (chunk.ok) {
          chunks.push(chunk);
        }
      }

      // First chunk: reasoning content
      expect(chunks[0].ok && chunks[0].value.content).toBe('Thinking...');
      expect(chunks[0].ok && chunks[0].value.metadata).toEqual({ type: 'reasoning' });

      // Second chunk: transition newline
      expect(chunks[1].value.content).toBe('\n\n');

      // Third chunk: actual content
      expect(chunks[2].value.content).toBe('Answer');
    });

    it('does not drop content/tool_calls/finish_reason when bundled with reasoning_content in same chunk (MiniMax)', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      // MiniMax-style: reasoning_content and content arrive in the SAME delta
      const sseLines = [
        'data: {"id":"x","choices":[{"delta":{"reasoning_content":"thinking...","content":"the answer","tool_calls":[{"index":0,"id":"t1","function":{"name":"foo","arguments":"{}"}}]},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      vi.stubGlobal('fetch', mockFetchStream(sseLines));

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) {
        if (chunk.ok) chunks.push(chunk);
      }

      // First chunk: reasoning emitted with metadata.type='reasoning'
      expect(chunks[0].value.content).toBe('thinking...');
      expect(chunks[0].value.metadata).toEqual({ type: 'reasoning' });
      // Second chunk: transition newline between reasoning and content
      expect(chunks[1].value.content).toBe('\n\n');
      // Third chunk: content + tool_calls + finish_reason (NOT dropped by `continue`)
      expect(chunks[2].value.content).toBe('the answer');
      expect(chunks[2].value.toolCalls?.[0].id).toBe('t1');
      expect(chunks[2].value.finishReason).toBe('stop');
    });

    it('handles tool_calls in delta', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const sseLines = [
        'data: {"id":"x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
        'data: {"id":"x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"London\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      vi.stubGlobal('fetch', mockFetchStream(sseLines));

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) {
        if (chunk.ok) {
          chunks.push(chunk);
        }
      }

      // First chunk should have tool call info
      expect(chunks[0].ok && chunks[0].value.toolCalls).toBeDefined();
      expect(chunks[0].ok && chunks[0].value.toolCalls?.[0].id).toBe('call_1');
      expect(chunks[0].ok && chunks[0].value.toolCalls?.[0].name).toBe('get_weather');
    });

    it('stops on malformed chunks instead of silently returning incomplete content', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const sseLines = [
        'data: {"id":"x","choices":[{"delta":{"content":"A"}}]}\n\n',
        'data: {INVALID JSON}\n\n',
        'data: {"id":"x","choices":[{"delta":{"content":"B"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      vi.stubGlobal('fetch', mockFetchStream(sseLines));

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk);
      }

      const contentChunks = chunks.filter((c) => c.ok && c.value.content);
      expect(contentChunks.map((c) => c.ok && c.value.content)).toEqual(['A']);
      expect(chunks.at(-1)).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL_ERROR' },
      });
      expect(chunks.some((c) => c.ok && c.value.done)).toBe(false);
    });

    it('preserves streamed refusal fragments and the refusal finish reason', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal(
        'fetch',
        mockFetchStream([
          'data: {"id":"x","choices":[{"delta":{"refusal":"I cannot help "}}]}\n\n',
          'data: {"id":"x","choices":[{"delta":{"refusal":"with that request."}}]}\n\n',
          'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) chunks.push(chunk);

      expect(chunks.every((chunk) => chunk.ok)).toBe(true);
      expect(chunks.map((chunk) => (chunk.ok ? (chunk.value.content ?? '') : '')).join('')).toBe(
        'I cannot help with that request.'
      );
      expect(
        chunks.some((chunk) => chunk.ok && chunk.value.finishReason === 'content_filter')
      ).toBe(true);
    });

    it('does not accept tool arguments after a malformed stream event', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal(
        'fetch',
        mockFetchStream([
          'data: {"id":"x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"task-1","function":{"name":"add_task","arguments":"{"}}]}}]}\n\n',
          'data: {INVALID JSON}\n\n',
          'data: {"id":"x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) chunks.push(chunk);

      expect(chunks.at(-1)).toMatchObject({ ok: false });
      expect(chunks.some((chunk) => chunk.ok && chunk.value.done)).toBe(false);
    });

    it.each([
      { delta: { refusal: 'I cannot perform that action.' }, finish_reason: 'stop' },
      { delta: {}, finish_reason: 'content_filter' },
    ])('rejects tool deltas followed by a refusal: $finish_reason', async (declined) => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal(
        'fetch',
        mockFetchStream([
          'data: {"id":"x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"task-1","function":{"name":"add_task","arguments":"{}"}}]}}]}\n\n',
          `data: ${JSON.stringify({ id: 'x', choices: [declined] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      );

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) chunks.push(chunk);

      // Once a tool delta was delivered, an error prevents the agent from
      // converting those buffered arguments into an executable completion.
      expect(chunks.at(-1)).toMatchObject({ ok: false });
      expect(chunks.some((chunk) => chunk.ok && chunk.value.done)).toBe(false);
    });

    it('returns an error for an SSE error envelope before any output', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal(
        'fetch',
        mockFetchStream([
          'data: {"error":{"message":"private-provider-details","code":"server_error"}}\n\n',
          'data: [DONE]\n\n',
        ])
      );

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) chunks.push(chunk);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect(JSON.stringify(chunks)).not.toContain('private-provider-details');
    });

    it('yields InternalError on non-ok fetch response', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          body: null,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('Server error'),
        })
      );

      const chunks: unknown[] = [];
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
        })
      );
    });

    it('yields InternalError on fetch throw', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

      const chunks: unknown[] = [];
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
            message: expect.stringContaining('Network down'),
          }),
        })
      );
    });

    it('includes stream_options in request body', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const fetchMock = mockFetchStream(['data: [DONE]\n\n']);
      vi.stubGlobal('fetch', fetchMock);

      const chunks: unknown[] = [];
      for await (const _chunk of provider.stream(makeRequest())) {
        chunks.push(_chunk);
      }

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    });

    it('includes finish_reason and usage in final chunk', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const sseLines = [
        'data: {"id":"x","choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
        'data: [DONE]\n\n',
      ];
      vi.stubGlobal('fetch', mockFetchStream(sseLines));

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) {
        if (chunk.ok) {
          chunks.push(chunk);
        }
      }

      // The content chunk with finish_reason
      const contentChunk = chunks.find((c) => c.ok && c.value.content === 'Done');
      expect(contentChunk).toBeDefined();
      expect(contentChunk?.ok && contentChunk.value.done).toBe(true);
      expect(contentChunk?.ok && contentChunk.value.finishReason).toBe('stop');
      expect(contentChunk?.ok && contentChunk.value.usage).toEqual({
        promptTokens: 5,
        completionTokens: 3,
        totalTokens: 8,
      });
    });

    it('skips lines that do not start with "data: "', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const sseLines = [
        ': comment line\n\n',
        'event: ping\n\n',
        'data: {"id":"x","choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      vi.stubGlobal('fetch', mockFetchStream(sseLines));

      const chunks: Array<Result<StreamChunk, InternalError>> = [];
      for await (const chunk of provider.stream(makeRequest())) {
        if (chunk.ok) {
          chunks.push(chunk);
        }
      }

      const contentChunks = chunks.filter((c) => c.ok && c.value.content);
      expect(contentChunks).toHaveLength(1);
      expect(contentChunks[0].ok && contentChunks[0].value.content).toBe('ok');
    });
  });

  // -------------------------------------------------------------------------
  // fetchModelsFromAPI
  // -------------------------------------------------------------------------
  describe('fetchModelsFromAPI', () => {
    it('returns models from the API /models endpoint', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: 'gpt-4' }, { id: 'gpt-4-turbo' }, { id: 'gpt-3.5-turbo' }],
            }),
        })
      );

      const result = await provider.fetchModelsFromAPI();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo']);
      }
    });

    it('sends correct authorization headers', async () => {
      const provider = new OpenAICompatibleProvider({
        ...mockConfig,
        headers: { 'X-Org': 'test-org' },
      });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await provider.fetchModelsFromAPI();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key',
            'X-Org': 'test-org',
          }),
        })
      );
    });

    it('falls back to config models on API error', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      const result = await provider.fetchModelsFromAPI();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(['gpt-4', 'gpt-3.5-turbo']);
      }
    });

    it('falls back to config models on network error', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS fail')));

      const result = await provider.fetchModelsFromAPI();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(['gpt-4', 'gpt-3.5-turbo']);
      }
    });

    it('returns error when provider is not ready', async () => {
      const provider = new OpenAICompatibleProvider({ ...mockConfig, apiKey: '' });

      const result = await provider.fetchModelsFromAPI();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INTERNAL_ERROR');
        expect(result.error.message).toContain('not configured');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Request body construction edge cases
  // -------------------------------------------------------------------------
  describe('request body construction', () => {
    it('omits tools when provider does not support toolUse', async () => {
      const provider = new OpenAICompatibleProvider({
        ...mockConfig,
        features: { ...mockConfig.features, toolUse: false },
      });
      const fetchMock = mockFetchResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      });
      vi.stubGlobal('fetch', fetchMock);

      await provider.complete(
        makeRequest({
          tools: [
            {
              name: 'test',
              description: 'test',
              parameters: { type: 'object', properties: {} },
            },
          ],
        })
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tools).toBeUndefined();
    });

    it('includes response_format when jsonMode is enabled and requested', async () => {
      const provider = new OpenAICompatibleProvider(mockConfig);
      const fetchMock = mockFetchResponse({
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      });
      vi.stubGlobal('fetch', fetchMock);

      await provider.complete(makeRequest({ model: { model: 'gpt-4', responseFormat: 'json' } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('omits response_format when provider does not support jsonMode', async () => {
      const provider = new OpenAICompatibleProvider({
        ...mockConfig,
        features: { ...mockConfig.features, jsonMode: false },
      });
      const fetchMock = mockFetchResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      });
      vi.stubGlobal('fetch', fetchMock);

      await provider.complete(makeRequest({ model: { model: 'gpt-4', responseFormat: 'json' } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.response_format).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Convenience factory functions
  // -------------------------------------------------------------------------
  describe('convenience factories', () => {
    it('createOpenAICompatibleProvider delegates to fromProviderId', async () => {
      mockResolveProviderConfig.mockReturnValue(mockConfig);

      const { createOpenAICompatibleProvider } = await import('./openai-compatible.js');
      const provider = createOpenAICompatibleProvider('openai');

      expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
      expect(mockResolveProviderConfig).toHaveBeenCalledWith('openai');
    });
  });
});
