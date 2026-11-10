import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  financing: vi.fn(),
  recordExpense: vi.fn(),
  expenseTool: vi.fn(),
  reminderTool: vi.fn(),
  resolveRouting: vi.fn(),
}));

vi.mock('@ownpilot/core/agent', () => ({
  runInExecContext: (_context: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@ownpilot/core/costs', () => ({ pricingByExactKey: new Map() }));
vi.mock('./finance-routing.js', () => ({
  tryFinancingChannelReply: mocks.financing,
  tryExpenseRecordChannelReply: mocks.recordExpense,
}));
vi.mock('../tools/expense-tools.js', () => ({ executeExpenseTool: mocks.expenseTool }));
vi.mock('../tools/channel-reminder-tools.js', () => ({
  executeChannelReminderTool: mocks.reminderTool,
}));
vi.mock('../services/agent/service.js', () => ({
  getOrCreateChatAgent: mocks.getAgent,
  isDemoMode: async () => false,
}));
vi.mock('../services/llm/model-routing.js', () => ({
  resolveForChannel: mocks.resolveRouting,
  inferProviderForModel: () => 'openai',
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: async () => null },
}));
vi.mock('./normalizers/index.js', () => ({
  getNormalizer: () => ({
    normalizeIncoming: async (message: ChannelIncomingMessage) => ({ text: message.text }),
    normalizeOutgoing: (text: string) => [text],
  }),
}));
vi.mock('./normalizers/media-understanding.js', () => ({
  enrichWhatsAppMedia: async (_message: unknown, incoming: unknown) => incoming,
}));
vi.mock('../utils/memory-extraction.js', () => ({
  extractMemoriesFromResponse: (content: string) => ({ content }),
}));

import { ASTRA_ACCESS_REPLY } from './astra-access.js';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';

const agent = {
  getConversation: () => ({ id: 'conversation-access', systemPrompt: 'assistant' }),
  setRequestApproval: vi.fn(),
  getAllToolDefinitions: () => [],
  chat: vi.fn(),
};
const bus = { process: vi.fn() };

function incoming(overrides: Partial<ChannelIncomingMessage> = {}): ChannelIncomingMessage {
  return {
    id: 'access-question',
    channelPluginId: 'channel.whatsapp',
    platform: 'whatsapp',
    platformChatId: 'chat-access',
    sender: { platformUserId: 'sender-access', platform: 'whatsapp' },
    text: 'Onde acesso o dashboard?',
    timestamp: new Date('2026-11-10T16:18:00Z'),
    attachments: [],
    ...overrides,
  };
}

describe.each(['bus', 'direct'] as const)(
  'Official access instructions through %s routing',
  (path) => {
    const isAccessAllowed = vi.fn();
    const getById = vi.fn();

    async function route(message = incoming(), withGuard = true) {
      const guard = withGuard ? isAccessAllowed : undefined;
      return path === 'bus'
        ? processViaBus(
            bus as never,
            message,
            { sessionId: 'session-access', conversationId: null },
            { ownpilotUserId: 'whatsapp:sender-access' },
            {
              sessionsRepo: { getById } as never,
              getChannel: () => undefined,
              isAccessAllowed: guard,
            }
          )
        : processDirectAgent(message, 'whatsapp:sender-access', guard);
    }

    beforeEach(() => {
      vi.resetAllMocks();
      mocks.financing.mockResolvedValue(null);
      mocks.recordExpense.mockResolvedValue(null);
      mocks.resolveRouting.mockResolvedValue({ provider: 'openai', model: 'gpt-4o' });
      mocks.getAgent.mockResolvedValue(agent);
      agent.chat.mockResolvedValue({ ok: true, value: { content: 'Provider response' } });
      bus.process.mockResolvedValue({ response: { content: 'Provider response' } });
      isAccessAllowed.mockResolvedValue(true);
      getById.mockResolvedValue(null);
    });

    it.each(['whatsapp', 'telegram'] as const)(
      'answers %s without AI, finance, reminders or session work after checking access',
      async (platform) => {
        const reply = await route(incoming({ platform, channelPluginId: `channel.${platform}` }));

        expect(reply).toBe(ASTRA_ACCESS_REPLY);
        expect(isAccessAllowed).toHaveBeenCalledTimes(1);
        expect(getById).not.toHaveBeenCalled();
        expect(mocks.getAgent).not.toHaveBeenCalled();
        expect(mocks.resolveRouting).not.toHaveBeenCalled();
        expect(bus.process).not.toHaveBeenCalled();
        expect(agent.chat).not.toHaveBeenCalled();
        expect(mocks.financing).not.toHaveBeenCalled();
        expect(mocks.recordExpense).not.toHaveBeenCalled();
        expect(mocks.expenseTool).not.toHaveBeenCalled();
        expect(mocks.reminderTool).not.toHaveBeenCalled();
      }
    );

    it('keeps an inactive customer behind the existing access guard', async () => {
      isAccessAllowed.mockResolvedValue(false);

      expect(await route()).toBe(
        'O acesso deste número está inativo. Peça ao administrador para autorizar ou renovar seu acesso.'
      );
      expect(isAccessAllowed).toHaveBeenCalledTimes(1);
      expect(mocks.getAgent).not.toHaveBeenCalled();
      expect(bus.process).not.toHaveBeenCalled();
      expect(agent.chat).not.toHaveBeenCalled();
    });

    it('does not bypass WhatsApp access when a caller omits the guard', async () => {
      expect(await route(incoming(), false)).toContain('acesso deste número está inativo');
      expect(mocks.getAgent).not.toHaveBeenCalled();
      expect(bus.process).not.toHaveBeenCalled();
      expect(agent.chat).not.toHaveBeenCalled();
    });

    it.each([
      incoming({ text: 'Astra, onde acesso o dashboard da Vercel?' }),
      incoming({ text: 'Crie um dashboard das minhas despesas' }),
      incoming({
        attachments: [
          { type: 'image', mimeType: 'image/png', url: 'https://example.com/image.png' },
        ],
      }),
    ])('preserves normal routing for another service, a task or media: $text', async (message) => {
      expect(await route(message)).toBe('Provider response');
      expect(mocks.getAgent).toHaveBeenCalledTimes(1);
      if (path === 'bus') {
        expect(bus.process).toHaveBeenCalledTimes(1);
        expect(agent.chat).not.toHaveBeenCalled();
      } else {
        expect(agent.chat).toHaveBeenCalledTimes(1);
        expect(bus.process).not.toHaveBeenCalled();
      }
    });
  }
);
