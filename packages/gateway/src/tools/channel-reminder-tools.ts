/**
 * Channel reminder tools. Require authenticated channel context; never accept
 * a caller-supplied recipient or claim that a plain task creates an alert.
 */
import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@ownpilot/core/tools';
import { getExecContext } from '@ownpilot/core/agent';
import {
  channelRemindersRepo,
  type ChannelReminder,
} from '../db/repositories/channel-reminders.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { customerLocalDateTime, validCalendarDay } from '../services/customer-date.js';

const MAX_REMINDER_DELAY_SECONDS = 366 * 24 * 60 * 60;

const createReminderDef: ToolDefinition = {
  name: 'schedule_channel_reminder',
  category: 'Automation',
  brief: 'Agendar lembrete com entrega real por WhatsApp ou Telegram',
  description:
    'Agenda envio real de lembrete na conversa atual. Use para "me lembre daqui 20 segundos", "me lembre em 1 minuto", "me avise amanhã às 8h" e pedidos de alerta. Aceita segundos; não peça ao usuário para converter em minutos. Não use add_task para prometer notificação. Nunca invente horário ou assunto: se não estiver claro, pergunte antes. Informe title e exatamente um entre delay_seconds, delay_minutes, local_datetime ou remind_at. Prefira delay_seconds para intervalos em segundos ou mistos (1 minuto e 20 segundos = 80). Prefira local_datetime para hora local: o servidor resolve o fuso cadastrado; não invente offsets.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Mensagem curta do lembrete, por exemplo: Jogar o lixo fora',
      },
      delay_seconds: {
        type: 'integer',
        description:
          'Inteiro entre 1 e 31.622.400 segundos (366 dias), desde o recebimento da mensagem (ex.: 20). Para intervalos mistos, some as unidades em segundos. Não combine com outro campo de prazo.',
      },
      delay_minutes: {
        type: 'number',
        description:
          'Minutos desde o recebimento da mensagem (ex.: 1). Use para pedidos relativos.',
      },
      local_datetime: {
        type: 'string',
        description:
          'Dia e hora locais YYYY-MM-DDTHH:mm, SEM offset. Só use se o usuário informou a hora. O servidor aplica o fuso cadastrado.',
      },
      remind_at: {
        type: 'string',
        description: 'Data e horário ISO 8601 completo com fuso, ex.: 2026-11-08T09:00:00-04:00.',
      },
    },
    required: ['title'],
  },
};

const listReminderDef: ToolDefinition = {
  name: 'list_channel_reminders',
  category: 'Automation',
  brief: 'Listar lembretes agendados e seu estado real de entrega',
  description:
    'Consulta os lembretes desta conversa, incluindo pendente, entregue e falhou. Apresente horarioLocal e use sua data para hoje/amanhã. O campo quando é UTC.',
  parameters: { type: 'object', properties: {} },
};

const cancelReminderDef: ToolDefinition = {
  name: 'cancel_channel_reminder',
  category: 'Automation',
  brief: 'Cancelar lembrete ainda não enviado',
  description: 'Cancela um lembrete pendente desta conversa por ID. Não cancela envio já iniciado.',
  parameters: {
    type: 'object',
    properties: {
      reminder_id: { type: 'string', description: 'ID mostrado por list_channel_reminders' },
    },
    required: ['reminder_id'],
  },
};

const rescheduleReminderDef: ToolDefinition = {
  name: 'reschedule_channel_reminder',
  category: 'Automation',
  brief: 'Alterar horário de um lembrete existente',
  description:
    'Reagenda atomicamente um lembrete pendente desta conversa. Aceita intervalos em segundos ou minutos. Informe exatamente um entre delay_seconds, delay_minutes, local_datetime ou remind_at. Consulte list_channel_reminders para obter o ID. Não crie outro lembrete nem invente a hora.',
  parameters: {
    type: 'object',
    properties: {
      reminder_id: { type: 'string' },
      delay_seconds: {
        type: 'integer',
        description:
          'Inteiro entre 1 e 31.622.400 segundos (366 dias), desde o recebimento da mensagem; não combine com outro prazo.',
      },
      delay_minutes: { type: 'number' },
      local_datetime: { type: 'string', description: 'YYYY-MM-DDTHH:mm no fuso cadastrado.' },
      remind_at: { type: 'string', description: 'ISO com offset explícito.' },
    },
    required: ['reminder_id'],
  },
};

