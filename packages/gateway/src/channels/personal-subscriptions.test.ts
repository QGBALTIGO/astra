import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const change = vi.hoisted(() => vi.fn());
vi.mock('../db/repositories/customer-planning.js', async (original) => ({
  ...(await original<typeof import('../db/repositories/customer-planning.js')>()),
  CustomerPlanningRepository: class {
    changeSubscription = change;
  },
}));
import {
  tryPersonalSubscriptionReply,
  monthlySubscriptionRequest,
} from './personal-subscriptions.js';
beforeEach(() => {
  vi.clearAllMocks();
  change.mockResolvedValue({ status: 'inactive' });
});
describe('natural personal subscription requests', () => {
  it('understands a request to remove only the named subscription from the Astra control', async () => {
    const message = {
      id: 'test-remove',
      text: 'Remova a assinatura Revista Ensaio Ipê do meu controle no Astra.',
      platform: 'whatsapp',
      channelPluginId: 'test.whatsapp',
      platformChatId: 'test-user',
      sender: { platformUserId: 'test-user' },
      metadata: { isGroup: false },
      timestamp: new Date(),
    } as ChannelIncomingMessage;
    await tryPersonalSubscriptionReply(message, 'synthetic', async () => false);
    expect(change).toHaveBeenCalledWith(
      expect.any(String),
      { action: 'remove', title: 'Revista Ensaio Ipê' },
      expect.any(Function)
    );
  });
  it.each([
    ['2026-11-14', '18', '2026-11-18'],
    ['2026-11-22', '18', '2026-12-18'],
    ['2026-12-30', '2', '2027-01-02'],
    ['2028-02-20', '29', '2028-02-29'],
  ])('resolves an explicitly monthly day from the local customer date %s', (today, day, due) => {
    expect(
      monthlySubscriptionRequest(
        `Anota a assinatura Revista Ensaio Ipê por R$ 12,90 mensais, renovação dia ${day}.`,
        today
      )
    ).toBe('Cadastre a assinatura Revista Ensaio Ipê por R$ 12,90 em ' + due);
  });
  it.each([
    'Anota a assinatura Revista por R$ 12,90 mensais, renovação dia 32.',
    'Não anota a assinatura Revista por R$ 12,90 mensais, renovação dia 18.',
    'Anota a assinatura Revista por R$ 12,90 mensais, renovação dia 18. E pague.',
  ])('does not normalize ambiguous or compound changes: %s', (text) =>
    expect(monthlySubscriptionRequest(text, '2026-11-14')).toBe(text)
  );
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
