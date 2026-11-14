import type { ChannelIncomingMessage, ChannelPluginAPI } from '@ownpilot/core/channels';
import type { ChannelUserEntity } from '../db/repositories/channels/users.js';
import type { CustomerPhoneResolution } from '../db/repositories/customer-accounts.js';
import { whatsappPhoneSpellings } from './whatsapp-phone.js';
import { isChannelUserAccessActive } from './channel-access-service.js';

interface IdentityDependencies {
  findUser: (phone: string) => Promise<ChannelUserEntity | null>;
  resolvePhone: (phone: string) => Promise<CustomerPhoneResolution | null>;
  owner: () => Promise<string | null>;
  api?: ChannelPluginAPI;
}
/** Reuse a grant's Brazilian spelling only after the transport verifies one recipient. Never merge accounts. */
export async function resolveInboundWhatsAppSpelling(
  message: ChannelIncomingMessage,
  d: IdentityDependencies
): Promise<ChannelIncomingMessage> {
  const phone = message.sender.platformUserId;
  if (
    message.platform !== 'whatsapp' ||
    message.metadata?.isGroup === true ||
    message.metadata?.fromMe !== false
  )
    return message;
  const spellings = whatsappPhoneSpellings(phone);
  if (
    spellings.length !== 2 ||
    !d.api?.resolveWhatsAppRecipient ||
    d.api.getStatus() !== 'connected'
  )
    return message;
  const exact = await d.findUser(phone);
  // Existing managed identities, restrictions and historical accounts remain authoritative.
  if (
    exact &&
    (exact.isBlocked ||
      exact.isVerified ||
      exact.accessSource != null ||
      exact.accessExpiresAt != null ||
      exact.ownpilotUserId === 'default')
  )
    return message;
  const alternate = spellings[1]!;
  const user = await d.findUser(alternate);
  if (!user || !isChannelUserAccessActive(user) || user.ownpilotUserId !== 'whatsapp:' + alternate)
    return message;
  const [current, other, owner] = await Promise.all([
    d.resolvePhone(phone),
    d.resolvePhone(alternate),
    d.owner(),
  ]);
  if (current || spellings.includes(owner ?? '') || (other && (!other.isCurrent || other.retired)))
    return message;
  const verified = await d.api.resolveWhatsAppRecipient(phone).catch(() => null);
  if (!verified || !spellings.includes(verified) || d.api.getStatus() !== 'connected')
    return message;
  // Persist one business chat scope for durable reminders and account history.
  // The transport separately resolves its verified delivery spelling.
  return {
    ...message,
    platformChatId: alternate,
    sender: { ...message.sender, platformUserId: alternate },
  };
}
