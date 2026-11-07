/**
 * Channel reminder tools. Require authenticated channel context; never accept
 * a caller-supplied recipient or claim that a plain task creates an alert.
 */
import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@ownpilot/core/tools';
import { getExecContext } from '@ownpilot/core/agent';
import { channelRemindersRepo } from '../db/repositories/channel-reminders.js';

const createReminderDef: ToolDefinition = {
  name: 'schedule_channel_reminder',
  category: 'Automation',
  brief: 'Agendar lembrete com entrega real por WhatsApp ou Telegram',
  description:
    'Agenda envio real de lembrete na conversa atual. Use para "me lembre em 1 minuto", "me avise amanhã às 8h" e pedidos de alerta. Não use add_task para prometer notificação. Nunca invente horário: se não estiver claro, pergunte antes. Informe title e exatamente um entre delay_minutes ou remind_at (ISO 8601 com Z ou offset de fuso).',
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

export const CHANNEL_REMINDER_TOOLS: ToolDefinition[] = [
  createReminderDef,
  listReminderDef,
  cancelReminderDef,
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

  if (toolName !== 'schedule_channel_reminder') {
    return { success: false, error: 'Ferramenta de lembrete desconhecida.' };
  }

  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title || title.length > 160) {
    return { success: false, error: 'O lembrete precisa de um título entre 1 e 160 caracteres.' };
  }

  const hasMinutes = args.delay_minutes !== undefined;
  const hasDate = args.remind_at !== undefined;
  if (hasMinutes === hasDate) {
    return { success: false, error: 'Informe somente delay_minutes ou remind_at, nunca ambos.' };
  }
  let remindAt: Date;
  if (hasMinutes) {
    const minutes = args.delay_minutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      return { success: false, error: 'O prazo precisa ser um número positivo de minutos.' };
    }
    remindAt = new Date(Date.now() + minutes * 60_000);
  } else {
    const value = args.remind_at;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ) {
      return {
        success: false,
        error: 'Informe horário com fuso, por exemplo: 2026-11-08T09:00:00-04:00.',
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
