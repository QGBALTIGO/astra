import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const mock = vi.hoisted(() => ({
  account: vi.fn(),
  reminders: vi.fn(),
  events: vi.fn(),
  owner: vi.fn(),
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mock.account },
}));
vi.mock('../db/repositories/channel-reminders.js', () => ({
  channelRemindersRepo: { listActiveForChat: mock.reminders },
}));
vi.mock('../db/repositories/calendar.js', () => ({
  CalendarRepository: class {
    constructor(id: string) {
      mock.owner(id);
    }
    list = mock.events;
  },
}));
vi.mock('./short-channel-reply.js', () => ({ writeShortChannelReply: async () => null }));
import { tryAgendaOverview } from './agenda-overview.js';
const message = {
  text: 'Tenho algum lembrete ou agendamento ?',
  platform: 'whatsapp',
  platformChatId: 'own-chat',
  channelPluginId: 'channel.whatsapp',
  sender: { platformUserId: 'own-chat' },
  timestamp: new Date('2026-11-13T18:00:00Z'),
  metadata: { isGroup: false },
} as ChannelIncomingMessage;
beforeEach(() => {
  vi.clearAllMocks();
  mock.account.mockResolvedValue({ timeZone: 'America/Cuiaba' });
  mock.reminders.mockResolvedValue([]);
  mock.events.mockResolvedValue([]);
});
describe('current personal agenda overview', () => {
  it('reads reminders in the exact chat and appointments in the authenticated account, rendering Cuiaba once', async () => {
    mock.reminders.mockResolvedValue([
      { title: 'Pedido do ensaio', remindAt: new Date('2026-11-14T20:00:00Z') },
    ]);
    mock.events.mockResolvedValue([
      { title: 'Reunião do ensaio', startTime: new Date('2026-11-14T19:00:00Z') },
    ]);
    const reply = await tryAgendaOverview(message, 'whatsapp:own-user');
    expect(mock.reminders).toHaveBeenCalledWith(
      'whatsapp:own-user',
      'channel.whatsapp',
      'own-chat',
      16
    );
    expect(mock.owner).toHaveBeenCalledWith('whatsapp:own-user');
    expect(reply).toContain('16:00');
    expect(reply).toContain('15:00');
    expect(reply).toContain('14/11/2026');
  });
  it('distinguishes an empty list from an unavailable calendar and supports a verified empty result', async () => {
    mock.events.mockRejectedValue(new Error('database unavailable'));
    const partial = await tryAgendaOverview(message, 'own');
    expect(partial).toContain('não tem lembretes');
    expect(partial).toContain('Não consegui consultar sua agenda');
    expect(partial).not.toContain('não tem compromissos');
    mock.events.mockResolvedValue([]);
    expect(await tryAgendaOverview(message, 'own')).toContain('não tem compromissos');
  });
  it('does not interpret a clear command, a group request or another chat as a lookup', async () => {
    expect(
      await tryAgendaOverview({ ...message, text: 'Limpa a agenda e lembretes também' }, 'own')
    ).toBeNull();
    expect(await tryAgendaOverview({ ...message, metadata: { isGroup: true } }, 'own')).toBeNull();
    expect(await tryAgendaOverview({ ...message, platformChatId: 'other-chat' }, 'own')).toBeNull();
    expect(mock.reminders).not.toHaveBeenCalled();
    expect(mock.events).not.toHaveBeenCalled();
  });
});
