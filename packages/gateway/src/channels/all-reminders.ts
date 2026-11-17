import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { channelRemindersRepo } from '../db/repositories/channel-reminders.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { reminderSelectionRepo } from '../db/repositories/reminder-selection.js';
import { channelDataFailure } from './channel-failure.js';
import { formatAstraMessage } from './response-presentation.js';
import { isConversationalOnlyChannelRequest } from './tool-selection.js';

type GeneralReminderRequest = { kind: 'list'; page: number } | { kind: 'cancel' };

/** Complete, explicit requests only. Bare "cancel all" belongs to the saved selection. */
export function parseGeneralReminderRequest(input: string): GeneralReminderRequest | null {
  if (input.length > 300 || isConversationalOnlyChannelRequest(input)) return null;
  const text = input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:astra|orion)[, ]+/, '')
    .replace(/^por favor,? /, '')
    .replace(/[, ]+por favor[.!?]*$/, '')
    .replace(/[.!?]+$/, '')
    .trim();
  const cancel =
    /^(?:(?:pode|poderia|quero|preciso que voce|voce pode) )?(?:cancele|cancela|cancelar|apague|apaga|apagar|remova|remove|remover|exclua|exclui|excluir) todos (?:os )?(?:meus )?lembretes(?: pendentes)?$/.test(
      text
    );
  if (cancel) return { kind: 'cancel' };
  const pagePrefix = /^pagina (\d+) (?:dos )?(?:meus )?lembretes$/.exec(text);
  const list =
    /^(?:(?:me diga|me mostre|me liste|diga|mostre|mostra|liste|lista|veja|ver|quais(?: sao)?|quero (?:ver|saber)|consulte|consultar) )?(?:todos )?(?:os )?(?:meus )?lembretes(?: pendentes| agendados)?(?: (?:pagina|pag\.) (\d+))?$/.exec(
      text
    );
  if (!list && !pagePrefix) return null;
  const page = Number(pagePrefix?.[1] ?? list?.[1] ?? 1);
  return Number.isSafeInteger(page) && page >= 1 && page <= 100_000 ? { kind: 'list', page } : null;
}

export async function tryGeneralReminderConversation(
  message: ChannelIncomingMessage,
  userId: string,
  allowed: () => Promise<boolean>
): Promise<string | null> {
  const request = parseGeneralReminderRequest(message.text);
  if (
    !request ||
    !['whatsapp', 'telegram'].includes(message.platform) ||
    message.attachments?.length ||
    message.metadata?.isGroup === true ||
    message.metadata?.fromMe === true ||
    (message.platform === 'telegram' && message.metadata?.chatType !== 'private') ||
    !userId ||
    !message.id ||
    !message.platformChatId ||
    !message.channelPluginId ||
    message.sender?.platformUserId !== message.platformChatId
  )
    return null;
  const receivedAt = message.timestamp;
  if (!receivedAt || !Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() > Date.now())
    return 'Não consegui verificar a data deste pedido. Envie novamente para consultar ou cancelar seus lembretes.';
  const scope = {
    userId,
    channelPluginId: message.channelPluginId,
    platformChatId: message.platformChatId,
    senderId: message.sender.platformUserId,
  };
  const denied =
    'Seu acesso a esta conversa mudou. Não consegui concluir esse pedido de lembretes.';
  try {
    if (!(await allowed())) return denied;
    const account = await customerAccountsRepo.getByDataUserId(userId);
    const stillAllowed = async () => {
      if (!(await allowed())) return false;
      const current = await customerAccountsRepo.getByDataUserId(userId);
      return current?.id === account?.id && current?.phoneNumber === account?.phoneNumber;
    };
    if (request.kind === 'cancel') {
      const result = await channelRemindersRepo.cancelPendingForChatBefore(
        userId,
        message.channelPluginId,
        message.platformChatId,
        message.id,
        receivedAt,
        stillAllowed
      );
      if (!result) return denied;
      return formatAstraMessage(
        result.cancelled ? '✅ Lembretes cancelados' : '⏰ Seus lembretes',
        [
          { label: 'Cancelados', value: String(result.cancelled) },
          ...(result.alreadySending
            ? [
                {
                  label: 'Em envio',
                  value:
                    String(result.alreadySending) + ' — já tinham sido iniciados e podem chegar',
                },
              ]
            : []),
        ],
        result.cancelled
          ? 'Cancelei os lembretes pendentes desta conversa que já existiam quando você fez o pedido.'
          : 'Não encontrei lembretes pendentes desta conversa para cancelar neste pedido.'
      );
    }
    const zone = account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande';
    const result = await channelRemindersRepo.listForChatPage(
      userId,
      message.channelPluginId,
      message.platformChatId,
      { page: request.page, pageSize: 20, status: 'pending', before: receivedAt }
    );
    if (!(await stillAllowed())) return denied;
    if (!result.total) return '⏰ Você não tem lembretes pendentes nesta conversa.';
    if (!result.items.length)
      return `⏰ Essa página não tem lembretes. Há ${result.total} pendentes em ${Math.ceil(result.total / result.pageSize)} página(s). Peça “meus lembretes página 1”.`;
    await reminderSelectionRepo.remember(
      scope,
      result.items.map((row) => row.id),
      message.id,
      receivedAt
    );
    const format = new Intl.DateTimeFormat('pt-BR', {
      timeZone: zone,
      dateStyle: 'short',
      timeStyle: 'short',
    });
    return formatAstraMessage(
      '⏰ Seus lembretes pendentes',
      [
        { label: 'Total', value: String(result.total) },
        {
          label: 'Página',
          value: `${result.page} de ${Math.ceil(result.total / result.pageSize)}`,
        },
        ...result.items.map((row) => ({ label: format.format(row.remindAt), value: row.title })),
      ],
      result.hasMore
        ? `Mostrando ${result.items.length} de ${result.total}. Para continuar, peça “meus lembretes página ${result.page + 1}”. “Cancele todos” se aplica somente a esta página.`
        : `Mostrando ${result.items.length} lembrete(s) nesta página. “Cancele todos” se aplica somente a esta página.`
    );
  } catch (error) {
    return channelDataFailure('reminder', request.kind === 'cancel' ? 'write' : 'read', error);
  }
}
