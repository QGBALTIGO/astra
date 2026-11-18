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

type AssetMessageScope = Pick<
  ChannelIncomingMessage,
  'id' | 'channelPluginId' | 'platform' | 'platformChatId'
>;
const VERIFIED_ASSET_SCOPE = Symbol('verified inbound WhatsApp asset scope');
type ResolvedInboundMessage = ChannelIncomingMessage & {
  [VERIFIED_ASSET_SCOPE]?: {
    original: AssetMessageScope;
    canonical: AssetMessageScope;
    sender: string;
  };
};

function assetScope(message: ChannelIncomingMessage): AssetMessageScope {
  return {
    id: message.id,
    channelPluginId: message.channelPluginId,
    platform: message.platform,
    platformChatId: message.platformChatId,
  };
}

/**
 * Only the verified resolver can attach this module-private Symbol. It survives
 * server-side object spreads, but cannot be supplied through JSON or metadata.
 */
export function inboundChannelAssetScope(message: ChannelIncomingMessage): AssetMessageScope {
  const verified = (message as ResolvedInboundMessage)[VERIFIED_ASSET_SCOPE];
  if (
    verified &&
    message.id === verified.canonical.id &&
    message.channelPluginId === verified.canonical.channelPluginId &&
    message.platform === verified.canonical.platform &&
    message.platformChatId === verified.canonical.platformChatId &&
    message.sender.platformUserId === verified.sender
  ) {
    return { ...verified.original };
  }
  return assetScope(message);
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
  const resolved: ResolvedInboundMessage = {
    ...message,
    platformChatId: alternate,
    sender: { ...message.sender, platformUserId: alternate },
  };
  resolved[VERIFIED_ASSET_SCOPE] = {
    original: Object.freeze(assetScope(message)),
    canonical: Object.freeze(assetScope(resolved)),
    sender: alternate,
  };
  return resolved;
}
