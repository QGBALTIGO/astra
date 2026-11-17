import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  complete: vi.fn(),
  provider: vi.fn(),
  fallback: vi.fn(),
  key: vi.fn(),
  config: vi.fn(),
  route: vi.fn(),
}));
vi.mock('@ownpilot/core/agent', () => ({
  createProvider: mock.provider,
  createFallbackProvider: mock.fallback,
}));
vi.mock('../services/llm/model-routing.js', () => ({
  resolveForChannel: mock.route,
}));
vi.mock('../services/agent/cache.js', () => ({
  loadProviderConfig: mock.config,
  getProviderApiKey: mock.key,
  NATIVE_PROVIDERS: new Set(),
}));
vi.mock('../services/auth/oauth-flow.js', () => ({ resolveAuthForRequest: async () => null }));
import { writeShortChannelReply } from './short-channel-reply.js';

beforeEach(() => {
  vi.clearAllMocks();
  mock.provider.mockReturnValue({ complete: mock.complete });
  mock.fallback.mockReturnValue({ complete: mock.complete });
  mock.config.mockReturnValue({ baseUrl: 'https://example.invalid/v1' });
  mock.key.mockResolvedValue('unit-test-key');
  mock.route.mockResolvedValue({ provider: 'ollama-local', model: 'local-test' });
  mock.complete.mockResolvedValue({
    ok: true,
    value: { content: ' {"planos":[]} ', finishReason: 'stop' },
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('bounded short channel completion', () => {
  it.each(['length', 'content_filter', 'tool_calls', 'error', undefined])(
    'discards an incomplete or filtered completion: %s',
    async (finishReason) => {
      mock.complete.mockResolvedValue({
        ok: true,
        value: { content: 'Kayky, desp', finishReason },
      });
      expect(
        await writeShortChannelReply(
          'channel.whatsapp',
          'Converse.',
          'Despesa',
          42,
          Date.now() + 5000
        )
      ).toBeNull();
    }
  );
  it('shares configured free-provider health so personality and summaries do not retry an exhausted primary', async () => {
    vi.stubEnv('ASTRA_FALLBACK_CHAIN', 'google=gemini-2.5-flash-lite,openrouter=paid-model');
    await writeShortChannelReply('channel.whatsapp', 'Converse.', 'Café', 42, Date.now() + 5000);
    expect(mock.fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        sharedCircuitBreaker: true,
        preferLastSuccessful: true,
        completionTimeoutMs: expect.any(Number),
        fallbacks: [
          expect.objectContaining({
            id: 'google',
            defaultModel: { model: 'gemini-2.5-flash-lite' },
          }),
        ],
      })
    );
    expect(mock.complete.mock.calls[0]![0]).not.toHaveProperty('tools');
  });
  it('allows lower sampling for factual advice without changing creative openings', async () => {
    await writeShortChannelReply(
      'channel.whatsapp',
      'Oriente sem supor.',
      'Dúvida fictícia',
      120,
      Date.now() + 5000,
      'text',
      0.3
    );
    expect(mock.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.objectContaining({ temperature: 0.3 }) })
    );
  });
  it('allows a Cloudflare 12-second attempt without changing the other short attempt limits', async () => {
    vi.stubEnv(
      'ASTRA_FALLBACK_CHAIN',
      'cloudflare-workers-ai=@cf/zai-org/glm-4.7-flash,openrouter=openrouter/free'
    );
    await writeShortChannelReply(
      'channel.whatsapp',
      'Synthetic',
      'Synthetic',
      42,
      Date.now() + 30000
    );
    expect(mock.fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: expect.objectContaining({ timeout: 2500 }),
        fallbacks: [
          expect.objectContaining({ id: 'cloudflare-workers-ai', timeout: 12000 }),
          expect.objectContaining({ id: 'openrouter', timeout: 3000 }),
        ],
        completionTimeoutMs: expect.any(Number),
      })
    );
  });
  it('leaves 2.5 seconds for a real fallback after a stalled short primary attempt', async () => {
    const actualCore =
      await vi.importActual<typeof import('@ownpilot/core/agent')>('@ownpilot/core/agent');
    mock.fallback.mockImplementationOnce(actualCore.createFallbackProvider);
    mock.route.mockResolvedValue({ provider: 'groq', model: 'openai/gpt-oss-120b' });
    mock.config.mockImplementation((provider: string) => ({
      type: 'openai-compatible',
      baseUrl:
        provider === 'groq'
          ? 'https://api.groq.com/openai/v1'
          : 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1',
    }));
    vi.stubEnv('ASTRA_FALLBACK_CHAIN', 'cloudflare-workers-ai=@cf/zai-org/glm-4.7-flash');
    // All HTTP is intercepted; no DNS or real upstream credentials are used.
    vi.stubEnv('OWNPILOT_ALLOW_LOCAL_LLM_URL', 'true');
    vi.useFakeTimers();
    const started = Date.now();
    const calls: Array<{ host: string; elapsed: number }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        calls.push({ host: url.hostname, elapsed: Date.now() - started });
        if (url.hostname === 'api.groq.com') return new Promise<Response>(() => {});
        await new Promise((resolve) => setTimeout(resolve, 2400));
        return new Response(
          JSON.stringify({
            model: '@cf/zai-org/glm-4.7-flash',
            choices: [{ message: { content: 'Backup confirmado.' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    try {
      const reply = writeShortChannelReply(
        'channel.whatsapp',
        'Synthetic',
        'Synthetic',
        42,
        started + 5000
      );
      await vi.advanceTimersByTimeAsync(2500);
      expect(calls).toEqual([
        { host: 'api.groq.com', elapsed: 0 },
        { host: 'api.cloudflare.com', elapsed: 2500 },
      ]);
      await vi.advanceTimersByTimeAsync(2400);
      expect(await reply).toBe('Backup confirmado.');
      expect(Date.now() - started).toBe(4900);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it('never extends a short reply caller deadline to fit Cloudflare', async () => {
    vi.stubEnv('ASTRA_FALLBACK_CHAIN', 'cloudflare-workers-ai=@cf/zai-org/glm-4.7-flash');
    await writeShortChannelReply(
      'channel.whatsapp',
      'Synthetic',
      'Synthetic',
      42,
      Date.now() + 4000
    );
    const config = mock.fallback.mock.calls[0]![0];
    expect(config.primary.timeout).toBeLessThanOrEqual(4000);
    expect(config.fallbacks[0].timeout).toBeLessThanOrEqual(4000);
    expect(config.completionTimeoutMs).toBeLessThanOrEqual(4000);
  });
  it('preserves short attempt limits when Cloudflare has no credential', async () => {
    vi.stubEnv(
      'ASTRA_FALLBACK_CHAIN',
      'cloudflare-workers-ai=@cf/zai-org/glm-4.7-flash,openrouter=openrouter/free'
    );
    mock.key.mockImplementation(async (provider: string) =>
      provider === 'cloudflare-workers-ai' ? undefined : 'unit-test-key'
    );
    await writeShortChannelReply(
      'channel.whatsapp',
      'Synthetic',
      'Synthetic',
      42,
      Date.now() + 30000
    );
    expect(mock.fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: expect.objectContaining({ timeout: 2500 }),
        fallbacks: [expect.objectContaining({ id: 'openrouter', timeout: 3000 })],
      })
    );
  });
  it('requests valid JSON without sampling and passes the same deadline to the local bridge', async () => {
    const deadline = Date.now() + 5000;
    expect(
      await writeShortChannelReply(
        'channel.whatsapp',
        'Extraia JSON.',
        'Exemplo fictício',
        200,
        deadline,
        'json'
      )
    ).toBe('{"planos":[]}');
    expect(mock.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ responseFormat: 'json', temperature: 0, maxTokens: 200 }),
      })
    );
    expect(mock.provider).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
        headers: expect.objectContaining({ 'X-Astra-Deadline': String(deadline) }),
      })
    );
  });
  it('retains sampling for conversational replies and never starts an already expired request', async () => {
    await writeShortChannelReply('channel.whatsapp', 'Converse.', 'Oi', 40, Date.now() + 5000);
    expect(mock.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ responseFormat: 'text', temperature: 0.75 }),
      })
    );
    mock.provider.mockClear();
    expect(
      await writeShortChannelReply('channel.whatsapp', 'Converse.', 'Oi', 40, Date.now() - 1)
    ).toBeNull();
    expect(mock.provider).not.toHaveBeenCalled();
  });
});
