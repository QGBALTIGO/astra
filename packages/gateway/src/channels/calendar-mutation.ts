import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import {
  CustomerAgendaRepository,
  type ChannelCalendarMutation,
} from '../db/repositories/customer-agenda.js';
import {
  addCalendarDays,
  customerLocalDateTime,
  customerLocalDay,
  validCalendarDay,
} from '../services/customer-date.js';
import { formatAstraMessage } from './response-presentation.js';
import { resolveCustomerTimeZone } from './timezone-routing.js';

const command =
  /^(?:astra,\s*)?(?:marca|marque|agenda|agende|cria|crie|adicione)\s+(?:(?:um|o)\s+(?:evento|compromisso)\s+)?na minha agenda\b\s*/iu;
const removeCommand = /^(?:astra,\s*)?(?:exclua|remova|apague|cancele)\s+da minha agenda\b\s*/iu;
const deleteHint =
  'Informe o título completo, o dia e o fuso, por exemplo “Exclua da minha agenda o compromisso de DD/MM/AAAA no fuso de Cuiabá: Revisão do orçamento”.';
const months =
  'janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro'.split(
    ' '
  );
const weekdays = 'domingo segunda terça quarta quinta sexta sábado'.split(' ');
const formatHint =
  'Informe a data, o início, o término, o fuso e o título. Use “Marque na minha agenda para DD/MM/AAAA, das 15h às 15h30 de Cuiabá: Revisão do orçamento”.';
const two = (n: number) => String(n).padStart(2, '0');

function requestedDay(description: string, today: string): string | null {
  let date = description.toLocaleLowerCase('pt-BR').trim();
  const relative = /^(hoje|amanhã)(?:,\s*|$)/u.exec(date);
  const expected = relative ? addCalendarDays(today, relative[1] === 'hoje' ? 0 : 1) : null;
  if (relative) date = date.slice(relative[0].length);
  const weekday = /^(domingo|segunda|terça|quarta|quinta|sexta|sábado)(?:-feira)?(?:,\s*|$)/u.exec(
    date
  );
  if (weekday) date = date.slice(weekday[0].length);
  let day = expected;
  if (date) {
    const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
    const named = /^(\d{1,2}) de (\p{L}+)(?: de (\d{4}))?$/u.exec(date);
    if (!numeric && !named) return null;
    const year = numeric?.[3] ?? named?.[3] ?? expected?.slice(0, 4);
    if (!year) return null;
    const month = numeric ? Number(numeric[2]) : months.indexOf(named![2]!) + 1;
    day = year + '-' + two(month) + '-' + two(Number((numeric ?? named)![1]));
  }
  if (!day || !validCalendarDay(day) || (expected && day !== expected)) return null;
  if (weekday && weekdays[new Date(day + 'T12:00:00Z').getUTCDay()] !== weekday[1]) return null;
  return day;
}

function clock(value: string): string | null {
  const m = /^(\d{1,2})(?:h(\d{2})?|:(\d{2}))$/iu.exec(value);
  if (!m) return null;
  const hour = Number(m[1]),
    minute = Number(m[2] ?? m[3] ?? 0);
  return hour < 24 && minute < 60 ? two(hour) + ':' + two(minute) : null;
}

