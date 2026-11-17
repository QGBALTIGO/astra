import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';

const f = vi.hoisted(() => ({
  list: vi.fn(),
  cancel: vi.fn(),
  remember: vi.fn(),
  account: vi.fn(),
}));
vi.mock('../db/repositories/channel-reminders.js', () => ({
  channelRemindersRepo: { listForChatPage: f.list, cancelPendingForChatBefore: f.cancel },
}));
vi.mock('../db/repositories/reminder-selection.js', () => ({
  reminderSelectionRepo: { remember: f.remember },
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: f.account },
}));

import { parseGeneralReminderRequest, tryGeneralReminderConversation } from './all-reminders.js';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';

const incoming = (text: string, platform: 'whatsapp' | 'telegram' = 'whatsapp') =>
  ({
    id: 'request-a',
    text,
    platform,
    channelPluginId: 'channel.' + platform,
    platformChatId: 'synthetic-chat',
    sender: { platformUserId: 'synthetic-chat' },
    timestamp: new Date('2026-11-17T18:30:00Z'),
    metadata: { chatType: 'private', fromMe: false },
  }) as ChannelIncomingMessage;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T18:35:00Z'));
  f.account.mockResolvedValue({
    id: 'customer-a',
    phoneNumber: 'synthetic-chat',
    timeZone: 'America/Cuiaba',
  });
  f.list.mockResolvedValue({
    items: Array.from({ length: 20 }, (_, i) => ({
      id: 'r' + i,
      title: 'Conferir pedido ' + i,
      remindAt: new Date('2026-11-18T22:15:00Z'),
    })),
    total: 45,
    page: 1,
    pageSize: 20,
    hasMore: true,
  });
  f.cancel.mockImplementation(async (...args) =>
    (await args[5]()) ? { cancelled: 42, alreadySending: 1 } : null
  );
});
afterEach(() => vi.useRealTimers());

describe('explicit general reminder intent', () => {
  it.each([
    'Me diga todos os meus lembretes',
    'Quais são meus lembretes?',
    'Mostre meus lembretes pendentes',
    'Astra, meus lembretes!',
    'Por favor, liste todos os lembretes agendados',
    'Quero ver os meus lembretes',
  ])('recognizes an ordinary list request: %s', (text) => {
    expect(parseGeneralReminderRequest(text)).toEqual({ kind: 'list', page: 1 });
  });
  it.each([
    'Cancele todos os meus lembretes',
    'Pode cancelar todos os lembretes?',
    'Quero cancelar todos meus lembretes',
    'Astra, apague todos os meus lembretes.',
    'Remova todos os lembretes pendentes, por favor',
    'Exclua todos meus lembretes',
  ])('recognizes an explicit complete cancellation: %s', (text) => {
    expect(parseGeneralReminderRequest(text)).toEqual({ kind: 'cancel' });
  });
  it.each([
    'Cancele todos',
    'Cancele todos esses lembretes',
    'Cancele todos os gastos',
    'Não cancele todos meus lembretes',
    'Se eu pedir cancele todos os meus lembretes?',
    'Cancele todos meus lembretes menos o remédio',
    'Cancele todos meus lembretes e as assinaturas',
    'O cliente disse "cancele todos meus lembretes"',
    'Como cancelar todos meus lembretes?',
    'Me diga todos os meus lembretes da semana',
    'Meus lembretes de hoje',
    'Meus lembretes página 0',
    'Meus lembretes página 100001',
    'Cancele todos os meus lembretes. Só quero uma sugestão.',
  ])('does not infer unrelated, selected, hypothetical or partial consent: %s', (text) => {
    expect(parseGeneralReminderRequest(text)).toBeNull();
  });
  it.each(['Meus lembretes página 2', 'Página 2 dos meus lembretes'])(
    'supports explicit pagination: %s',
    (text) => {
      expect(parseGeneralReminderRequest(text)).toEqual({ kind: 'list', page: 2 });
    }
  );
});

