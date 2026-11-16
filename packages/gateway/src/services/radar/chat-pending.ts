/** Conversation-local continuity without importing the AI execution graph. */
export const radarChatPending = new Map<
  string,
  {
    args: Record<string, unknown>;
    accountId: string;
    needs: 'time' | 'subject';
    expires: number;
    messageId: string;
  }
>();

export function clearRadarChatPending(userId: string) {
  for (const key of radarChatPending.keys())
    if (JSON.parse(key)[1] === userId) radarChatPending.delete(key);
}
