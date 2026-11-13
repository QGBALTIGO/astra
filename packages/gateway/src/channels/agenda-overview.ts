import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { CalendarRepository } from '../db/repositories/calendar.js';
import { channelRemindersRepo } from '../db/repositories/channel-reminders.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { customerDayStart, customerLocalDay } from '../services/customer-date.js';
import { formatAstraMessage } from './response-presentation.js';
import { stripInternalTags } from './normalizers/base.js';

export async function tryAgendaOverview(
  message: ChannelIncomingMessage,
  userId: string
): Promise<string | null> {
  const input = message.text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const noun = '(?:lembretes?|agendamentos?|compromissos?)';
  if (
    !new RegExp(
      '^(?:astra[, ]+)?(?:tenho (?:algum(?:a)?s? )?' +
        noun +
        '(?: (?:ou|e) (?:algum(?:a)?s? )?' +
        noun +
        ')?|(?:quais (?:sao )?|liste |mostre )(?:os )?(?:meus )?' +
        noun +
        ' (?:e|ou) (?:os )?(?:meus )?' +
        noun +
        ')(?: pendentes)?[ ?!.]*$'
    ).test(input)
  )
    return null;
  if (
    message.attachments?.length ||
    !['whatsapp', 'telegram'].includes(message.platform) ||
    message.metadata?.isGroup === true ||
    (message.platform === 'telegram' && message.metadata?.chatType !== 'private') ||
    !userId ||
    !message.platformChatId ||
    message.sender.platformUserId !== message.platformChatId
  )
    return null;
  let timeZone: string;
  try {
    timeZone =
      (await customerAccountsRepo.getByDataUserId(userId))?.timeZone ?? 'America/Sao_Paulo';
  } catch {
    return 'Não consegui consultar sua agenda e seus lembretes agora. Pode tentar de novo em instantes?';
  }
  const now = message.timestamp ?? new Date();
  const introPromise = import('./short-channel-reply.js')
    .then(({ writeShortChannelReply }) =>
      writeShortChannelReply(
        message.channelPluginId,
        'Escreva uma frase acolhedora de até oito palavras para apresentar uma consulta de agenda e lembretes. Sem números, estados, ações realizadas, promessas ou informações que não foram consultadas. Só a frase.',
        'Consulta de agenda e lembretes',
        26,
        Date.now() + 1800
      )
    )
    .catch(() => null);
  const results = await Promise.allSettled([
    channelRemindersRepo.listActiveForChat(
      userId,
      message.channelPluginId,
      message.platformChatId,
      16
    ),
    new CalendarRepository(userId).list({
      startAfter: customerDayStart(customerLocalDay(now, timeZone), timeZone),
      limit: 16,
    }),
  ]);
  const clock = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const title = (s: string) =>
    stripInternalTags(s)
      .replace(/<[^>]*>|[\r\n*_]/g, ' ')
      .trim()
      .slice(0, 140);
  const blocks: string[] = [];
  const [reminders, events] = results;
  if (reminders.status === 'fulfilled')
    blocks.push(
      reminders.value.length
        ? formatAstraMessage(
            '⏰ Seus lembretes pendentes',
            reminders.value
              .slice(0, 15)
              .map((r) => ({ label: clock.format(r.remindAt), value: title(r.title) })),
            reminders.value.length > 15 ? 'Mostrando os primeiros 15 lembretes.' : undefined
          )
        : '⏰ Você não tem lembretes pendentes nesta conversa.'
    );
  else blocks.push('⏰ Não consegui consultar seus lembretes agora.');
  if (events.status === 'fulfilled')
    blocks.push(
      events.value.length
        ? formatAstraMessage(
            '📅 Compromissos de hoje em diante',
            events.value
              .slice(0, 15)
              .map((e) => ({ label: clock.format(new Date(e.startTime)), value: title(e.title) })),
            events.value.length > 15 ? 'Mostrando os primeiros 15 compromissos.' : undefined
          )
        : '📅 Você não tem compromissos marcados de hoje em diante.'
    );
  else blocks.push('📅 Não consegui consultar sua agenda agora.');
  const candidate = await introPromise;
  const { safePersonalComment } = await import('./confirmed-reply-personality.js');
  const intro = typeof candidate === 'string' ? safePersonalComment(candidate) : null;
  return (intro ? intro + '\n\n' : '') + blocks.join('\n\n');
}
