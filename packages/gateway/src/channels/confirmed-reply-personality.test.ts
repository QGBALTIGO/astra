import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ routing: vi.fn(), agent: vi.fn(), chat: vi.fn() }));
vi.mock('../services/llm/model-routing.js', () => ({ resolveForChannel: mocks.routing }));
vi.mock('../services/agent/service.js', () => ({ getOrCreateChatAgent: mocks.agent }));
import {
  maybePersonalizeConfirmedReply,
  safePersonalComment,
} from './confirmed-reply-personality.js';

const record = '✅ *Despesa registrada*\n\n• *Valor:* R$ 1,00\n• *Descrição:* café';
const input = {
  responseText: record,
  channelPluginId: 'channel.whatsapp',
  dataUserId: 'whatsapp:person',
  displayName: 'Gabrieli Silva',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.routing.mockResolvedValue({ provider: 'groq', model: 'small' });
  mocks.agent.mockResolvedValue({ chat: mocks.chat, cancel: vi.fn() });
  mocks.chat.mockResolvedValue({
    ok: true,
    value: { content: 'Pequenos detalhes também contam no fim do mês. 🙂' },
  });
});

describe('Guarded AI personality after a verified record', () => {
  it('adds creative text without rewriting saved facts or permitting tools', async () => {
    const response = await maybePersonalizeConfirmedReply(input);
    expect(response.startsWith(record)).toBe(true);
    expect(response).toContain('Pequenos detalhes');
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    const options = mocks.chat.mock.calls[0]?.[1];
    expect(await options.onBeforeToolCall()).toEqual({
      approved: false,
      reason: 'Somente redação, sem ações.',
    });
  });
  it('falls back to exact verified facts on false model claims', async () => {
    mocks.chat.mockResolvedValueOnce({
      ok: true,
      value: { content: 'Registrei R$ 500,00 no saldo da sua conta.' },
    });
    expect(await maybePersonalizeConfirmedReply(input)).toBe(record);
  });
  it('rejects invented amounts and URLs', () => {
    expect(safePersonalComment('Agora você possui 1.000 reais disponíveis.')).toBeNull();
    expect(safePersonalComment('Confira https://evil.example seu cartão.')).toBeNull();
    expect(safePersonalComment('Um pequeno passo para organizar melhor seu dia.')).toContain(
      'Um pequeno'
    );
  });
  it('falls back if a provider is not configured', async () => {
    mocks.routing.mockResolvedValueOnce({ provider: null, model: null });
    expect(await maybePersonalizeConfirmedReply(input)).toBe(record);
  });
});
