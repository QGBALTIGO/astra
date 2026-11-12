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
import { channelDataFailure } from './channel-failure.js';
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

export function parseChannelCalendarDay(description: string, today: string): string | null {
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

export function parseChannelClock(value: string): string | null {
  const m = /^(\d{1,2})(?:h(\d{2})?|:(\d{2}))$/iu.exec(value);
  if (!m) return null;
  const hour = Number(m[1]),
    minute = Number(m[2] ?? m[3] ?? 0);
  return hour < 24 && minute < 60 ? two(hour) + ':' + two(minute) : null;
}

type ParseResult = { reply: string } | ChannelCalendarMutation;
const movePrefix =
  /^(?:astra,\s*)?(?:(?:preciso|quero)\s+(?:mudar|alterar|remarcar|reagendar)|mude|muda|altere|altera|remarque|remarca|reagende|reagenda)\s+/iu;
const moveHint =
  'Qual compromisso você quer remarcar? Diga o título completo, o dia e o novo horário, como “Remarque a reunião do orçamento de sexta para 16h”.';
// This suffix asks for a reply to the current turn when the event is missing. It
// never authorizes creating a calendar item, a future notification, or a second action.
const reportMissing =
  /(?:[.!]\s*|,\s*)(?:se (?:encontrar|achar) (?:esse|este|o) (?:evento|compromisso),?\s*(?:remarque|remarca|reagende|reagenda) o mesmo[;,.]\s*)?se não (?:encontrar|achar),?\s*(?:me avis[ae]|me diga|me informe)[.!]?$/iu;
function parseMove(input: string, receivedAt: Date | undefined): ParseResult | null {
  const at = movePrefix.exec(input);
  const dayAndClock =
    /\b(?:de|da|do dia|na|no dia)\s+(?:hoje|amanhã|domingo|segunda|terça|quarta|quinta|sexta|sábado|\d{1,2}\/\d{1,2}\/\d{4})(?:-feira)?\s+(?:para|pra)\s+(?:[àa]s\s+)?\d/iu;
  const eventWords =
    /\b(?:remarc\w*|remarque|reagend\w*|agenda|evento|compromisso|reunião|revisão|apresentação|encontro|aula|entrevista|consulta|videochamada)\b/iu;
  if (!eventWords.test(input)) return null;
  if (!dayAndClock.test(input)) {
    return at && /\b(?:pra|para)\s+(?:[àa]s\s+)?\d{1,2}(?:h|:)/iu.test(input)
      ? { reply: moveHint }
      : null;
  }
  if (!at) {
    // Quoted, hypothetical or negated moves must not reach a mutating agent.
    if (
      /\b(?:mudar|remarc\w*|remarque|reagend\w*|mude|altere)\b/iu.test(input) &&
      /^(?:não|nunca|e se|se|imagin[ae]|como seria|hipoteticamente|é (?:só )?um exemplo)\b/iu.test(
        input
      )
    )
      return { reply: 'Entendi. Sua agenda permanece como está.' };
    return null;
  }
  const body = input
    .slice(at[0].length)
    .replace(/^o horário (?:da|do|de)\s+/iu, '')
    .replace(reportMissing, '')
    .trim()
    .replace(/[.!]$/u, '');
  if (
    input.length > 480 ||
    /[?;\r\n<>.!]/u.test(body) ||
    /\b(?:não|nunca|talvez|caso|se|exemplo|simul\w*|hipoteticamente|apenas se)\b/iu.test(body)
  )
    return { reply: moveHint };
  const parts =
    /^(?<title>[^:,]{1,170}?)\s+(?:de|da|do dia|na|no dia)\s+(?<day>hoje|amanhã|domingo|segunda(?:-feira)?|terça(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sábado|\d{1,2}\/\d{1,2}\/\d{4})\s+(?:para|pra)\s+(?:[àa]s\s+)?(?<clock>\d{1,2}(?:h(?:\d{2})?|:\d{2}))(?:\s+(?:de|no (?:fuso|horário) de)\s+(?<zone>[^,]{1,60}))?(?:,\s*mantendo\s+(?<length>(?:a (?:mesma )?duração|meia hora|uma hora|\d{1,3}\s*min(?:utos)?)))?$/iu.exec(
      body
    )?.groups;
  if (!parts) return { reply: moveHint };
  const title = parts
    .title!.replace(/^(?:(?:[oa]|um|uma)\s+)?(?:compromisso|evento)\s+(?=[“"])/iu, '')
    .replace(/^[“"]([^“”"]+)[”"]$/u, '$1')
    .trim();
  if (
    !/^[\p{L}\d][\p{L}\p{M}\d '’()&+/-]{0,159}$/u.test(title) ||
    /\b(?:remarque|remarca|reagende|reagenda|cancele|envie|mande|avise|crie|apague|adicione|registre|anote|pague|transfira|salve)\b/iu.test(
      title
    )
  )
    return { reply: moveHint };
  const localClock = parseChannelClock(parts.clock!);
  if (!localClock) return { reply: 'Que horário devo usar? Informe uma hora entre 0h e 23h59.' };
  const timezone = parts.zone && resolveCustomerTimeZone(parts.zone);
  if (parts.zone && !timezone)
    return { reply: 'Qual é o fuso desse horário? Use uma cidade como Cuiabá.' };
  const length = parts.length?.toLocaleLowerCase('pt-BR');
  const durationMinutes =
    length === 'meia hora'
      ? 30
      : length === 'uma hora'
        ? 60
        : length && /^\d/u.test(length)
          ? parseInt(length, 10)
          : undefined;
  if (durationMinutes === 0) return { reply: moveHint };
  const dayReference = parts.day!.toLocaleLowerCase('pt-BR');
  const weekday = weekdays.indexOf(dayReference.replace(/-feira$/u, ''));
  const referenceTime =
    receivedAt && Number.isFinite(receivedAt.getTime()) ? receivedAt.toISOString() : undefined;
  const day = /^\d/u.test(dayReference)
    ? parseChannelCalendarDay(dayReference, referenceTime?.slice(0, 10) ?? '')
    : undefined;
  if (day === null) return { reply: moveHint };
  return {
    action: 'move',
    title,
    referenceTime,
    day,
    weekday: weekday >= 0 ? weekday : undefined,
    offset: dayReference === 'hoje' ? 0 : dayReference === 'amanhã' ? 1 : undefined,
    localClock,
    durationMinutes,
    timezone: timezone || undefined,
  };
}

export function parseChannelCalendarEvent(
  text: string,
  receivedAt: Date | undefined
): ParseResult | null {
  const input = text.trim();
  const move = parseMove(input, receivedAt);
  if (move) return move;
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
  const day = parseChannelCalendarDay(parts.day!, customerLocalDay(receivedAt, timezone));
  if (!day)
    return {
      reply: 'Confira a data e o dia da semana. Use dia/mês/ano para definir o compromisso.',
    };
  if (removing)
    return /\d{4}$/.test(parts.day!.trim())
      ? { action: 'delete', title, day, timezone }
      : { reply: deleteHint };
  const from = parseChannelClock(parts.from!),
    to = parseChannelClock(parts.to!);
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
  if (intent.action === 'move' && message.metadata?.estimatedTimestamp === true)
    intent.referenceTime = undefined;
  try {
    const result = await new CustomerAgendaRepository(
      userId,
      intent.timezone ?? 'UTC'
    ).changeChannelEvent(
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
        return 'Encontrei mais de um compromisso com esse título nesse dia. Abra Agenda no painel para escolher o compromisso pelo horário.';
      case 'durationMismatch':
        return 'A duração cadastrada é diferente da que você pediu para manter. Confira o início e o término em Agenda antes de escolher o novo intervalo.';
      case 'needsDate':
        return 'Qual é a data do compromisso? Para identificar o dia certo, use dia/mês/ano no pedido de remarcação.';
      case 'invalidClock':
        return 'Esse horário é inexistente ou ambíguo no fuso do compromisso. Qual outro horário funciona para você?';
      case 'unsupportedMove':
        return 'Para remarcar esse compromisso, abra Agenda no painel e confira a duração e a recorrência antes de editar.';
      case 'linkedReminder':
        return 'O aviso vinculado ficaria depois do novo início. Abra o compromisso em Agenda para ajustar também o horário do aviso.';
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
    const heading = {
      created: '✅ Compromisso agendado',
      existing: '📅 Compromisso já registrado',
      moved: '📅 Compromisso remarcado',
      current: '📅 Horário atual do compromisso',
    }[result.status];
    return formatAstraMessage(heading, fields);
  } catch (error) {
    return channelDataFailure('calendar', 'write', error);
  }
}
