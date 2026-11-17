import { footballTimingReply } from './chat-intent.js';

/** Conversation-local continuity without importing the AI execution graph. */
export const radarChatPending = new Map<
  string,
  {
    args: Record<string, unknown>;
    accountId: string;
    needs: 'time' | 'subject';
    expires: number;
    messageId: string;
    recurringFootball?: boolean;
  }
>();

export function clearRadarChatPending(userId: string) {
  for (const key of radarChatPending.keys())
    if (JSON.parse(key)[0] === userId) radarChatPending.delete(key);
  for (const key of radarChatContext.keys())
    if (JSON.parse(key)[0] === userId) radarChatContext.delete(key);
}

export function isContextualRadarReply(
  userId: string,
  channelId: string | undefined,
  chatId: string | undefined,
  text: string
): boolean {
  if (!channelId || !chatId || !footballTimingReply(text)) return false;
  const context = radarChatContext.get(JSON.stringify([userId, channelId, chatId]));
  return !!context && context.expires > Date.now();
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
export interface RadarChatContext {
  accountId: string;
  subject: string;
  expires: number;
  messageId: string;
}

/** Public topic continuity only. This map never stores an operation or a clock. */
export const radarChatContext = new Map<string, RadarChatContext>();

export function rememberRadarChatContext(key: string, value: Omit<RadarChatContext, 'expires'>) {
  for (const [entryKey, entry] of radarChatContext)
    if (entry.expires <= Date.now()) radarChatContext.delete(entryKey);
  if (radarChatContext.size >= 5000 && !radarChatContext.has(key))
    radarChatContext.delete(radarChatContext.keys().next().value!);
  radarChatContext.set(key, { ...value, expires: Date.now() + 24 * 60 * 60000 });
}
