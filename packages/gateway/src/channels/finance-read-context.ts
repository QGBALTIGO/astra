import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import type { CustomerAccount } from '../db/repositories/customer-accounts.js';
import {
  financeBulkSelectionRepo,
  type FinanceSelectionFilter,
  type FinanceSelectionScope,
} from '../db/repositories/finance-bulk-selection.js';
import { customerAccountBinding } from './customer-channel-access.js';

export function financeSelectionScope(
  message: Partial<ChannelIncomingMessage>,
  userId: string
): FinanceSelectionScope | null {
  if (
    !userId ||
    !message.channelPluginId ||
    !message.platformChatId ||
    !message.sender?.platformUserId ||
    message.sender.platformUserId !== message.platformChatId ||
    message.metadata?.isGroup === true ||
    message.metadata?.fromMe === true ||
    message.platformChatId.endsWith('@g.us') ||
    !['whatsapp', 'telegram'].includes(message.platform ?? '') ||
    (message.platform === 'telegram' && message.metadata?.chatType !== 'private')
  )
    return null;
  return {
    userId,
    channelPluginId: message.channelPluginId,
    platformChatId: message.platformChatId,
    senderId: message.sender.platformUserId,
  };
}
export async function rememberFinanceRead(
  message: Partial<ChannelIncomingMessage>,
  userId: string,
  filter: FinanceSelectionFilter,
  account: CustomerAccount | null
) {
  const scope = financeSelectionScope(message, userId);
  const at = message.timestamp;
  if (
    !scope ||
    !message.id ||
    !(at instanceof Date) ||
    Date.now() - at.getTime() > 10 * 60_000 ||
    at.getTime() > Date.now() + 5000
  )
    return;
  // Failure to store context must not hide an otherwise successful read; deletion then asks for a new selection.
  try {
    await financeBulkSelectionRepo.remember(
      scope,
      filter,
      message.id,
      at,
      customerAccountBinding(account)
    );
  } catch {
    /* no context is safer than guessed scope */
  }
}