type ParseResult = { reply: string } | ChannelCalendarMutation;
export function parseChannelCalendarEvent(
  text: string,
  receivedAt: Date | undefined
): ParseResult | null {
  const input = text.trim();
  const removing = removeCommand.exec(input);
  const prefix = removing ?? command.exec(input);
  if (!prefix) {
    // Keep hypothetical discussions on the normal conversation path. Only a
    // literal quoted/mirrored scheduling instruction needs this explicit fence.
    if (
      (input.includes('?') ||
        /^(?:se\b|e se\b|não\b|nunca\b|hipoteticamente\b|simule\b|imagine\b|como seria\b|é um exemplo\b)/iu.test(
          input
        )) &&
      /\b(?:marcar|marc[ae]|marque|agendar|agend[ae]|cri[ae]|exclua|excluir|remova|remover|apague|cancele|cancelar)\b.{0,32}\b[nd]a minha agenda\b/iu.test(
        input
      )
    )
      return { reply: 'Entendi. Sua agenda permanece como está.' };
    return null;
  }
  if (
    input.length > 450 ||
    /[?;\r\n<>]/u.test(input) ||
    /\b(?:não|nunca|talvez|caso|hipoteticamente|simulação|exemplo|se)\b/iu.test(input)
  )
    return {
      reply: 'Preciso de um pedido direto para alterar sua agenda. Sua agenda permanece como está.',
    };
  const body = input.slice(prefix[0].length);
  const hint = removing ? deleteHint : formatHint;
  const parts = removing
    ? /^(?:o\s+)?(?:compromisso|evento)\s+(?:de|do dia)\s+(?<day>[^,:]{1,55}?)\s+(?:no\s+)?(?:fuso(?:\s+horário)?|horário)\s+(?:de\s+)?(?<zone>[^:]{1,60}):\s*(?<title>.{1,160})$/iu.exec(
        body
      )?.groups
    : /^(?:para|pra|no dia)\s+(?<day>.{1,80}?),?\s+das\s+(?<from>\d{1,2}(?:h(?:\d{2})?|:\d{2}))\s+[àa]s\s+(?<to>\d{1,2}(?:h(?:\d{2})?|:\d{2}))\s+(?:(?:no\s+)?(?:fuso(?:\s+horário)?|horário)\s+(?:de\s+)?|de\s+)(?<zone>[^:]{1,60}):\s*(?<title>.{1,160})$/iu.exec(
        body
      )?.groups;
  if (!parts) return { reply: hint };
  const title = parts.title!.trim().replace(/[.!]$/u, '').trim();
  if (
    !title ||
    /[.!:;<>]/u.test(title) ||
    /\b(?:agend[ae]|marque|remarque|reagend[ae]|cancele|cancel[ae]|apague|exclua|envie|mande|lembre|lembra|avis[ae]|crie|salve|adicione|registre|anote|pague|transfira|mostre|confirme)\b/iu.test(
      title
    )
  )
    return { reply: hint };
  const timezone = resolveCustomerTimeZone(parts.zone!);
  if (!timezone)
    return {
      reply: 'Informe o fuso por cidade, como Cuiabá, ou pelo nome completo, como America/Cuiaba.',
    };
  if (!receivedAt || !Number.isFinite(receivedAt.getTime())) return { reply: hint };
  const day = requestedDay(parts.day!, customerLocalDay(receivedAt, timezone));
  if (!day)
    return {
      reply: 'Confira a data e o dia da semana. Use dia/mês/ano para definir o compromisso.',
    };
  if (removing)
    return /\d{4}$/.test(parts.day!.trim())
      ? { action: 'delete', title, day, timezone }
      : { reply: deleteHint };
  const from = clock(parts.from!),
    to = clock(parts.to!);
  if (!from || !to || from >= to)
    return {
      reply: 'Informe um início e um término válidos no mesmo dia, com o término depois do início.',
    };
  try {
    return {
      action: 'create',
      title,
      timezone,
      startTime: customerLocalDateTime(day + 'T' + from, timezone).toISOString(),
      endTime: customerLocalDateTime(day + 'T' + to, timezone).toISOString(),
    };
  } catch {
    return {
      reply: 'Esse intervalo é inexistente ou ambíguo no fuso informado. Escolha outro horário.',
    };
  }
}

export async function tryChannelCalendarMutation(
  message: ChannelIncomingMessage,
  userId: string,
  canWrite: () => Promise<boolean>
): Promise<string | null> {
  if (message.attachments?.length || !['whatsapp', 'telegram'].includes(message.platform))
    return null;
  const receivedAt =
    message.timestamp && message.timestamp.getTime() <= Date.now() ? message.timestamp : undefined;
  const intent = parseChannelCalendarEvent(message.text, receivedAt);
  if (!intent) return null;
  if (
    !userId?.trim() ||
    userId === 'default' ||
    !message.sender?.platformUserId ||
    message.sender.platformUserId !== message.platformChatId ||
    message.metadata?.isGroup === true ||
    message.platformChatId.endsWith('@g.us') ||
    (message.platform === 'telegram' && message.metadata?.chatType !== 'private')
  )
    return 'Abra uma conversa privada com o Astra para alterar sua agenda.';
  if ('reply' in intent) return intent.reply;
  if (!message.id?.trim() || !message.channelPluginId)
    return 'Envie o pedido em uma nova mensagem para identificar este agendamento.';
  try {
    const result = await new CustomerAgendaRepository(userId, intent.timezone).changeChannelEvent(
      intent,
      [message.platform, message.channelPluginId, message.platformChatId, message.id],
      canWrite
    );
    switch (result.status) {
      case 'denied':
        return 'O acesso à sua agenda está inativo.';
      case 'changed':
        return 'Esta mensagem já foi usada para outro agendamento. Confira sua agenda antes de enviar um novo pedido.';
      case 'removed':
        return formatAstraMessage('🗑️ Compromisso excluído', [
          { label: 'Assunto', value: intent.title },
        ]);
      case 'alreadyRemoved':
        return 'A exclusão pedida nesta mensagem já foi registrada.';
      case 'missing':
        return 'Não encontrei um compromisso com esse título nesse dia.';
      case 'ambiguous':
        return 'Encontrei mais de um compromisso com esse título nesse dia. Abra sua agenda e selecione o horário que deseja excluir.';
      case 'gone':
        return 'Esta mensagem já foi processada e o compromisso foi excluído da agenda.';
      case 'expired':
        return 'Esse horário já passou. Informe uma data e um intervalo futuros.';
    }
    const event = result.event,
      timezone = event.timezone;
    const formatter = new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    });
    const fields = [
      { label: 'Assunto', value: event.title },
      { label: 'Início', value: formatter.format(new Date(event.startTime)) },
    ];
    if (event.endTime)
      fields.push({ label: 'Término', value: formatter.format(new Date(event.endTime)) });
    fields.push({ label: 'Fuso horário', value: timezone });
    return formatAstraMessage(
      result.status === 'created' ? '✅ Compromisso agendado' : '📅 Compromisso já registrado',
      fields
    );
  } catch {
    return 'Não consegui confirmar a alteração da agenda. Confira sua agenda antes de repetir o pedido.';
  }
}
