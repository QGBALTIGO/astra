/**
 * Strict, self-contained wall-clock requests. Never guess a date from history,
 * an external condition, a financial entry, a query or a compound command.
 */
export interface AbsoluteReminderRequest {
  title: string;
  dayOffset: 0 | 1;
  time: string;
}

const patterns = [
  /^(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar)\s+(?:de|para|pra)\s+(?<title>.+?)\s+(?:(?<day>hoje|amanh[ãa])\s+)?(?:[àa]s|pelas)\s+(?<clock>(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|:[0-5]\d))$/iu,
  /^(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar)\s+(?:(?<day>hoje|amanh[ãa])\s+)?(?:[àa]s|pelas)\s+(?<clock>(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|:[0-5]\d))\s+(?:de|para|pra)\s+(?<title>.+)$/iu,
  /^lembrete\s+(?:(?<day>hoje|amanh[ãa])\s+)?(?:[àa]s|pelas)\s+(?<clock>(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|:[0-5]\d))\s*[,:\-]\s*(?<title>.+)$/iu,
];

export function parseAbsoluteReminderRequest(text: string): AbsoluteReminderRequest | null {
  if (text.length > 250 || /["“”«»;?\n]/u.test(text)) return null;
  const input = text.trim().replace(/[.!]+$/u, '').trim();
  for (const pattern of patterns) {
    const match = pattern.exec(input)?.groups;
    if (!match) continue;
    const title = match.title!.trim();
    const folded = title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    // Do not execute alternatives, compound commands, negated scheduling,
    // queries, relative times or references to external conditions.
    if (
      !title ||
      title.length > 160 ||
      !/\p{L}/u.test(title) ||
      /\b(?:se|quando|assim que|caso|ou|mas|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/u.test(
        folded
      ) ||
      /\b(?:como|qual|quais|por que|onde|quem)\b/u.test(folded) ||
      /\b\d{1,2}(?:h(?:\d{2})?|:\d{2})\b/u.test(folded) ||
      /\b(?:nao|nunca)\s+(?:me\s+)?(?:agende|agenda|marque|crie|registre|salve|programe|lembre|lembra|avise|avisa|envie|mande)\b/u.test(
        folded
      ) ||
      /(?:\be\s+|,\s*)(?:tambem\s+)?(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)|registre|anote|cancele|apague|exclua|reagende|crie|adicione|salve)\b/u.test(
        folded
      ) ||
      /\b(?:em|daqui(?: a)?)\s+\d+\s*(?:segundos?|minutos?|horas?|dias?|semanas?)\b/u.test(
        folded
      )
    ) {
      return null;
    }
    const parts = /^(\d{1,2})(?:h(\d{2})?|:(\d{2}))$/iu.exec(match.clock!);
    if (!parts) return null;
    const time = parts[1]!.padStart(2, '0') + ':' + (parts[2] ?? parts[3] ?? '00');
    const dayOffset = match.day && /^amanh[ãa]$/iu.test(match.day) ? 1 : 0;
    return { title, dayOffset, time };
  }
  return null;
}
