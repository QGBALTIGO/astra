import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { resolveCustomerPhone } from '../services/customer-identity.js';
import { integrationPrivateChat } from './customer-integrations.js';
import { isImmediateMorningRequest, morningComponents } from './morning-components.js';

export async function tryMorningBriefingChannelReply(
  message: ChannelIncomingMessage,
  userId: string,
  now = new Date()
): Promise<string | null> {
  if (message.attachments?.length || !isImmediateMorningRequest(message.text)) return null;
  if (!userId.startsWith('whatsapp:') || !integrationPrivateChat(message)) return null;
  const account = await customerAccountsRepo.getByDataUserId(userId);
  const phone = message.sender.platformUserId;
  const belongs = async (owner: typeof account) => {
    if (!owner) return userId === 'whatsapp:' + phone;
    const identity = await resolveCustomerPhone(phone);
    return identity?.accountId === owner.id && !identity.retired;
  };
  if (!(await belongs(account))) return null;
  // Load optional mail/provider dependencies only for an authorized briefing.
  const { buildMorningBriefing } = await import('../services/morning-briefing.js');
  const text = await buildMorningBriefing(
    userId,
    message.channelPluginId,
    account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande',
    morningComponents(message.text),
    now
  );
  const latest = await customerAccountsRepo.getByDataUserId(userId);
  if (latest?.id !== account?.id || !(await belongs(latest)))
    return 'A identificação desta conversa mudou durante a consulta. Envie o pedido novamente.';
  return text;
}
