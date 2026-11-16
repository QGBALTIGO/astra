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
    if (JSON.parse(key)[0] === userId) radarChatPending.delete(key);
}

export function isPendingRadarReply(
  userId: string,
  channelId: string | undefined,
  chatId: string | undefined,
  text: string
): boolean {
  if (!channelId || !chatId) return false;
  const entry = radarChatPending.get(JSON.stringify([userId, channelId, chatId]));
  if (!entry || entry.expires <= Date.now()) return false;
  if (entry.needs === 'time')
    return /^\s*(?:[aà]s?\s*)?(?:[01]?\d|2[0-3])(?:(?:h|:)[0-5]?\d?)?\s*(?:horas?)?[.!]?\s*$/iu.test(
      text
    );
  const input = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  return (
    /^[\p{L}\p{M}\s,.'()–-]{2,100}$/u.test(text) &&
    !/\b(?:oi|ola|obrigad\w*|nao|sim|pare|cancel\w*|gastei|paguei|recebi|lembre|lembrete|assinatura|consulte|quero|qual|quais|mostre|veja|preciso|pode|sem cadastrar)\b/.test(
      input
    )
  );
}
