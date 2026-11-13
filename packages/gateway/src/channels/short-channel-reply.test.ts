import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ complete: vi.fn(), provider: vi.fn() }));
vi.mock('@ownpilot/core/agent', () => ({ createProvider: mock.provider }));
vi.mock('../services/llm/model-routing.js', () => ({
  resolveForChannel: async () => ({ provider: 'ollama-local', model: 'local-test' }),
}));
vi.mock('../services/agent/cache.js', () => ({
  loadProviderConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
  getProviderApiKey: async () => 'unit-test-key',
  NATIVE_PROVIDERS: new Set(),
}));
vi.mock('../services/auth/oauth-flow.js', () => ({ resolveAuthForRequest: async () => null }));
import { writeShortChannelReply } from './short-channel-reply.js';

beforeEach(() => {
  vi.clearAllMocks();
  mock.provider.mockReturnValue({ complete: mock.complete });
  mock.complete.mockResolvedValue({ ok: true, value: { content: ' {"planos":[]} ' } });
});
describe('bounded short channel completion', () => {
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
