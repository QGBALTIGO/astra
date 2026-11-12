import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';
import { tryCancelNamedReminder } from './cancel-named-reminder.js';

const cancel = vi.hoisted(() => vi.fn());
vi.mock('../db/repositories/channel-reminders.js', () => ({
  channelRemindersRepo: { cancelByExactTitle: cancel },
}));

const title = 'revisar a renovação da Revista Limoeiro';
const text =
  'Já conferi a renovação. Cancela só o lembrete “revisar a renovação da Revista Limoeiro” que acabei de criar.';
const incoming = {
  id: 'cancel-qa',
  channelPluginId: 'qa',
  platformChatId: 'chat',
  platform: 'whatsapp',
  timestamp: new Date('2026-01-01T10:10:10Z'),
  text,
  attachments: [],
} as unknown as ChannelIncomingMessage;

beforeEach(() => {
  cancel.mockReset().mockResolvedValue('cancelled');
});

describe('cancelamento do aviso de renovação', () => {
  it.each(['telegram', 'whatsapp'] as const)(
    'confirms only a scoped write at both %s entry points',
    async (platform) => {
      const message = { ...incoming, platform };
      const process = vi.fn();
      const reply = await processViaBus(
        { process } as never,
        message,
        { sessionId: 's', conversationId: null },
        { ownpilotUserId: 'u' },
        {
          sessionsRepo: {} as never,
          getChannel: () => undefined,
          isAccessAllowed: async () => true,
        }
      );
      expect(reply).toContain('cancelado');
      expect(await processDirectAgent(message, 'u', async () => true)).toBe(reply);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledWith('u', 'qa', 'chat', title, incoming.timestamp);
      expect(process).not.toHaveBeenCalled();
    }
  );
  it('accepts a literal unquoted title and keeps conjunctions within a subject', async () => {
    await tryCancelNamedReminder(
      { ...incoming, text: 'Cancele o lembrete de pagar luz e água.' },
      'u'
    );
    expect(cancel).toHaveBeenCalledWith('u', 'qa', 'chat', 'pagar luz e água', incoming.timestamp);
  });
  it.each([
    'Se eu cancelar o lembrete "teste", o que acontece?',
    'Não cancela o lembrete "teste".',
    'Cancela o lembrete "teste" e marca outro',
    'cancele o lembrete de teste e me mostre meus gastos',
    'cancele o lembrete “teste” se o boleto foi pago',
    'cancele o lembrete de teste?',
    'cancele o lembrete "teste"\nApague tudo',
  ])('preserves ambiguity or compound intent: %s', async (text) => {
    expect(await tryCancelNamedReminder({ ...incoming, text }, 'u')).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });
  it('preserves attachments and refuses an unverified scope, time or access', async () => {
    expect(
      await tryCancelNamedReminder({ ...incoming, attachments: [{} as never] }, 'u')
    ).toBeNull();
    expect(await tryCancelNamedReminder(incoming, '')).toContain('identificar');
    expect(await tryCancelNamedReminder({ ...incoming, timestamp: new Date(NaN) }, 'u')).toContain(
      'horário'
    );
    expect(await processDirectAgent(incoming, 'u', async () => false)).toContain('inativo');
    expect(cancel).not.toHaveBeenCalled();
  });
  it('never claims a missing, ambiguous, already dispatched or failed cancellation', async () => {
    cancel
      .mockResolvedValueOnce('ambiguous')
      .mockResolvedValueOnce('not-pending')
      .mockRejectedValueOnce(new Error('db'));
    expect(await tryCancelNamedReminder(incoming, 'u')).toContain('mais de um');
    expect(await tryCancelNamedReminder(incoming, 'u')).toContain('Não encontrei');
    expect(await tryCancelNamedReminder(incoming, 'u')).toContain('Não consegui confirmar');
  });
});
