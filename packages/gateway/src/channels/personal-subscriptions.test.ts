import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const change = vi.hoisted(() => vi.fn());
vi.mock('../db/repositories/customer-planning.js', async (original) => ({
  ...(await original<typeof import('../db/repositories/customer-planning.js')>()),
  CustomerPlanningRepository: class {
    changeSubscription = change;
  },
}));
import { tryPersonalSubscriptionReply } from './personal-subscriptions.js';
beforeEach(() => {
  vi.clearAllMocks();
  change.mockResolvedValue({ status: 'inactive' });
});
describe('natural personal subscription requests', () => {
  it.each(['whatsapp', 'telegram'] as const)(
    'keeps an explicit control request on subscription storage for %s',
    async (platform) => {
      const guard = async () => false;
      const message = {
        id: 'test-msg',
        text: 'Adicione ao meu controle a assinatura Clube Maracujá Ensaio: R$ 3,45 por mês, renovação em 15/12/2026.',
        platform,
        channelPluginId: 'channel.' + platform,
        platformChatId: 'test-user',
        sender: { platformUserId: 'test-user' },
        metadata: { isGroup: false, chatType: 'private' },
        timestamp: new Date('2026-11-13T12:00:00Z'),
      } as ChannelIncomingMessage;
      expect(await tryPersonalSubscriptionReply(message, 'synthetic', guard)).toContain(
        'não foi registrada'
      );
      expect(change).toHaveBeenCalledWith(
        expect.stringMatching(/^[a-f0-9]{64}$/),
        {
          action: 'create',
          title: 'Clube Maracujá Ensaio',
          amount: 3.45,
          nextDueDate: '2026-12-15',
        },
        guard
      );
      change.mockClear();
      await tryPersonalSubscriptionReply(
        { ...message, text: message.text + ' E pague agora.' },
        'synthetic',
        guard
      );
      expect(change).not.toHaveBeenCalled();
    }
  );
});
