import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const f = vi.hoisted(() => ({
  list: vi.fn(),
  remember: vi.fn(),
  cancel: vi.fn(),
  account: vi.fn(),
}));
vi.mock('../db/repositories/channel-reminders.js', () => ({
  channelRemindersRepo: { listPendingForChatInRange: f.list },
}));
vi.mock('../db/repositories/reminder-selection.js', () => ({
  reminderSelectionRepo: { remember: f.remember, cancelSelected: f.cancel },
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: f.account },
}));
import { tryWeekReminderConversation } from './week-reminders.js';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';
const incoming = (text: string) =>
  ({
    id: 'list',
    text,
    platform: 'whatsapp',
    channelPluginId: 'channel.whatsapp',
    platformChatId: 'chat',
    sender: { platformUserId: 'chat' },
    metadata: { chatType: 'private' },
    timestamp: new Date('2026-11-14T22:42:00Z'),
  }) as ChannelIncomingMessage;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T22:43:00Z'));
  f.account.mockResolvedValue({ timeZone: 'America/Cuiaba' });
  f.list.mockResolvedValue([
    { id: 'one', title: 'Conferir recebimento', remindAt: new Date('2026-11-15T23:00:00Z') },
  ]);
});
afterEach(() => vi.useRealTimers());
it.each(['whatsapp', 'telegram'] as const)(
  'uses the same safe selection before AI on both %s paths',
  async (platform) => {
    const message = { ...incoming('Cancele todos'), platform };
    f.cancel.mockResolvedValue({ selected: 3, cancelled: 2 });
    const process = vi.fn();
    const reply = await processViaBus(
      { process } as never,
      message,
      { sessionId: 's', conversationId: null },
      { ownpilotUserId: 'u' },
      { sessionsRepo: {} as never, getChannel: () => undefined, isAccessAllowed: async () => true }
    );
    expect(await processDirectAgent(message, 'u', async () => true)).toBe(reply);
    expect(reply).toContain('Cancelados');
    expect(process).not.toHaveBeenCalled();
  }
);
it.each(['whatsapp', 'telegram'])(
  'filters the actual local calendar week on %s',
  async (platform) => {
    const message = {
      ...incoming('Veja todos meus lembretes da semana'),
      platform,
    } as ChannelIncomingMessage;
    const reply = await tryWeekReminderConversation(message, 'u', async () => true);
    expect(f.list).toHaveBeenCalledWith(
      'u',
      'channel.whatsapp',
      'chat',
      new Date('2026-11-09T04:00:00Z'),
      new Date('2026-11-16T04:00:00Z'),
      51
    );
    expect(reply).toContain('09/11/2026 a 15/11/2026');
    expect(reply).toContain('19:00');
    expect(f.remember).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u' }),
      ['one'],
      'list',
      message.timestamp
    );
  }
);
it('uses the received local day across midnight and supports next week explicitly', async () => {
  vi.setSystemTime(new Date('2026-11-16T04:00:05Z'));
  const msg = incoming('Lembretes da próxima semana');
  msg.timestamp = new Date('2026-11-16T03:59:59Z');
  await tryWeekReminderConversation(msg, 'u', async () => true);
  expect(f.list).toHaveBeenLastCalledWith(
    'u',
    'channel.whatsapp',
    'chat',
    new Date('2026-11-16T04:00:00Z'),
    new Date('2026-11-23T04:00:00Z'),
    51
  );
});
it.each([
  'Não cancele todos',
  'Se eu disser cancele todos?',
  'Cancele todos menos o remédio',
  'Cancele todos os gastos',
  'Veja meus lembretes da semana e mude para amanhã',
])('does not infer a batch mutation from %s', async (text) => {
  expect(await tryWeekReminderConversation(incoming(text), 'u', async () => true)).toBeNull();
  expect(f.cancel).not.toHaveBeenCalled();
  expect(f.list).not.toHaveBeenCalled();
});
it('shows truthful partial cancellation and does not fall through to an agent retry', async () => {
  f.cancel.mockResolvedValue({ selected: 3, cancelled: 2 });
  const reply = await tryWeekReminderConversation(incoming('Cancele todos'), 'u', async () => true);
  expect(reply).toContain('Cancelados');
  expect(reply).toContain('2');
  expect(reply).toContain('já não estavam pendentes');
});
it('asks for a current list when there is no safe selection', async () => {
  f.cancel.mockResolvedValue(null);
  expect(
    await tryWeekReminderConversation(incoming('Cancele todos'), 'u', async () => true)
  ).toContain('Quais lembretes');
});
