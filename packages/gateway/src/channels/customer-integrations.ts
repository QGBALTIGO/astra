import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { customerIntegrationsRepo } from '../db/repositories/customer-integrations.js';
import {
  customerIntegrationService,
  integrationProposalMessage,
} from '../services/customer-integrations.js';

export function integrationPrivateChat(message: ChannelIncomingMessage): boolean {
  return (
    ['whatsapp', 'telegram'].includes(message.platform) &&
    message.metadata?.isGroup !== true &&
    message.platformChatId === message.sender.platformUserId
  );
}

/** An ordinary second message authorizes only the displayed proposal in this conversation. */
export async function tryIntegrationConfirmation(
  message: ChannelIncomingMessage,
  userId: string
): Promise<string | null> {
  if (process.env.ASTRA_CUSTOMER_OAUTH_ENABLED !== 'true') return null;
  if (!integrationPrivateChat(message) || message.attachments?.length || userId === 'default')
    return null;
  const row = await customerIntegrationsRepo.latestPending(
    userId,
    message.channelPluginId,
    message.platformChatId
  );
  if (!row || row.request_message_id === message.id) return null;
  const text = message.text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  const yes =
    /^(?:sim|confirmo|confirmar|pode fazer|pode confirmar|pode sim|ok|confirmar [a-f0-9]{6})$/.test(
      text
    );
  const no = /^(?:nao|cancelar|cancela|cancelar [a-f0-9]{6})$/.test(text);
  if (!yes && !no) {
    if (/^(?:o que|quais|qual|como|pode explicar|mostra|repete).*[?]?$/.test(text))
      return integrationProposalMessage(row);
    await customerIntegrationsRepo.cancel(
      row.id,
      userId,
      message.channelPluginId,
      message.platformChatId
    );
    return null;
  }
  const token = text.match(/ ([a-f0-9]{6})$/)?.[1];
  if (token && token.toUpperCase() !== row.confirmation_token)
    return 'Essa confirmação não corresponde ao pedido atual. Confira os detalhes da última mensagem.';
  if (
    !row.prompt_sent_at ||
    !message.timestamp ||
    message.timestamp.getTime() + 999 < new Date(row.prompt_sent_at).getTime()
  )
    return 'A confirmação precisa vir depois da mensagem com os detalhes. Confira o pedido e responda novamente.';
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await customerIntegrationsRepo.cancel(
      row.id,
      userId,
      message.channelPluginId,
      message.platformChatId
    );
    return 'Esse pedido expirou. Me conte novamente o que deseja alterar para eu conferir os detalhes com você.';
  }
  if (no) {
    await customerIntegrationsRepo.cancel(
      row.id,
      userId,
      message.channelPluginId,
      message.platformChatId
    );
    return 'Tudo bem, cancelei esse pedido. Nenhuma alteração foi enviada ao aplicativo.';
  }
  const claimed = await customerIntegrationsRepo.claim(
    row.id,
    userId,
    message.channelPluginId,
    message.platformChatId
  );
  if (!claimed)
    return 'Esse pedido já está sendo conferido. Consulte o aplicativo antes de tentar novamente.';
  return customerIntegrationService.confirm(claimed);
}
