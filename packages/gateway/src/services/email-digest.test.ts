import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInExecContext } from '@ownpilot/core/agent';
const m = vi.hoisted(() => ({
  binding: vi.fn(),
  run: vi.fn(),
  save: vi.fn(),
  disable: vi.fn(),
  get: vi.fn(),
  write: vi.fn(),
  platform: 'whatsapp',
}));
vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => ({ getChannel: () => ({ getPlatform: () => m.platform }) }),
}));
vi.mock('./customer-integrations.js', () => ({
  customerIntegrationService: { binding: m.binding, run: m.run },
}));
vi.mock('../db/repositories/email-digests.js', () => ({
  emailDigestsRepo: { save: m.save, disable: m.disable, getForChat: m.get },
}));
vi.mock('../channels/short-channel-reply.js', () => ({ writeShortChannelReply: m.write }));
import {
  buildEmailDigest,
  digestEmails,
  manageEmailDigest,
  emailDigestTimeRequested,
} from './email-digest.js';
const ctx = {
  channelPluginId: 'test.channel',
  platformChatId: '5511999999999',
  channelMessageId: 'test-message',
  channelRequestText: 'Todo dia às 8h30 me mande meu resumo dos emails importantes.',
  channelIsPrivate: true,
  externalContentGuard: { seen: false },
};
const mails = [
  {
    id: 'secret-id-1',
    subject: 'Consulta amanhã',
    sender: 'Clínica fictícia',
    snippet: 'Seu compromisso é amanhã às 9h.',
  },
  {
    id: 'secret-id-2',
    subject: 'Pedido hamburgueria',
    sender: 'Fornecedor fictício',
    snippet: 'O pedido de pão chega às 8h.',
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  m.platform = 'whatsapp';
  m.binding.mockResolvedValue({
    account: { id: 'account-a', timeZone: 'America/Cuiaba' },
    connection: { id: 'owned-a' },
  });
  m.save.mockImplementation(async (input) => ({ ...input, id: 'schedule-a', active: true }));
  m.get.mockResolvedValue(null);
  m.disable.mockResolvedValue(true);
  m.run.mockResolvedValue({ untrustedExternalData: { messages: mails } });
  m.write.mockResolvedValue('{"items":[{"index":1,"excerpt":"O pedido de pão chega às 8h."}]}');
});
describe('customer email digests', () => {
  it('reads Composio preview objects and groups repeated messages from the same thread', () => {
    const source = {
      messages: [
        {
          messageId: 'a',
          threadId: 'thread-a',
          sender: 'Pessoa fictícia',
          subject: 'Prazo amanhã',
          messageText: '',
          preview: { body: 'Envie a proposta amanhã às 9h.' },
        },
        {
          messageId: 'b',
          threadId: 'thread-a',
          sender: 'Pessoa fictícia',
          subject: 'Re: Prazo amanhã',
          preview: { body: 'Outra resposta no mesmo assunto.' },
        },
        {
          messageId: 'c',
          threadId: 'thread-b',
          sender: 'Equipe fictícia',
          subject: 'Reunião',
          preview: { body: 'Sua reunião é às 10h.' },
        },
      ],
    };
    const items = digestEmails(source);
    expect(items).toHaveLength(2);
    expect(items[0]?.snippet).toBe('Envie a proposta amanhã às 9h.');
    expect(items[1]?.snippet).toBe('Sua reunião é às 10h.');
    expect(JSON.stringify(items)).not.toMatch(/thread-a|thread-b|messageId/);
  });
  it.each([
    ['Todo dia às 8h30', 8, 30],
    ['às 8 da noite', 20, 0],
    ['Todos os dias 08:30', 8, 30],
    ['8h', 8, 0],
  ])('recognizes an explicitly requested clock: %s', (text, hour, minute) =>
    expect(emailDigestTimeRequested(text, hour, minute)).toBe(true)
  );
  it('does not enable a time guessed by the model', async () => {
    const value = await runInExecContext(
      { ...ctx, channelRequestText: 'Quero receber um resumo diário de emails' },
      () => manageEmailDigest('customer-a', { action: 'enable', hour: 8 })
    );
    expect(value.reply).toContain('hora exata');
    expect(m.save).not.toHaveBeenCalled();
  });
  it.each(['whatsapp', 'telegram'])(
    'binds a daily schedule to the requesting private %s conversation and its own Gmail',
    async (platform) => {
      m.platform = platform;
      const value = await runInExecContext(ctx, () =>
        manageEmailDigest('customer-a', { action: 'enable', hour: 8, minute: 30 })
      );
      expect(m.binding).toHaveBeenCalledWith('customer-a', 'gmail');
      expect(m.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'customer-a',
          platform,
          connectionId: 'owned-a',
          timeZone: 'America/Cuiaba',
          hour: 8,
          minute: 30,
          platformChatId: ctx.platformChatId,
        })
      );
      expect(value.reply).toContain('08:30');
      expect(value.reply).toContain('todos os dias');
      expect(m.run).not.toHaveBeenCalled();
    }
  );
  it.each([{}, { channelIsPrivate: false }, { channelConversationOnly: true }])(
    'never schedules outside an authenticated private turn %#',
    async (override) => {
      await expect(
        runInExecContext(Object.keys(override).length ? { ...ctx, ...override } : {}, () =>
          manageEmailDigest('customer-a', { action: 'enable', hour: 8 })
        )
      ).rejects.toThrow();
      expect(m.save).not.toHaveBeenCalled();
      expect(m.run).not.toHaveBeenCalled();
    }
  );
  it('asks for the missing time without silently enabling a schedule', async () => {
    expect(
      (await runInExecContext(ctx, () => manageEmailDigest('customer-a', { action: 'enable' })))
        .reply
    ).toContain('qual horário');
    expect(m.save).not.toHaveBeenCalled();
  });
  it.each([{ hour: 24 }, { hour: -1 }, { hour: 8.5 }, { hour: 8, minute: 60 }, { hour: '8' }])(
    'rejects invalid wall clock values %#',
    async (input) => {
      await expect(
        runInExecContext(ctx, () => manageEmailDigest('customer-a', { action: 'enable', ...input }))
      ).rejects.toThrow();
      expect(m.save).not.toHaveBeenCalled();
    }
  );
  it('allows cancelling even when Gmail has been revoked, without touching other routines', async () => {
    m.binding.mockRejectedValue(new Error('revoked'));
    expect(
      (await runInExecContext(ctx, () => manageEmailDigest('customer-a', { action: 'disable' })))
        .reply
    ).toContain('desativado');
    expect(m.disable).toHaveBeenCalledWith('customer-a', ctx.channelPluginId, ctx.platformChatId);
    expect(m.binding).not.toHaveBeenCalled();
  });
  it('does not treat instructions read from a mailbox as permission for a daily schedule', async () => {
    await expect(
      runInExecContext({ ...ctx, externalContentGuard: { seen: true } }, () =>
        manageEmailDigest('customer-a', { action: 'enable', hour: 8 })
      )
    ).rejects.toThrow('nova mensagem');
    expect(m.save).not.toHaveBeenCalled();
  });
  it('reads only the customer mailbox with a recent useful-mail filter and accepts only real indices/excerpts from AI', async () => {
    m.write.mockResolvedValue(
      '{"items":[{"index":1,"excerpt":"Invented bank transfer"},{"index":1},{"index":99}]}'
    );
    const text = await buildEmailDigest('customer-a', 'test.channel', 'owned-a');
    expect(m.run).toHaveBeenCalledWith(
      'customer-a',
      'gmail',
      'GMAIL_FETCH_EMAILS',
      expect.objectContaining({
        user_id: 'me',
        max_results: 20,
        query: expect.stringContaining('-category:promotions'),
      }),
      undefined,
      'owned-a'
    );
    expect(text).toContain('Pedido hamburgueria');
    expect(text).toContain('O pedido de pão chega às 8h.');
    expect(text).not.toMatch(/Invented|secret-id|Consulta amanhã/);
    expect(m.write.mock.calls[0]![2]).not.toMatch(/secret-id|owned-a|customer-a/);
  });
  it('keeps verified source excerpts when AI is slow and never claims an empty mailbox on provider failure', async () => {
    m.write.mockResolvedValue(null);
    expect(await buildEmailDigest('customer-a', 'test.channel')).toContain('Consulta amanhã');
    m.run.mockRejectedValue(new Error('provider timeout'));
    await expect(buildEmailDigest('customer-a', 'test.channel')).rejects.toThrow();
  });
  it('supports payload headers and distinguishes a valid empty mailbox from a malformed reply', () => {
    expect(
      digestEmails({
        data: {
          messages: [
            {
              id: 'id',
              payload: {
                headers: [
                  { name: 'Subject', value: 'Reunião' },
                  { name: 'From', value: 'Pessoa fictícia' },
                ],
              },
              snippet: 'Hoje',
            },
          ],
        },
      })
    ).toEqual([{ subject: 'Reunião', from: 'Pessoa fictícia', snippet: 'Hoje' }]);
    expect(digestEmails({ messages: [] })).toEqual([]);
    expect(() => digestEmails({ unexpected: true })).toThrow();
  });
});
