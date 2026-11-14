import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { integrationPrivateChat } from './customer-integrations.js';

/** Customer pairing is distinct from the bot-owner pairing key. */
export async function customerTelegramLinkReply(
  message: ChannelIncomingMessage,
  key: string,
  verify: (token: string) => Promise<{ success: boolean; ownpilotUserId?: string }>
): Promise<string | null> {
  if (message.platform !== 'telegram' || !key.startsWith('ASTRA_')) return null;
  if (!integrationPrivateChat(message) || message.attachments?.length)
    return '🔒 Envie esse comando na conversa particular com o Astra para vincular sua conta.';
  if (!/^ASTRA_[A-Z2-9]{8}$/.test(key))
    return 'Esse código de vínculo não é válido. Gere outro na aba Conexões do seu painel.';
  try {
    const result = await verify(key.slice(6));
    if (!result.success)
      return 'Esse código expirou ou já foi usado. Gere outro na aba Conexões e envie aqui na conversa particular.';
    return result.ownpilotUserId === 'default'
      ? 'Sua conversa foi verificada. Para usar conexões pessoais, vincule o cadastro do seu painel.'
      : '✅ Conta vinculada! Agora você pode usar suas conexões, agenda e registros do Astra também por aqui.';
  } catch {
    return 'Não consegui verificar o vínculo agora. Tente novamente em instantes; suas contas continuam protegidas.';
  }
}
