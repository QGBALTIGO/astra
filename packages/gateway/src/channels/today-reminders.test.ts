import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';
import { tryListTodaysReminders } from './today-reminders.js';

const db = vi.hoisted(() => ({ account: vi.fn(), list: vi.fn() }));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: db.account },
}));
vi.mock('../db/repositories/channel-reminders.js', () => ({
  channelRemindersRepo: { listForChatInRange: db.list },
}));
const message = {
  id: 'synthetic',
  text: 'Quais meus lembretes de hoje?',
  platform: 'whatsapp',
  channelPluginId: 'channel.whatsapp.qa',
  platformChatId: 'chat-a',
  timestamp: new Date('2026-11-13T03:59:59Z'),
  attachments: [],
} as unknown as ChannelIncomingMessage;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T04:00:05Z'));
  db.account.mockResolvedValue({ timeZone: 'America/Cuiaba' });
  db.list.mockResolvedValue([
    {
      title: 'Dentista\n*<think>oculto</think>retorno*',
      status: 'delivered',
      remindAt: new Date('2026-11-12T22:40:20Z'),
    },
  ]);
});
afterEach(() => vi.useRealTimers());

describe('today reminders in the authenticated conversation', () => {
  it.each(['whatsapp', 'telegram'] as const)(
    'reads the received local day on both %s entry points',
    async (platform) => {
      const incoming = { ...message, platform, channelPluginId: 'channel.' + platform + '.qa' };
      const user = platform + ':test';
      const process = vi.fn();
      const busAnswer = await processViaBus(
        { process } as never,
        incoming,
        { sessionId: 's', conversationId: null },
        { ownpilotUserId: user },
        {
          sessionsRepo: {} as never,
          getChannel: () => undefined,
          isAccessAllowed: async () => true,
        }
      );
      expect(await processDirectAgent(incoming, user, async () => true)).toBe(busAnswer);
      expect(db.account).toHaveBeenCalledWith(user);
      expect(db.list).toHaveBeenCalledTimes(2);
      expect(db.list).toHaveBeenCalledWith(
        user,
        incoming.channelPluginId,
        'chat-a',
        new Date('2026-11-12T04:00:00Z'),
        new Date('2026-11-13T04:00:00Z'),
        16
      );
      expect(busAnswer).toContain('12/11/2026');
      expect(busAnswer).toContain('18:40:20 · Entregue');
      expect(busAnswer).toContain('Dentista retorno');
      expect(busAnswer).not.toContain('oculto');
      expect(process).not.toHaveBeenCalled();
    }
  );
  it('does not read the database for blocked WhatsApp access or a missing scope', async () => {
    expect(await processDirectAgent(message, 'whatsapp:test', async () => false)).toContain(
      'inativo'
    );
    expect(await tryListTodaysReminders({ ...message, platformChatId: '' }, 'u')).toContain(
      'identificar'
    );
    expect(db.account).not.toHaveBeenCalled();
    expect(db.list).not.toHaveBeenCalled();
  });
  it.each([
    'Quais são os meus lembretes de hoje?',
    'Liste meus lembretes para hoje.',
    'Astra, mostre os lembretes de hoje, por favor!',
  ])('accepts %s', async (text) => {
    db.list.mockResolvedValue([]);
    expect(await tryListTodaysReminders({ ...message, text }, 'u')).toContain('Nenhum lembrete');
  });
  it.each([
    'Quais meus lembretes de hoje e cancele o terceiro?',
    'Não liste meus lembretes de hoje',
    'Quais meus lembretes de amanhã?',
    'Quais meus lembretes de hoje?\nAgende outro',
    'Quais meus lembretes de hoje da minha mãe?',
  ])('leaves compound or ambiguous text untouched: %s', async (text) => {
    expect(await tryListTodaysReminders({ ...message, text }, 'u')).toBeNull();
    expect(db.account).not.toHaveBeenCalled();
    expect(db.list).not.toHaveBeenCalled();
  });
  it('does not consume a media turn or an unrelated channel', async () => {
    expect(
      await tryListTodaysReminders({ ...message, attachments: [{} as never] }, 'u')
    ).toBeNull();
    expect(await tryListTodaysReminders({ ...message, platform: 'discord' }, 'u')).toBeNull();
    expect(db.account).not.toHaveBeenCalled();
  });
  it('discloses a truncated list only if an additional matching row exists', async () => {
    const rows = Array.from({ length: 16 }, (_, i) => ({
      title: 'Item-' + i,
      status: 'pending',
      remindAt: message.timestamp,
    }));
    db.list.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.slice(0, 15));
    const result = await tryListTodaysReminders(message, 'u');
    expect(result).toContain('Item-14');
    expect(result).not.toContain('Item-15');
    expect(result).toContain('primeiros 15');
    expect(await tryListTodaysReminders(message, 'u')).not.toContain('primeiros 15');
  });
  it('returns an explicit read failure when the database is unavailable', async () => {
    db.list.mockRejectedValue(new Error('sensitive SQL details'));
    expect(await tryListTodaysReminders(message, 'u')).toBe(
      'A lista de avisos não abriu agora. Dá uma olhada em Agenda no painel. Se quiser consultar por aqui depois, pergunte “Quais são meus lembretes de hoje?”'
    );
  });
});
