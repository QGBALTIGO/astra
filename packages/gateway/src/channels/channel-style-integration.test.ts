import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({ getByDataUserId: vi.fn(), updateProfile: vi.fn() }));
vi.mock('../db/repositories/customer-accounts.js', () => ({ customerAccountsRepo: repo }));

import { processDirectAgent, processViaBus, tryClockChannelReply } from './channel-ai-routing.js';
import { whatsappNormalizer } from './normalizers/whatsapp.js';
import { safeChannelResponse } from './response-safety.js';

const userId = 'whatsapp:style-customer';
const account = { id: 'style-account', dataUserId: userId, timeZone: 'America/Sao_Paulo' };
const message = {
  id: 'style-message',
  platform: 'whatsapp' as const,
  channelPluginId: 'channel.whatsapp',
  platformChatId: 'synthetic-chat',
  text: 'Meu fuso horário é do Mato Grosso do Sul',
  timestamp: new Date('2026-11-11T16:45:00Z'),
  attachments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  repo.getByDataUserId.mockResolvedValue({ ...account });
  repo.updateProfile.mockImplementation(async (_id, patch) => ({ ...account, ...patch }));
});

describe('Astra presentation across the final channel boundary', () => {
  it.each(['bus', 'direct'] as const)(
    'persists timezone before using the model in %s',
    async (path) => {
      const bus = { process: vi.fn() };
      const response =
        path === 'bus'
          ? await processViaBus(
              bus as never,
              message as never,
              { sessionId: 'style-session', conversationId: null },
              { ownpilotUserId: userId },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => true,
              }
            )
          : await processDirectAgent(message as never, userId, async () => true);
      expect(response).toContain('✅ *Fuso atualizado*');
      expect(response).toContain('*Fuso:* Mato Grosso do Sul (UTC−4)');
      expect(repo.updateProfile).toHaveBeenCalledExactlyOnceWith('style-account', {
        timeZone: 'America/Campo_Grande',
      });
      expect(bus.process).not.toHaveBeenCalled();
      expect(response).not.toMatch(/reagendado|GMT-3|style-account/);
    }
  );

  it.each(['bus', 'direct'] as const)(
    'cannot change a revoked customer through %s',
    async (path) => {
      const bus = { process: vi.fn() };
      const response =
        path === 'bus'
          ? await processViaBus(
              bus as never,
              message as never,
              { sessionId: 'style-session', conversationId: null },
              { ownpilotUserId: userId },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => false,
              }
            )
          : await processDirectAgent(message as never, userId, async () => false);
      expect(response).toContain('inativo');
      expect(repo.getByDataUserId).not.toHaveBeenCalled();
      expect(repo.updateProfile).not.toHaveBeenCalled();
      expect(bus.process).not.toHaveBeenCalled();
    }
  );

  it('reads the saved customer clock with minutes in the shared visual style', async () => {
    repo.getByDataUserId.mockResolvedValue({ ...account, timeZone: 'America/Campo_Grande' });
    const response = await tryClockChannelReply('Que horas são agora?', userId, message.timestamp);
    expect(response).toContain('🕒 *Horário atual*');
    expect(response).toContain('11/11/2026, 12:45');
    expect(response).toContain('Campo Grande');
    expect(response).not.toContain('America/');
  });

  it('preserves WhatsApp bold and saved details through the outgoing normalizer', () => {
    const response = safeChannelResponse('Confirmei um lançamento financeiro salvo.', [
      {
        name: 'core.record_transaction',
        arguments: '',
        isError: false,
        content: JSON.stringify({
          success: true,
          result: {
            transaction: {
              id: 'synthetic-internal-id',
              type: 'income',
              status: 'settled',
              amount: 20,
              date: '2026-11-11',
              description: 'Recebimento',
              categoryName: 'Outras entradas',
            },
          },
        }),
      },
    ]);
    const outgoing = whatsappNormalizer.normalizeOutgoing(response);
    expect(outgoing).toEqual([response]);
    expect(outgoing[0]).toContain('✅ *Entrada registrada*\n\n');
    expect(outgoing[0]).toContain('• *Valor:* R$ 20,00');
    expect(outgoing[0]).toContain('• *Data:* 11/11/2026');
    expect(outgoing[0]).not.toMatch(/\*\*|synthetic-internal-id|core\.|Confirmei/);
  });
});
