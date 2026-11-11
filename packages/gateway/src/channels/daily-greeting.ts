/**
 * A reliable, zero-model-token route for daily WhatsApp greetings.
 * Conversational answers alone must never claim a scheduled delivery.
 */
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { dailyGreetingsRepo } from '../db/repositories/daily-greetings.js';
import {
  addCalendarDays,
  customerLocalDateTime,
  customerLocalDay,
} from '../services/customer-date.js';
import { formatAstraMessage } from './response-presentation.js';

export type DailyGreetingCommand =
  | { kind: 'enable'; hour: number; minute: number; withCuriosity: boolean }
  | { kind: 'disable' }
  | { kind: 'missing_time' }
  | { kind: 'invalid_time' };

const normalized = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export function parseDailyGreetingCommand(text: string): DailyGreetingCommand | null {
  const input = normalized(text);
  if (!/\bbom\s+dia\b/u.test(input)) return null;

  if (
    /\b(?:cancele|cancelar|desative|desativar|remova|remover|pare de|parar de|nao quero mais|nao mande mais)\b/u.test(
      input
    )
  ) {
    return { kind: 'disable' };
  }
  if (
    !/\b(?:todo dia|todos os dias|diariamente|cada dia|toda manha|todas as manhas)\b/u.test(input)
  ) {
    return null;
  }
  // A negated or compound request cannot be written as a single scheduled action.
  if (
    /\b(?:nao|nunca)\s+(?:me\s+)?(?:mande|envie|agende|programe|de|dar)\b/u.test(input) ||
    /(?:\be\s+|;\s*)(?:tambem\s+)?(?:registre|anote|cancele|exclua|crie|agende|lembre|pague)\b/u.test(
      input
    )
  ) {
    return null;
  }
  const time = /\b(?:as|a)\s*(\d{1,2})(?:(?::|h)(\d{1,2}))?\s*(?:h|horas?)?\b/u.exec(input);
  if (!time) return { kind: 'missing_time' };
  const hour = Number(time[1]);
  const minute = time[2] ? Number(time[2]) : 0;
  if (hour > 23 || minute > 59) return { kind: 'invalid_time' };
  return {
    kind: 'enable',
    hour,
    minute,
    withCuriosity: /\b(?:curiosidade|curiosidades|fato interessante|fatos interessantes)\b/u.test(
      input
    ),
  };
}

export function nextDailyGreetingAt(
  timeZone: string,
  hour: number,
  minute: number,
  now = new Date()
): Date {
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error('Horário diário inválido.');
  }
  const hhmm = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  const today = customerLocalDay(now, timeZone);
  for (let i = 0; i < 5; i++) {
    try {
      const result = customerLocalDateTime(addCalendarDays(today, i) + 'T' + hhmm, timeZone);
      if (result.getTime() > now.getTime()) return result;
    } catch {
      // Skip nonexistent/repeated wall-clock hours at DST changes.
    }
  }
  throw new Error('Não foi possível determinar o próximo horário local.');
}

export async function tryDailyGreetingChannelReply(
  message: Pick<ChannelIncomingMessage, 'text' | 'id' | 'channelPluginId' | 'platformChatId'>,
  userId: string,
  now = new Date()
): Promise<string | null> {
  const command = parseDailyGreetingCommand(message.text);
  if (!command) return null;
  if (!userId.startsWith('whatsapp:')) {
    return 'A rotina de bom-dia está disponível para contatos autorizados no WhatsApp.';
  }
  if (command.kind === 'missing_time') {
    return 'Consigo, sim! ☀️ Que horas você quer receber seu bom-dia todos os dias?';
  }
  if (command.kind === 'invalid_time') {
    return 'Qual horário deseja usar? Informe uma hora válida, por exemplo, 6h ou 06:30.';
  }
  if (!message.platformChatId || !message.channelPluginId || !message.id) {
    return 'Não foi possível identificar esta conversa. Nenhuma rotina foi alterada.';
  }

  try {
    if (command.kind === 'disable') {
      const disabled = await dailyGreetingsRepo.disable(
        userId,
        message.channelPluginId,
        message.platformChatId
      );
      return disabled
        ? formatAstraMessage(
            '✅ Bom-dia diário desativado',
            [],
            'Não enviarei novos bons-dias automáticos.'
          )
        : 'Não encontrei um bom-dia diário ativo nesta conversa.';
    }

    const account = await customerAccountsRepo.getByDataUserId(userId);
    const timeZone = account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande';
    // This also validates the IANA zone before writing anything.
    const nextRunAt = nextDailyGreetingAt(timeZone, command.hour, command.minute, now);
    const saved = await dailyGreetingsRepo.upsert({
      userId,
      channelPluginId: message.channelPluginId,
      platformChatId: message.platformChatId,
      timeZone,
      hour: command.hour,
      minute: command.minute,
      withCuriosity: command.withCuriosity,
      nextRunAt,
    });
    const local = new Intl.DateTimeFormat('pt-BR', {
      timeZone: saved.timeZone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(saved.nextRunAt);
    const hhmm = String(saved.hour).padStart(2, '0') + ':' + String(saved.minute).padStart(2, '0');
    return formatAstraMessage(
      '✅ Bom-dia diário ativado',
      [
        { label: 'Horário', value: hhmm + ' — todos os dias' },
        { label: 'Fuso horário', value: saved.timeZone },
        { label: 'Curiosidade do dia', value: saved.withCuriosity ? 'Incluída' : 'Desativada' },
        { label: 'Próximo envio', value: local },
      ],
      'Para parar, diga: cancele meu bom dia diário.'
    );
  } catch {
    return 'Não consegui salvar o bom-dia diário. Nenhuma ativação foi confirmada.';
  }
}
