import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';
import { tryVerifyCalendarSlot } from './calendar-lookup.js';

const db = vi.hoisted(() => ({ scope: vi.fn(), find: vi.fn(), account: vi.fn() }));
vi.mock('../db/repositories/calendar.js', () => ({ createCalendarRepository: db.scope }));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: db.account },
}));
const question =
  'Confere na minha agenda se a Revisão do orçamento Limoeiro ficou marcada para sexta. Qual a data e que horas ela começa e termina?';
const incoming = {
  id: 'synthetic',
  platform: 'whatsapp',
  channelPluginId: 'channel.whatsapp.qa',
  platformChatId: 'chat-test',
  sender: { platformUserId: 'chat-test' },
  timestamp: new Date('2026-11-12T20:00:00Z'),
  text: question,
  attachments: [],
} as unknown as ChannelIncomingMessage;
const event = {
  title: 'Revisão do orçamento Limoeiro',
  startTime: '2026-11-13T19:00:00Z',
  endTime: '2026-11-13T19:30:00Z',
  timezone: 'America/Cuiaba',
  allDay: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T20:01:00Z'));
  db.scope.mockReturnValue({ findSlotsByTitle: db.find });
  db.account.mockResolvedValue({ timeZone: 'America/Campo_Grande' });
  db.find.mockResolvedValue([event]);
});
afterEach(() => vi.useRealTimers());

