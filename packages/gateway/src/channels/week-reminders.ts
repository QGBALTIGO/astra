import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { channelRemindersRepo } from '../db/repositories/channel-reminders.js';
import { reminderSelectionRepo } from '../db/repositories/reminder-selection.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { addCalendarDays, customerDayStart, customerLocalDay } from '../services/customer-date.js';
import { formatAstraMessage } from './response-presentation.js';
import { channelDataFailure } from './channel-failure.js';

export async function tryWeekReminderConversation(
  message: ChannelIncomingMessage,
  userId: string,
  allowed: () => Promise<boolean>
): Promise<string | null> {
  if (
    !['whatsapp', 'telegram'].includes(message.platform) ||
    message.attachments?.length ||
    message.text.length > 300 ||
    message.metadata?.isGroup === true ||
    (message.platform === 'telegram' && message.metadata?.chatType !== 'private') ||
    !userId ||
    !message.platformChatId ||
    !message.channelPluginId ||
    message.sender.platformUserId !== message.platformChatId
  )
    return null;
  const text = message.text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const cancel =
    /^(?:astra[, ]+)?(?:por favor,? )?cancel[ae] todos(?: (?:esses|estes|os) lembretes(?: listados)?)?(?:,? por favor)?[.!]*$/.test(
      text
    );
  const list =
    /^(?:astra[, ]+)?(?:(?:veja|ver|liste|lista|mostre|quais(?: sao)?) )?(?:todos )?(?:os )?(?:meus )?lembretes (?:da|desta|dessa|para esta|pra esta|na|para a|pra|da proxima) (semana)(?:,? por favor)?[?!.]*$/.test(
      text
    );
  const nextWeek =
    /^(?:astra[, ]+)?(?:(?:veja|liste|mostre|quais(?: sao)?) )?(?:todos )?(?:os )?(?:meus )?lembretes (?:da |para a )?proxima semana(?:,? por favor)?[?!.]*$/.test(
      text
    );
  if (!cancel && !list && !nextWeek) return null;
  const received = message.timestamp;
  if (!received || !Number.isFinite(received.getTime()) || received.getTime() > Date.now())
    return 'Não consegui verificar a data deste pedido. Envie novamente para consultar seus lembretes.';
  const scope = {
    userId,
    channelPluginId: message.channelPluginId,
    platformChatId: message.platformChatId,
    senderId: message.sender.platformUserId,
  };
  try {
    if (cancel) {
      const result = await reminderSelectionRepo.cancelSelected(
        scope,
        message.id,
        received,
        allowed
      );
      if (!result)
        return 'Quais lembretes você quer cancelar? Peça a lista da semana e, logo depois, diga “cancele todos”.';
      const remaining = result.selected - result.cancelled;
      return formatAstraMessage(
        result.cancelled ? '✅ Cancelamento dos lembretes' : '🔎 Situação dos lembretes',
        [
          { label: 'Cancelados', value: String(result.cancelled) },
          ...(remaining
            ? [
                {
                  label: 'Sem novo cancelamento',
                  value: String(remaining) + ' — já não estavam pendentes',
                },
              ]
            : []),
        ],
        result.cancelled
          ? 'Esses avisos não serão enviados. Outros lembretes foram preservados.'
          : 'Nenhum aviso pendente da lista foi alterado.'
      );
    }
    const zone =
      (await customerAccountsRepo.getByDataUserId(userId))?.timeZone ??
      process.env.TZ ??
      'America/Campo_Grande';
    const today = customerLocalDay(received, zone);
    const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
    const startDay = addCalendarDays(today, -((weekday + 6) % 7) + (nextWeek ? 7 : 0));
    const endDay = addCalendarDays(startDay, 7);
    const rows = await channelRemindersRepo.listPendingForChatInRange(
      userId,
      message.channelPluginId,
      message.platformChatId,
      customerDayStart(startDay, zone),
      customerDayStart(endDay, zone),
      51
    );
    const shown = rows.slice(0, 50);
    await reminderSelectionRepo.remember(
      scope,
      shown.map((row) => row.id),
      message.id,
      received
    );
    const date = (day: string) => day.split('-').reverse().join('/');
    const period = date(startDay) + ' a ' + date(addCalendarDays(endDay, -1));
    if (!shown.length) return `⏰ Nenhum lembrete pendente nesta conversa de ${period}.`;
    const time = new Intl.DateTimeFormat('pt-BR', {
      timeZone: zone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    return formatAstraMessage(
      '⏰ Lembretes pendentes da semana',
      [
        { label: 'Período', value: period },
        ...shown.map((row) => ({ label: time.format(row.remindAt), value: row.title })),
      ],
      rows.length > 50
        ? 'Mostrando os primeiros 50. “Cancele todos” se aplica somente aos 50 exibidos.'
        : undefined
    );
  } catch (error) {
    return channelDataFailure('reminder', cancel ? 'write' : 'read', error);
  }
}
