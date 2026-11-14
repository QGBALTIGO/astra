import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { channelRemindersRepo } from '../db/repositories/channel-reminders.js';
import { formatAstraMessage } from './response-presentation.js';

export async function tryCancelNamedReminder(
  message: ChannelIncomingMessage,
  userId: string
): Promise<string | null> {
  if (
    (message.platform !== 'whatsapp' && message.platform !== 'telegram') ||
    message.attachments?.length ||
    message.text.length > 300
  )
    return null;

  const text = message.text.trim().replace(/[“”«»]/gu, '"');
  const command = text.replace(
    /^já (?:conferi|resolvi|fiz|paguei)(?: [\p{L}\p{N} -]{1,50})?[.!]\s+/iu,
    ''
  );
  const match = /^(?:por favor,?\s+)?cancel[ae] (?:s[óo] )?(?:o |meu )?lembrete (.+)$/iu.exec(
    command
  );
  if (!match) return null;
  const subject = match[1]!
    .replace(/[.!]$/u, '')
    .replace(/,? por favor$/iu, '')
    .replace(/ que acabei de criar$/iu, '')
    .trim();
  const quoted = /^"([^"]+)"$/u.exec(subject);
  if (
    !quoted &&
    (/["?,;]/u.test(subject) ||
      /\s(?:mas|se|exceto|ou)\s|\se\s+(?:me\s|depois\s|cancel|agend|remarc|apag|exclu|cri[ae]|mostr|list|lembr)/iu.test(
        subject
      ))
  )
    return null;
  const title = (quoted?.[1] ?? subject.replace(/^de\s+/iu, '')).trim();
  if (!title || title.length > 160) return null;
  if (!userId || !message.channelPluginId || !message.platformChatId) {
    return 'Não consegui identificar a conversa para cancelar o lembrete.';
  }
  const receivedAt = message.timestamp;
  if (!receivedAt || !Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() > Date.now()) {
    return 'Não consegui verificar o horário do pedido. Envie novamente o título do lembrete entre aspas.';
  }
  try {
    const result = await channelRemindersRepo.cancelByExactTitle(
      userId,
      message.channelPluginId,
      message.platformChatId,
      title,
      receivedAt
    );
    if (result === 'cancelled')
      return formatAstraMessage(
        '✅ Lembrete cancelado',
        [{ label: 'Assunto', value: title }],
        'Não enviarei esse aviso.'
      );
    if (result === 'ambiguous')
      return 'Encontrei mais de um lembrete com esse título. Qual horário você quer cancelar?';
    return 'Não encontrei um lembrete com esse título que ainda possa ser cancelado nesta conversa.';
  } catch {
    return 'Não consegui confirmar o cancelamento. Consulte seus lembretes para conferir o estado.';
  }
}