describe('verifying a named calendar appointment', () => {
  it.each(['whatsapp', 'telegram'] as const)(
    'answers A04 from persisted appointments on both %s ingress paths',
    async (platform) => {
      const msg = {
        ...incoming,
        platform,
        channelPluginId: 'channel.' + platform + '.qa',
        metadata: platform === 'telegram' ? { chatType: 'private' } : { isGroup: false },
      };
      const user = platform + ':test';
      const process = vi.fn();
      const fromBus = await processViaBus(
        { process } as never,
        msg,
        { sessionId: 's', conversationId: null },
        { ownpilotUserId: user },
        {
          sessionsRepo: {} as never,
          getChannel: () => undefined,
          isAccessAllowed: async () => true,
        }
      );
      expect(await processDirectAgent(msg, user, async () => true)).toBe(fromBus);
      expect(db.scope).toHaveBeenCalledWith(user);
      expect(db.find).toHaveBeenCalledWith(
        ['a Revisão do orçamento Limoeiro', event.title],
        new Date('2026-11-13T04:00:00Z'),
        new Date('2026-11-14T04:00:00Z')
      );
      expect(fromBus).toContain('13/11/2026');
      expect(fromBus).toContain('15:00');
      expect(fromBus).toContain('15:30');
      expect(fromBus).toContain('America/Cuiaba');
      expect(fromBus).not.toContain('America/Campo_Grande');
      expect(process).not.toHaveBeenCalled();
    }
  );
  it.each([undefined, '', 'Legacy/Unknown'])(
    'uses the agenda zone when a legacy event has no usable zone: %s',
    async (timezone) => {
      db.find.mockResolvedValue([{ ...event, timezone }]);
      const answer = await tryVerifyCalendarSlot(incoming, 'test');
      expect(answer).toContain('15:00');
      expect(answer).toContain('America/Campo_Grande');
      expect(answer).not.toContain('Legacy/Unknown');
    }
  );
  it('displays the saved Cuiabá slot and its São Paulo equivalent exactly once', async () => {
    db.account.mockResolvedValue({ timeZone: 'America/Sao_Paulo' });
    const answer = await tryVerifyCalendarSlot(incoming, 'test');
    expect(answer).toContain('13/11/2026, 15:00');
    expect(answer).toContain('13/11/2026, 15:30');
    expect(answer).toContain('Fuso: America/Cuiaba.');
    expect(answer).toContain('Na sua agenda (America/Sao_Paulo)');
    expect(answer).toContain('13/11/2026, 16:00 – 13/11/2026, 16:30');
    expect(answer).not.toContain('17:00');
  });
  it('finds Friday in the account agenda and preserves both civil dates for a cross-zone event, including legacy UTC', async () => {
    db.find.mockResolvedValue([
      {
        ...event,
        timezone: 'UTC',
        startTime: '2026-11-14T03:30:00Z',
        endTime: '2026-11-14T04:30:00Z',
      },
    ]);
    const answer = await tryVerifyCalendarSlot(incoming, 'test');
    expect(db.find).toHaveBeenCalledWith(
      ['a ' + event.title, event.title],
      new Date('2026-11-13T04:00:00Z'),
      new Date('2026-11-14T04:00:00Z')
    );
    expect(answer).toContain('14/11/2026, 03:30');
    expect(answer).toContain('14/11/2026, 04:30');
    expect(answer).toContain('Fuso: UTC');
    expect(answer).toContain('Na sua agenda (America/Campo_Grande)');
    expect(answer).toContain('13/11/2026, 23:30');
    expect(answer).toContain('14/11/2026, 00:30');
  });
  it('keeps all-day dates free of invented start or end hours when zones cross midnight', async () => {
    db.find.mockResolvedValue([
      { ...event, timezone: 'Asia/Tokyo', allDay: true, startTime: '2026-11-13T16:00:00Z' },
    ]);
    const answer = await tryVerifyCalendarSlot(incoming, 'test');
    expect(answer).toContain('Dia inteiro');
    expect(answer).toContain('14/11/2026');
    expect(answer).toContain('13/11/2026');
    expect(answer).toContain('Fuso: Asia/Tokyo');
    expect(answer).not.toMatch(/Início|Término|\d\d:\d\d/);
  });
  it('separates missing, duplicate, unavailable and missing end-time outcomes', async () => {
    db.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event, event])
      .mockRejectedValueOnce(new Error('internal'))
      .mockResolvedValueOnce([{ ...event, endTime: undefined }]);
    expect(await tryVerifyCalendarSlot(incoming, 'test')).toContain('Não encontrei');
    expect(await tryVerifyCalendarSlot(incoming, 'test')).toContain('mais de um');
    expect(await tryVerifyCalendarSlot(incoming, 'test')).toBe(
      'Sua agenda não abriu por aqui agora. Dá uma olhada em Agenda no painel para conferir os horários.'
    );
    expect(await tryVerifyCalendarSlot(incoming, 'test')).toContain(
      'Sem horário de término registrado'
    );
  });
  it('never turns an action, compound request, group or blocked access into a calendar lookup', async () => {
    for (const text of [
      question + ' Cancele o evento.',
      'Marca na minha agenda para amanhã das 15h às 15h30: Revisão.',
      'Confere na minha agenda se o evento; apague o antigo ficou marcado para sexta.',
    ]) {
      expect(await tryVerifyCalendarSlot({ ...incoming, text }, 'test')).toBeNull();
    }
    expect(await processDirectAgent(incoming, 'test', async () => false)).toContain('inativo');
    expect(db.scope).not.toHaveBeenCalled();
  });
  it.each([
    { platform: 'whatsapp', metadata: { isGroup: true } },
    { platform: 'telegram', metadata: { chatType: 'group' } },
    { platform: 'telegram', metadata: { chatType: 'supergroup' } },
    { platform: 'telegram', metadata: {} },
    { platform: 'telegram', metadata: { chatType: 'private' }, platformChatId: 'another-chat' },
  ] as const)('keeps personal calendar reads inside private chats (%o)', async (group) => {
    const message = { ...incoming, ...group };
    const process = vi.fn();
    const reply = await processViaBus(
      { process } as never,
      message,
      { sessionId: 's', conversationId: null },
      { ownpilotUserId: 'test' },
      { sessionsRepo: {} as never, getChannel: () => undefined, isAccessAllowed: async () => true }
    );
    expect(reply).toContain('conversa privada');
    expect(await processDirectAgent(message, 'test', async () => true)).toBe(reply);
    expect(db.scope).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });
});
