import { channelDataFailure } from './channel-failure.js';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { createCalendarRepository } from '../db/repositories/calendar.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { addCalendarDays, customerDayStart, customerLocalDay } from '../services/customer-date.js';
import { formatAstraMessage } from './response-presentation.js';
import { resolveCustomerTimeZone } from './timezone-routing.js';

const weekdays = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const namedSlotQuestion =
  /^(?:confere|confira|verifique) na minha agenda se (.{1,160}?) (?:ficou|está|foi) (?:marcad[oa]|agendad[oa]) (?:para|pra|na|no) (?:[ao] )?(domingo|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado)(?:-feira)?[.?]?(?: qual a data e que horas (?:el[ae] )?começa e termina\?)?$/iu;

/** Confirm a saved appointment by title; a failed earlier write is not evidence of a slot. */
export async function tryVerifyCalendarSlot(
  message: ChannelIncomingMessage,
  userId: string
): Promise<string | null> {
  if (
    (message.platform !== 'whatsapp' && message.platform !== 'telegram') ||
    message.attachments?.length ||
    message.text.length > 350
  )
    return null;
  const match = namedSlotQuestion.exec(message.text.trim());
  if (!match) return null;
  const title = match[1]!.trim();
  if (
    !title ||
    /[?!;\r\n<>]|\b(?:agende|cancele|apague|exclua|remarque|reagende|altere|salve|envie)\b/iu.test(
      title
    )
  )
    return null;
  if (!userId || !message.platformChatId)
    return 'Não consegui identificar sua agenda para fazer a consulta.';
  if (
    message.metadata?.isGroup === true ||
    message.sender?.platformUserId !== message.platformChatId ||
    (message.platform === 'telegram' && message.metadata?.chatType !== 'private')
  )
    return 'Abra uma conversa privada com o Astra para consultar sua agenda.';
  try {
    const account = await customerAccountsRepo.getByDataUserId(userId);
    const timeZone = account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande';
    const now = new Date();
    const received = message.timestamp;
    const today = customerLocalDay(
      received && received.getTime() <= now.getTime() ? received : now,
      timeZone
    );
    const weekday = match[2]!.toLowerCase().replace('sabado', 'sábado').replace('terca', 'terça');
    const offset = (weekdays.indexOf(weekday) - new Date(today + 'T12:00:00Z').getUTCDay() + 7) % 7;
    const day = addCalendarDays(today, offset);
    const date = day.split('-').reverse().join('/');
    const titles = [...new Set([title, title.replace(/^[ao] /iu, '')])];
    const slots = await createCalendarRepository(userId).findSlotsByTitle(
      titles,
      customerDayStart(day, timeZone),
      customerDayStart(addCalendarDays(day, 1), timeZone)
    );
    if (!slots.length)
      return `Não encontrei um compromisso com esse título na sua agenda de ${date}.`;
    if (slots.length > 1)
      return `Encontrei mais de um compromisso com esse título em ${date}. Qual é o horário de início que você procura?`;
    const event = slots[0]!;
    // The requested weekday belongs to the customer's agenda. Present the matching
    // event in its saved zone, and keep the customer's clock visible if it differs.
    const eventZone = (event.timezone && resolveCustomerTimeZone(event.timezone)) || timeZone;
    const times = (zone: string) => {
      const format = new Intl.DateTimeFormat('pt-BR', {
        timeZone: zone,
        dateStyle: 'short',
        ...(event.allDay ? {} : { timeStyle: 'short' as const }),
      });
      return {
        start: format.format(new Date(event.startTime)),
        end: !event.allDay && event.endTime ? format.format(new Date(event.endTime)) : null,
      };
    };
    const saved = times(eventZone);
    const fields = [{ label: 'Compromisso', value: event.title }];
    if (event.allDay) fields.push({ label: 'Dia inteiro', value: saved.start });
    else
      fields.push(
        { label: 'Início', value: saved.start },
        { label: 'Término', value: saved.end ?? 'Sem horário de término registrado' }
      );
    if (eventZone !== timeZone) {
      const local = times(timeZone);
      if (saved.start !== local.start || saved.end !== local.end)
        fields.push({
          label: `Na sua agenda (${timeZone})`,
          value: local.end ? local.start + ' – ' + local.end : local.start,
        });
    }
    return formatAstraMessage('📅 Na sua agenda', fields, `Fuso: ${eventZone}.`);
  } catch (error) {
    return channelDataFailure('calendar', 'read', error);
  }
}
