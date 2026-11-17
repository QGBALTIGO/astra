import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { runInExecContext } from '@ownpilot/core/agent';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { CustomerRadarRepository } from '../db/repositories/customer-radar.js';
import { resolveCustomerPhone } from '../services/customer-identity.js';
import { ASTRA_CUSTOMER_ORIGIN } from '../config/astra-public-urls.js';
import { integrationPrivateChat } from './customer-integrations.js';
import {
  clearRadarChatPending,
  isPendingRadarReply,
  radarChatContext,
  radarChatPending,
} from '../services/radar/chat-pending.js';
import {
  gameAlertRequest,
  explicitRadarTime,
  footballTimingReply,
} from '../services/radar/chat-intent.js';
import { isConversationalOnlyChannelRequest } from './tool-selection.js';

/** Narrow, zero-inference intents. Ordinary reminders and unrelated messages are untouched. */
export async function tryRadarChannelReply(
  message: ChannelIncomingMessage,
  userId: string,
  hasAccess: () => Promise<boolean>
): Promise<string | null> {
  if (message.platform !== 'whatsapp' || message.attachments?.length) return null;
  const text = message.text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ');
  const stop =
    /^(?:astra[,]? )?(?:(?:pode )?(?:parar|pare|cancela|cancelar|cancele|desativa|desativar|desative|pausa|pausar|pause)(?: de (?:mandar|enviar))? (?:o |meu |os avisos do |os alertas do )?radar|nao quero (?:mais )?receber (?:o |meu |os avisos do |os alertas do )?radar)$/.test(
      text
    );
  const list =
    /^(?:astra[,]? )?(?:meu radar|(?:quais|que) (?:alertas|acompanhamentos|assuntos) (?:eu )?tenho (?:ativos )?no radar|(?:mostra|mostrar|listar|liste)(?: os)? (?:meus )?acompanhamentos (?:do|no) radar)$/.test(
      text
    );
  const gameAlert = gameAlertRequest(message.text);
  const conversationOnly = isConversationalOnlyChannelRequest(message.text);
  if (!stop && !list && conversationOnly) return null;
  const footballTiming = footballTimingReply(message.text);
  const footballFollowUp =
    footballTiming?.kind === 'all-team' ||
    (footballTiming?.kind === 'before' && /\b(?:jogo|partida)\b/.test(text));
  const cancelText = /^(?:nao|cancelar|cancela|deixa pra la)$/.test(text);
  // This is only a cheap chat/channel preflight. Resolve the account before
  // selecting its exact private pending key: callers can carry a phone alias.
  const pendingCandidate = [...radarChatPending].some(([key, value]) => {
    const [owner, channel, chat] = JSON.parse(key) as string[];
    return (
      channel === message.channelPluginId &&
      chat === message.platformChatId &&
      value.expires > Date.now() &&
      (cancelText || isPendingRadarReply(owner!, channel, chat, message.text))
    );
  });
  const contextCandidate = [...radarChatContext].some(([key, value]) => {
    const [, channel, chat] = JSON.parse(key) as string[];
    return (
      channel === message.channelPluginId &&
      chat === message.platformChatId &&
      value.expires > Date.now() &&
      (cancelText || !!footballTiming)
    );
  });
  if (!stop && !list && !gameAlert && !footballFollowUp && !pendingCandidate && !contextCandidate)
    return null;
  if (
    !stop &&
    !list &&
    (!message.id || !message.channelPluginId || message.metadata?.fromMe !== false)
  )
    return null;
  if (!message.sender?.platformUserId || !integrationPrivateChat(message)) return null;
  try {
    const identity = await resolveCustomerPhone(message.sender.platformUserId);
    if (!identity || identity.retired || !identity.isCurrent) return null;
    const account = await customerAccountsRepo.getById(identity.accountId);
    if (
      !account ||
      account.phoneNumber !== message.sender.platformUserId ||
      account.dataUserId !== identity.dataUserId ||
      ![account.dataUserId, 'whatsapp:' + account.phoneNumber].includes(userId)
    )
      return null;
    const key = JSON.stringify([
      account.dataUserId,
      message.channelPluginId,
      message.platformChatId,
    ]);
    const pending = radarChatPending.get(key);
    const context = radarChatContext.get(key);
    const validContext =
      !!context &&
      context.accountId === account.id &&
      context.expires > Date.now() &&
      context.messageId !== message.id;
    const contextualReply = validContext && (cancelText || !!footballTiming);
    const validPending =
      !!pending &&
      pending.accountId === account.id &&
      pending.expires > Date.now() &&
      pending.messageId !== message.id;
    const pendingCancel = (validPending || validContext) && cancelText;
    const pendingReply =
      pendingCancel ||
      isPendingRadarReply(
        account.dataUserId,
        message.channelPluginId,
        message.platformChatId,
        message.text
      );
    if (
      !stop &&
      !list &&
      !gameAlert &&
      !footballFollowUp &&
      !contextualReply &&
      (!validPending || !pendingReply)
    )
      return null;
    const repo = new CustomerRadarRepository(account.dataUserId);
    if (stop) {
      clearRadarChatPending(account.dataUserId);
      const pref = await repo.preferences();
      await repo.savePreferences({ ...pref.preferences, enabled: false });
      return (
        '📡 *Radar pausado*\n\nDesativei os novos envios do seu Radar. Seus acompanhamentos continuam salvos para quando quiser voltar. Uma mensagem que já estava em transmissão pode ainda chegar.\n\nVocê pode ajustar tudo no painel: ' +
        ASTRA_CUSTOMER_ORIGIN +
        '/cliente/radar'
      );
    }
    if (!pendingCancel && !(await hasAccess()))
      return (
        'Seu Radar está no painel. Renove seu acesso para voltar a receber os avisos: ' +
        ASTRA_CUSTOMER_ORIGIN +
        '/cliente/radar'
      );
    if (gameAlert || footballFollowUp || contextualReply || (pendingReply && validPending)) {
      if (!message.id || !message.channelPluginId || message.metadata?.fromMe !== false)
        return null;
      const current = await resolveCustomerPhone(message.sender.platformUserId);
      if (
        current?.accountId !== account.id ||
        !current.isCurrent ||
        current.retired ||
        (!pendingCancel && !(await hasAccess()))
      )
        return (
          'Sua identificação ou acesso mudou. Confira seu Radar no painel: ' +
          ASTRA_CUSTOMER_ORIGIN +
          '/cliente/radar'
        );
      const { manageRadarChat } = await import('../services/radar/chat.js');
      const time = gameAlert ? explicitRadarTime(message.text) : undefined;
      const result = await runInExecContext(
        {
          channelPluginId: message.channelPluginId,
          platformChatId: message.platformChatId,
          channelMessageId: message.id,
          channelMessageTimestamp: message.timestamp?.getTime(),
          channelRequestText: message.text,
          channelIsPrivate: true,
          channelConversationOnly: conversationOnly,
          externalContentGuard: { seen: false },
        },
        () =>
          manageRadarChat(
            account.dataUserId,
            gameAlert ? { action: 'follow', ...(time && { time }) } : { action: 'status' }
          )
      );
      return result.reply;
    }
    const [interests, pref] = await Promise.all([repo.list(), repo.preferences()]);
    const current = await resolveCustomerPhone(message.sender.platformUserId);
    if (current?.accountId !== account.id || current.retired || !(await hasAccess()))
      return (
        'Sua identificação ou acesso mudou. Confira seu Radar no painel: ' +
        ASTRA_CUSTOMER_ORIGIN +
        '/cliente/radar'
      );
    return (
      '📡 *Seu Radar Astra*\n\n' +
      (pref.preferences.enabled ? 'Envios ativados.' : 'Envios pausados.') +
      '\n' +
      (interests.length
        ? interests
            .slice(0, 15)
            .map(
              (i) =>
                '• ' +
                i.label +
                (i.delivery === 'matchday' ? ' · só nos dias de jogo, às ' + i.notifyTime : '') +
                (i.active ? '' : ' (pausado)')
            )
            .join('\n')
        : 'Você ainda não escolheu assuntos para acompanhar.') +
      '\n\nGerencie seus assuntos: ' +
      ASTRA_CUSTOMER_ORIGIN +
      '/cliente/radar'
    );
  } catch {
    return (
      'Não consegui concluir o pedido do Radar agora. Você pode tentar novamente ou abrir o painel: ' +
      ASTRA_CUSTOMER_ORIGIN +
      '/cliente/radar'
    );
  }
}
