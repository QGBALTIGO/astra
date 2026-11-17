/** A small, predictable reading/typing pause for conversational replies only. */
export function whatsappReplyDelayMs(text: string, env: NodeJS.ProcessEnv = process.env): number {
  if (env.ASTRA_WHATSAPP_REPLY_PACING === 'false') return 0;
  const bounded = (value: string | undefined, fallback: number, min: number, max: number) => {
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const min = bounded(env.ASTRA_WHATSAPP_REPLY_DELAY_MIN_MS, 1_500, 0, 15_000);
  const max = Math.max(min, bounded(env.ASTRA_WHATSAPP_REPLY_DELAY_MAX_MS, 6_000, 0, 15_000));
  const charsPerSecond = bounded(env.ASTRA_WHATSAPP_REPLY_CHARS_PER_SECOND, 100, 20, 1_000);
  const characters = Array.from(text.replace(/\s+/gu, ' ').trim()).length;
  return Math.round(Math.min(max, Math.max(min, 800 + (characters * 1_000) / charsPerSecond)));
}
