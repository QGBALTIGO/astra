import type { Message } from '@ownpilot/core/agent';
import { ChatRepository } from '../db/repositories/chat/index.js';
import { createMessagesRepository } from '../db/repositories/chat/messages.js';
import { stripInternalTags } from './normalizers/base.js';

/** Restore conversational context after deploy/cache eviction, never replay actions. */
export async function restoreChannelHistory(
  memory: {
    createWithId(id: string, prompt?: string): unknown;
    addMessage(id: string, message: Message): unknown;
  },
  conversationId: string,
  userId: string,
  currentPrompt?: string
): Promise<boolean> {
  const owned = await new ChatRepository(userId).getConversation(conversationId);
  if (!owned) return false;
  const rows = await createMessagesRepository().getRecentForUser(conversationId, userId, 24);
  memory.createWithId(conversationId, currentPrompt);
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    // Restored tool calls are deliberately NOT executable messages. Any status
    // or financial balance must be read anew from the user's tools.
    const content = row.role === 'assistant' ? stripInternalTags(row.content) : row.content;
    if (content.trim())
      memory.addMessage(conversationId, { role: row.role, content: content.slice(-6000) });
  }
  return true;
}