describe('factual, scoped reminder operation without an LLM', () => {
  it.each(['whatsapp', 'telegram'] as const)(
    'lists and cancels before provider 429 on bus and direct paths: %s',
    async (platform) => {
      const process = vi.fn().mockRejectedValue(new Error('429 rate_limited'));
      for (const text of ['Me diga todos os meus lembretes', 'Cancele todos os meus lembretes']) {
        const message = incoming(text, platform);
        const reply = await processViaBus(
          { process } as never,
          message,
          { sessionId: 's', conversationId: null },
          { ownpilotUserId: 'customer-data-a' },
          {
            sessionsRepo: {} as never,
            getChannel: () => undefined,
            isAccessAllowed: async () => true,
          }
        );
        expect(await processDirectAgent(message, 'customer-data-a', async () => true)).toBe(reply);
        expect(reply).toContain(text.startsWith('Cancele') ? '42' : '45');
        expect(reply).not.toMatch(/não consegui|tente novamente/i);
      }
      expect(process).not.toHaveBeenCalled();
      expect(f.cancel).toHaveBeenCalledWith(
        'customer-data-a',
        'channel.' + platform,
        'synthetic-chat',
        'request-a',
        incoming('').timestamp,
        expect.any(Function)
      );
    }
  );
  it('shows total, exact local time, page and a supported next-page instruction for more than thirty pending rows', async () => {
    const reply = await tryGeneralReminderConversation(
      incoming('Me diga todos os meus lembretes'),
      'stable-customer-data',
      async () => true
    );
    expect(reply).toContain('45');
    expect(reply).toContain('1 de 3');
    expect(reply).toContain('18:15');
    expect(reply).toContain('Mostrando 20 de 45');
    expect(reply).toContain('meus lembretes página 2');
    expect(f.list).toHaveBeenCalledWith(
      'stable-customer-data',
      'channel.whatsapp',
      'synthetic-chat',
      {
        page: 1,
        pageSize: 20,
        status: 'pending',
        before: incoming('').timestamp,
      }
    );
    expect(f.remember.mock.calls[0]?.[1]).toHaveLength(20);
  });
  it('reads the requested page rather than silently repeating the first thirty rows', async () => {
    f.list.mockResolvedValue({
      items: [{ id: 'r41', title: 'Último aviso', remindAt: new Date('2026-11-18T22:15:00Z') }],
      total: 41,
      page: 3,
      pageSize: 20,
      hasMore: false,
    });
    const reply = await tryGeneralReminderConversation(
      incoming('Meus lembretes página 3'),
      'u',
      async () => true
    );
    expect(reply).toContain('3 de 3');
    expect(reply).toContain('Último aviso');
    expect(f.list.mock.calls[0]?.[3].page).toBe(3);
  });
  it('reports empty pages accurately', async () => {
    f.list.mockResolvedValue({ items: [], total: 41, page: 9, pageSize: 20, hasMore: false });
    expect(
      await tryGeneralReminderConversation(
        incoming('Meus lembretes página 9'),
        'u',
        async () => true
      )
    ).toContain('Há 41 pendentes');
    f.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    expect(
      await tryGeneralReminderConversation(incoming('Meus lembretes'), 'u', async () => true)
    ).toContain('não tem lembretes pendentes');
  });
  it('renders only committed counts and explains actual in-flight sends', async () => {
    const reply = await tryGeneralReminderConversation(
      incoming('Cancele todos os meus lembretes'),
      'u',
      async () => true
    );
    expect(reply).toContain('42');
    expect(reply).toContain('já tinham sido iniciados');
    expect(reply).not.toContain('não serão enviados');
  });
  it('does not turn a database error or uncertain commit into success or a second AI attempt', async () => {
    f.cancel.mockRejectedValue(new Error('commit connection lost'));
    const process = vi.fn().mockRejectedValue(new Error('429'));
    const reply = await processViaBus(
      { process } as never,
      incoming('Cancele todos os meus lembretes'),
      { sessionId: 's', conversationId: null },
      { ownpilotUserId: 'u' },
      { sessionsRepo: {} as never, getChannel: () => undefined, isAccessAllowed: async () => true }
    );
    expect(reply).not.toContain('Lembretes cancelados');
    expect(reply).toMatch(/confirm|cancelamento/i);
    expect(process).not.toHaveBeenCalled();
  });
  it('rechecks access and account binding before revealing the list or cancelling', async () => {
    const allowed = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(
      await tryGeneralReminderConversation(incoming('Meus lembretes'), 'u', allowed)
    ).toContain('acesso');
    expect(f.remember).not.toHaveBeenCalled();
    f.account
      .mockResolvedValueOnce({ id: 'customer-a', phoneNumber: 'before' })
      .mockResolvedValue({ id: 'customer-a', phoneNumber: 'after' });
    expect(
      await tryGeneralReminderConversation(
        incoming('Cancele todos meus lembretes'),
        'u',
        async () => true
      )
    ).toContain('acesso');
  });
  it.each([
    { metadata: { isGroup: true } },
    { metadata: { fromMe: true } },
    { platform: 'telegram', metadata: { chatType: 'group' } },
    { sender: { platformUserId: 'another-person' } },
    { id: '' },
    { attachments: [{ type: 'image' }] },
    { platform: 'discord' },
  ])('rejects non-private, outgoing or foreign scope %j', async (patch) => {
    expect(
      await tryGeneralReminderConversation(
        { ...incoming('Cancele todos meus lembretes'), ...patch } as ChannelIncomingMessage,
        'u',
        async () => true
      )
    ).toBeNull();
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it.each([undefined, new Date('invalid'), new Date('2026-11-17T18:36:00Z')])(
    'rejects an untrusted cutoff %s',
    async (timestamp) => {
      const reply = await tryGeneralReminderConversation(
        { ...incoming('Cancele todos meus lembretes'), timestamp } as ChannelIncomingMessage,
        'u',
        async () => true
      );
      expect(reply).toContain('data deste pedido');
      expect(f.cancel).not.toHaveBeenCalled();
    }
  );
});
