import { addCalendarDays, customerLocalDay, validCalendarDay } from '../services/customer-date.js';

/** Only explicit, single, customer-authored wall-clock reminders are eligible. */
export interface AbsoluteReminderRequest {
  title: string;
  dayOffset: 0 | 1 | 2;
  time: string;
  explicitDate?: string;
}

const command =
  /(?:por favor[, ]+)?(?:astra[, ]+)?(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar)/
    .source;
const day =
  /(?:depois de amanh[ãa]|amanh[ãa]|hoje|(?:dia\s+)?\d{1,2}\/\d{1,2}(?:\/\d{4})?|dia\s+\d{1,2})/
    .source;
const clock =
  /(?:(?:[àa]s|pelas)\s+(?:[01]?\d|2[0-3])(?:\s*h(?:[0-5]\d)?|:[0-5]\d|\s+horas?)?|(?:[01]?\d|2[0-3])(?:\s*h(?:[0-5]\d)?|:[0-5]\d|\s+horas?)|(?:ao|[àa])\s+(?:meio[- ]dia|meia[- ]noite))/
    .source;
const when =
  '(?:(?<day>' +
  day +
  ')\\s+)?(?<clock>' +
  clock +
  ')(?:\\s+(?<afterDay>' +
  day +
  '))?';
const patterns = [
  new RegExp('^' + command + '\\s+(?:de|para|pra|que)\\s+(?<title>.+?)\\s+' + when + '$', 'iu'),
  new RegExp('^' + command + '\\s+' + when + '\\s+(?:de|para|pra|que)\\s+(?<title>.+)$', 'iu'),
  new RegExp('^lembrete\\s+' + when + '\\s*[,:\\-]\\s*(?<title>.+)$', 'iu'),
  new RegExp('^lembrete\\s*:\\s*(?<title>.+?)\\s+' + when + '$', 'iu'),
];

const fold = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function parseAbsoluteReminderRequest(text: string): AbsoluteReminderRequest | null {
  if (text.length > 250 || /["“”«»;?\n]/u.test(text)) return null;
  const input = text
    .trim()
    .replace(/[.!]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  for (const pattern of patterns) {
    const match = pattern.exec(input)?.groups;
    if (!match) continue;
    if (match.day && match.afterDay) return null;
    const title = match.title!.trim();
    const subject = fold(title);
    // Reject another date/time, compound actions, negation or recurrence.
    // An explicit request to check whether something happened is a subject,
    // not authority to monitor an outside event.
    if (
      !title ||
      title.length > 160 ||
      !/\p{L}/u.test(title) ||
      /\b(?:ou|mas|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/u.test(subject) ||
      /\b(?:todo dia|todos os dias|diariamente|semanalmente|mensalmente|a cada|dia \d+)\b/u.test(
        subject
      ) ||
      /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/u.test(subject) ||
      /\b\d{1,2}(?:\s*h(?:\d{2})?|:\d{2}|\s+horas?)\b/u.test(subject) ||
      /\b(?:as|pelas)\s+\d{1,2}\b/u.test(subject) ||
      (/\b(?:se|quando|assim que|caso)\b/u.test(subject) &&
        !/^(?:verificar|conferir|consultar|checar|ver)\s+se\b/u.test(subject)) ||
      /\b(?:como|qual|quais|por que|onde|quem)\b/u.test(subject) ||
      /\b(?:nao|nunca)\s+(?:me\s+)?(?:agende|agenda|marque|crie|registre|salve|programe|lembre|lembra|avise|avisa|envie|mande)\b/u.test(
        subject
      ) ||
      /(?:\be\s+|,\s*)(?:tambem\s+)?(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)|registre|anote|cancele|apague|exclua|reagende|crie|adicione|salve|envie)\b/u.test(
        subject
      ) ||
      /\b(?:em|daqui(?: a)?)\s+\d+\s*(?:segundos?|minutos?|horas?|dias?|semanas?)\b/u.test(subject)
    ) {
      return null;
    }
    const clockText = fold(match.clock!).replace(/^(?:as|pelas|ao|a)\s+/u, '');
    let time: string;
    if (/^meio[- ]dia$/u.test(clockText)) {
      time = '12:00';
    } else if (/^meia[- ]noite$/u.test(clockText)) {
      time = '00:00';
    } else {
      const parts = /^(\d{1,2})(?:\s*h(\d{2})?|:(\d{2})|\s+horas?)?$/u.exec(clockText);
      if (!parts) return null;
      time = parts[1]!.padStart(2, '0') + ':' + (parts[2] ?? parts[3] ?? '00');
    }
    const dateText = fold(match.day ?? match.afterDay ?? 'hoje');
    if (dateText === 'hoje') return { title, dayOffset: 0, time };
    if (dateText === 'amanha') return { title, dayOffset: 1, time };
    if (dateText === 'depois de amanha') return { title, dayOffset: 2, time };
    return { title, dayOffset: 0, time, explicitDate: dateText.replace(/^dia\s+/u, '') };
  }
  return null;
}

/** Do not silently roll an impossible or past calendar date to another day. */
export function resolveAbsoluteReminderLocalDateTime(
  request: AbsoluteReminderRequest,
  receivedAt: Date,
  timeZone: string
): string | null {
  const today = customerLocalDay(receivedAt, timeZone);
  let date = addCalendarDays(today, request.dayOffset);
  if (request.explicitDate) {
    const parts = /^(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{4}))?)?$/u.exec(request.explicitDate);
    if (!parts) return null;
    const year = parts[3] ?? today.slice(0, 4);
    const month = parts[2]?.padStart(2, '0') ?? today.slice(5, 7);
    date = year + '-' + month + '-' + parts[1]!.padStart(2, '0');
  }
  return validCalendarDay(date) ? date + 'T' + request.time : null;
}