export const CHANNEL_REMINDER_TOOLS: ToolDefinition[] = [
  createReminderDef,
  listReminderDef,
  cancelReminderDef,
  rescheduleReminderDef,
];

function formatReminderLocalTime(when: Date, timeZone: string, secondsRequested: boolean): string {
  // A saved deadline such as 10:05:20 must not be presented as 10:05.
  const includeSeconds = secondsRequested || when.getUTCSeconds() !== 0;
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: includeSeconds ? 'medium' : 'short',
  }).format(when);
}

function storedReminderResult(saved: ChannelReminder, timeZone: string, secondsRequested: boolean) {
  return {
    id: saved.id,
    title: saved.title,
    agendadoPara: saved.remindAt.toISOString(),
    timeZone,
    horarioLocal: formatReminderLocalTime(saved.remindAt, timeZone, secondsRequested),
    status: saved.status,
  };
}

async function reminderTimeZone(userId: string): Promise<string> {
  const account = userId.startsWith('whatsapp:')
    ? await customerAccountsRepo.getByDataUserId(userId)
    : null;
  return account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande';
}

export async function executeChannelReminderTool(
  toolName: string,
  args: Record<string, unknown>,
  userId: string
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const ctx = getExecContext();
  if (!ctx?.channelPluginId || !ctx.platformChatId || !ctx.channelMessageId) {
    return {
      success: false,
      error: 'Esta função exige uma conversa autenticada no WhatsApp ou Telegram.',
    };
  }

  if (toolName === 'list_channel_reminders') {
    const [entries, timeZone] = await Promise.all([
      channelRemindersRepo.listForChat(userId, ctx.channelPluginId, ctx.platformChatId),
      reminderTimeZone(userId),
    ]);
    return {
      success: true,
      result: entries.map(({ id, title, remindAt, status }) => ({
        id,
        title,
        quando: remindAt.toISOString(),
        horarioLocal: formatReminderLocalTime(remindAt, timeZone, false),
        timeZone,
        status,
      })),
    };
  }

  if (toolName === 'cancel_channel_reminder') {
    const id = args.reminder_id;
    if (typeof id !== 'string' || !id.trim()) {
      return { success: false, error: 'Informe o ID do lembrete.' };
    }
    const cancelled = await channelRemindersRepo.cancel(
      id,
      userId,
      ctx.channelPluginId,
      ctx.platformChatId
    );
    return cancelled
      ? { success: true, result: { message: 'Lembrete cancelado.', id } }
      : { success: false, error: 'Lembrete não encontrado, já entregue ou em envio.' };
  }

  const rescheduling = toolName === 'reschedule_channel_reminder';
  if (toolName !== 'schedule_channel_reminder' && !rescheduling) {
    return { success: false, error: 'Ferramenta de lembrete desconhecida.' };
  }

  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!rescheduling && (!title || title.length > 160)) {
    return { success: false, error: 'O lembrete precisa de um título entre 1 e 160 caracteres.' };
  }

  const hasSeconds = args.delay_seconds !== undefined;
  const hasMinutes = args.delay_minutes !== undefined;
  const hasDate = args.remind_at !== undefined;
  const hasLocal = args.local_datetime !== undefined;
  if ([hasSeconds, hasMinutes, hasDate, hasLocal].filter(Boolean).length !== 1) {
    return {
      success: false,
      error:
        'Informe exatamente um prazo: delay_seconds, delay_minutes, local_datetime ou remind_at. Se falta a hora, pergunte ao usuário.',
    };
  }
  if (rescheduling && (typeof args.reminder_id !== 'string' || !args.reminder_id.trim())) {
    return { success: false, error: 'Consulte o ID do lembrete que será reagendado.' };
  }
  const timeZone = await reminderTimeZone(userId);
  let remindAt: Date;
  if (hasSeconds || hasMinutes) {
    const duration = hasSeconds ? args.delay_seconds : args.delay_minutes;
    if (
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      (hasSeconds && !Number.isSafeInteger(duration))
    ) {
      return {
        success: false,
        error: hasSeconds
          ? 'O prazo precisa ser um número inteiro positivo de segundos.'
          : 'O prazo precisa ser um número positivo de minutos.',
      };
    }
    if (duration * (hasSeconds ? 1 : 60) > MAX_REMINDER_DELAY_SECONDS) {
      return { success: false, error: 'O prazo máximo para um lembrete é de 366 dias.' };
    }
    const receivedAt = ctx.channelMessageTimestamp;
    const now = Date.now();
    if (
      receivedAt !== undefined &&
      (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt > now)
    ) {
      return {
        success: false,
        error:
          'Não consegui confirmar o horário de recebimento. Envie novamente o pedido de lembrete.',
      };
    }
    const anchor = receivedAt ?? now;
    remindAt = new Date(anchor + duration * (hasSeconds ? 1_000 : 60_000));
  } else if (hasLocal) {
    try {
      if (typeof args.local_datetime !== 'string') throw new Error('Horário local inválido.');
      remindAt = customerLocalDateTime(args.local_datetime, timeZone);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Horário local inválido.',
      };
    }
  } else {
    const value = args.remind_at;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
        value
      ) ||
      !validCalendarDay(value.slice(0, 10))
    ) {
      return {
        success: false,
        error: 'Informe horário ISO 8601 com fuso, por exemplo: 2026-11-08T09:00:00-04:00.',
      };
    }
    remindAt = new Date(value);
  }

  const now = Date.now();
  const maxDate = now + MAX_REMINDER_DELAY_SECONDS * 1_000;
  if (!Number.isFinite(remindAt.getTime()) || remindAt.getTime() > maxDate) {
    return { success: false, error: 'A data deve estar no futuro, dentro dos próximos 366 dias.' };
  }

  // A retried model call for the same incoming message must not create duplicates.
  const dedupeKey = createHash('sha256')
    .update(
      [userId, ctx.channelPluginId, ctx.platformChatId, ctx.channelMessageId, title].join('|')
    )
    .digest('hex');

  if (remindAt.getTime() <= now) {
    if (!rescheduling) {
      try {
        // Late retries must acknowledge the persisted outcome, including delivered
        // and cancelled reminders. Never INSERT an already-expired new event.
        const saved = await channelRemindersRepo.getByDedupeKeyForChat(
          dedupeKey,
          userId,
          ctx.channelPluginId,
          ctx.platformChatId
        );
        if (
          saved &&
          saved.userId === userId &&
          saved.channelPluginId === ctx.channelPluginId &&
          saved.platformChatId === ctx.platformChatId
        ) {
          return {
            success: true,
            result: {
              ...storedReminderResult(saved, timeZone, hasSeconds),
              message: 'Este lembrete já foi registrado anteriormente.',
            },
          };
        }
      } catch {
        return {
          success: false,
          error:
            'Não consegui verificar se esse lembrete já foi registrado. Confira sua agenda antes de repetir.',
        };
      }
    }
    return {
      success: false,
      error:
        hasSeconds || hasMinutes
          ? 'Esse prazo já passou durante o processamento. Informe um novo intervalo para o lembrete.'
          : 'A data deve estar no futuro, dentro dos próximos 366 dias.',
    };
  }

  try {
    if (rescheduling) {
      const saved = await channelRemindersRepo.reschedule(
        String(args.reminder_id),
        userId,
        ctx.channelPluginId,
        ctx.platformChatId,
        remindAt
      );
      return saved
        ? {
            success: true,
            result: {
              ...storedReminderResult(saved, timeZone, hasSeconds),
              message: 'Lembrete reagendado, mantendo o mesmo registro.',
            },
          }
        : {
            success: false,
            error:
              'Lembrete não encontrado, já entregue ou em envio. Nenhum reagendamento realizado.',
          };
    }
    const saved = await channelRemindersRepo.schedule({
      userId,
      title,
      remindAt,
      channelPluginId: ctx.channelPluginId,
      platformChatId: ctx.platformChatId,
      dedupeKey,
    });
    return {
      success: true,
      result: {
        ...storedReminderResult(saved, timeZone, hasSeconds),
        message:
          saved.status === 'pending'
            ? 'Lembrete agendado para envio nesta conversa.'
            : 'Este lembrete já foi registrado anteriormente.',
      },
    };
  } catch {
    return {
      success: false,
      error: 'Não foi possível salvar o lembrete para entrega. Tente novamente.',
    };
  }
}
