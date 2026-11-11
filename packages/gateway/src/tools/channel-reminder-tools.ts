/**
 * Channel reminder tools. Require authenticated channel context; never accept
 * a caller-supplied recipient or claim that a plain task creates an alert.
 */
import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@ownpilot/core/tools';
import { getExecContext } from '@ownpilot/core/agent';
import { channelRemindersRepo } from '../db/repositories/channel-reminders.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { customerLocalDateTime, validCalendarDay } from '../services/customer-date.js';

const createReminderDef: ToolDefinition = {
  name: 'schedule_channel_reminder',
  category: 'Automation',
  brief: 'Agendar lembrete com entrega real por WhatsApp ou Telegram',
  description:
    'Agenda envio real de lembrete na conversa atual. Use para "me lembre em 1 minuto", "me avise amanhã às 8h" e pedidos de alerta. Não use add_task para prometer notificação. Nunca invente horário: se não estiver claro, pergunte antes. Informe title e exatamente um entre delay_minutes, local_datetime ou remind_at. Prefira local_datetime para hora local: o servidor resolve o fuso cadastrado; não invente offsets.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Mensagem curta do lembrete, por exemplo: Jogar o lixo fora',
      },
      delay_minutes: {
        type: 'number',
        description: 'Minutos a partir de agora (ex.: 1). Use para pedidos relativos.',
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
  description: 'Consulta os lembretes desta conversa, incluindo pendente, entregue e falhou.',
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
    'Reagenda atomicamente um lembrete pendente desta conversa. Consulte list_channel_reminders para obter o ID. Não crie outro lembrete nem invente a hora.',
  parameters: {
    type: 'object',
    properties: {
      reminder_id: { type: 'string' },
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
    const entries = await channelRemindersRepo.listForChat(
      userId,
      ctx.channelPluginId,
      ctx.platformChatId
    );
    return {
      success: true,
      result: entries.map(({ id, title, remindAt, status }) => ({
        id,
        title,
        quando: remindAt.toISOString(),
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

  const hasMinutes = args.delay_minutes !== undefined;
  const hasDate = args.remind_at !== undefined;
  const hasLocal = args.local_datetime !== undefined;
  if ([hasMinutes, hasDate, hasLocal].filter(Boolean).length !== 1) {
    return {
      success: false,
      error:
        'Informe exatamente um prazo: delay_minutes, local_datetime ou remind_at. Se falta a hora, pergunte ao usuário.',
    };
  }
  if (rescheduling && (typeof args.reminder_id !== 'string' || !args.reminder_id.trim())) {
    return { success: false, error: 'Consulte o ID do lembrete que será reagendado.' };
  }
  const account = userId.startsWith('whatsapp:')
    ? await customerAccountsRepo.getByDataUserId(userId)
    : null;
  const timeZone = account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande';
  let remindAt: Date;
  if (hasMinutes) {
    const minutes = args.delay_minutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      return { success: false, error: 'O prazo precisa ser um número positivo de minutos.' };
    }
    const receivedAt = ctx.channelMessageTimestamp;
    const anchor =
      typeof receivedAt === 'number' && Number.isFinite(receivedAt) && receivedAt <= Date.now()
        ? receivedAt
        : Date.now();
    remindAt = new Date(anchor + minutes * 60_000);
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

  const maxDate = Date.now() + 366 * 24 * 60 * 60_000;
  if (
    !Number.isFinite(remindAt.getTime()) ||
    remindAt.getTime() <= Date.now() ||
    remindAt.getTime() > maxDate
  ) {
    return { success: false, error: 'A data deve estar no futuro, dentro dos próximos 366 dias.' };
  }

  // A retried model call for the same incoming message must not create duplicates.
  const dedupeKey = createHash('sha256')
    .update(
      [userId, ctx.channelPluginId, ctx.platformChatId, ctx.channelMessageId, title].join('|')
    )
    .digest('hex');

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
              id: saved.id,
              title: saved.title,
              status: saved.status,
              agendadoPara: saved.remindAt.toISOString(),
              timeZone,
              horarioLocal: new Intl.DateTimeFormat('pt-BR', {
                timeZone,
                dateStyle: 'short',
                timeStyle: 'short',
              }).format(saved.remindAt),
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
        id: saved.id,
        title: saved.title,
        agendadoPara: saved.remindAt.toISOString(),
        timeZone,
        horarioLocal: new Intl.DateTimeFormat('pt-BR', {
          timeZone,
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(saved.remindAt),
        status: saved.status,
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
