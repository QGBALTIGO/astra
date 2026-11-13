import { channelDataFailure } from './channel-failure.js';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import {
  channelRemindersRepo,
  type ChannelReminder,
} from '../db/repositories/channel-reminders.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { addCalendarDays, customerDayStart, customerLocalDay } from '../services/customer-date.js';
import { formatAstraMessage } from './response-presentation.js';
import { stripInternalTags } from './normalizers/base.js';
import { resolveCustomerTimeZone } from './timezone-routing.js';

const PAGE_SIZE = 15;
const statusLabels: Record<ChannelReminder['status'], string> = {
  pending: 'Agendado',
  sending: 'Em envio',
  delivered: 'Entregue',
  failed: 'Falha no envio',
  cancelled: 'Cancelado',
};

export async function tryListTodaysReminders(
  message: Pick<
    ChannelIncomingMessage,
    'text' | 'timestamp' | 'channelPluginId' | 'platformChatId' | 'platform' | 'attachments'
  >,
  userId: string
): Promise<string | null> {
  if (
    (message.platform !== 'whatsapp' && message.platform !== 'telegram') ||
    message.attachments?.length ||
    message.text.length > 150
  )
    return null;
  const text = message.text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const qualifier =
    /(?:[?.,!]?\s+(?:(?:mostre|exiba)\s+os\s+horarios|(?:no|pelo)\s+(?:horario|fuso))\s+de\s+)([a-z0-9_+/-]+(?: [a-z0-9_+/-]+)*)[?!.]*$/.exec(
      text
    );
  const explicitZone = qualifier ? resolveCustomerTimeZone(qualifier[1]!) : null;
  if (qualifier && !explicitZone) return null;
  const request = qualifier ? text.slice(0, qualifier.index).trim() : text;
  if (
    !/^(?:astra[, ]+)?(?:(?:quais (?:sao )?|(?:liste|mostre) )(?:os )?)?(?:meus )?lembretes (?:de |para |pra )?hoje(?:,? por favor)?[?!.]*$/.test(
      request
    )
  )
    return null;
  if (!userId || !message.platformChatId || !message.channelPluginId) {
    return 'Não consegui identificar a conversa para consultar os lembretes.';
  }
  try {
    const timeZone =
      explicitZone ??
      (await customerAccountsRepo.getByDataUserId(userId))?.timeZone ??
      process.env.TZ ??
      'America/Campo_Grande';
    const now = new Date();
    const received = message.timestamp;
    const day = customerLocalDay(
      received && received.getTime() <= now.getTime() ? received : now,
      timeZone
    );
    const reminders = await channelRemindersRepo.listForChatInRange(
      userId,
      message.channelPluginId,
      message.platformChatId,
      customerDayStart(day, timeZone),
      customerDayStart(addCalendarDays(day, 1), timeZone),
      PAGE_SIZE + 1
    );
    const zoneLabel = explicitZone === 'America/Cuiaba' ? 'Cuiabá' : explicitZone;
    const date = day.split('-').reverse().join('/') + (zoneLabel ? ' (' + zoneLabel + ')' : '');
    if (!reminders.length) return `Nenhum lembrete nesta conversa para ${date}.`;
    const time = new Intl.DateTimeFormat('pt-BR', { timeZone, timeStyle: 'medium' });
    return formatAstraMessage(
      `⏰ Lembretes de ${date}`,
      reminders.slice(0, PAGE_SIZE).map((item) => ({
        label: `${time.format(item.remindAt)} · ${statusLabels[item.status]}`,
        value:
          stripInternalTags(item.title)
            .replace(/<[^>]*>/g, '')
            .trim()
            .slice(0, 140) || 'Sem título',
      })),
      reminders.length > PAGE_SIZE ? `Mostrando os primeiros ${PAGE_SIZE} lembretes.` : undefined
    );
  } catch (error) {
    return channelDataFailure('reminder', 'read', error);
  }
}
