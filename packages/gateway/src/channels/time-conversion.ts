import { customerLocalDateTime, customerLocalDay } from '../services/customer-date.js';
import { parseChannelCalendarDay, parseChannelClock } from './calendar-mutation.js';
import { NAMED_ZONES, resolveCustomerTimeZone } from './timezone-routing.js';

const cityZones: Readonly<Record<string, string>> = {
  ...NAMED_ZONES,
  manaus: 'America/Manaus',
  'rio branco': 'America/Rio_Branco',
  'fernando de noronha': 'America/Noronha',
  lisboa: 'Europe/Lisbon',
};
const cities = Object.keys(cityZones)
  .sort((a, b) => b.length - a.length)
  .join('|');
const placePattern = new RegExp(
  '\\b((?:[a-z_+-]+/)+[a-z0-9_+-]+|utc|gmt|' + cities + ')(?![\\w/+:-])',
  'gu'
);
const datePattern =
  /(?<![\d/.-])(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\s+de\s+[a-z]+\s+de\s+\d{4})(?![\d/.-]\d)/gu;
const timePattern =
  /\b(?:(\d{1,2})(?:\s*h(?:oras?)?(\d{2})?|:(\d{2}))|(\d{1,2})(?=\s*(?:e meia|am|pm|da (?:manha|tarde|noite))\b)|meio[- ]dia|meia[- ]noite)(?: e (meia))?(?:\s*(am|pm|da manha|da tarde|da noite))?(?![\w:])/gu;
const query =
  /\b(?:que horas?|que horario|qual (?:o |e o |seria o )?horario|a que horas?|equivale|equivalem|corresponde|correspondem|quanto fica)\b/u;
const convert = /\b(?:converta|converte|converter|conversao)\b/u;
const askZones =
  'Qual é o fuso de origem e para qual fuso você quer converter? Pode informar as cidades ou os nomes IANA.';
const askDate =
  'Qual é a data na cidade de origem? Informe dia, mês e ano e confira o dia da semana.';
const askTime =
  'Qual é o horário de origem? Informe uma única hora no formato HH:MM, entre 00:00 e 23:59.';

function calendarDay(text: string, today: string): string | null {
  const dates = [...text.matchAll(datePattern)];
  if (
    /\b(?:dia\s+\d{1,2}|\d{1,2}\/\d{1,2}|\d{4}-\d{1,2}-\d{1,2})\b/u.test(
      text.replace(datePattern, '')
    )
  )
    return null;
  const weekdays = [
    ...text.matchAll(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?\b/gu),
  ];
  const relative = [...text.matchAll(/\b(hoje|amanha)\b/gu)];
  if (dates.length > 1 || weekdays.length > 1 || relative.length > 1) return null;
  let date = dates[0]?.[0]?.replace(/\bmarco\b/gu, 'março') ?? '';
  if (/^\d{4}-/u.test(date)) date = date.split('-').reverse().join('/');
  const weekday = weekdays[0]?.[1]?.replace('terca', 'terça').replace('sabado', 'sábado');
  const dayWord = relative[0]?.[1]?.replace('amanha', 'amanhã');
  return parseChannelCalendarDay([dayWord, weekday, date].filter(Boolean).join(', '), today);
}

function sourceTime(match: RegExpMatchArray, text: string): string | null {
  const [raw, clockHour, hMinutes, colonMinutes, dayPartHour, half, period] = match;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index! + raw.length);
  // An unsupported minute expression must not be silently rounded to a whole hour.
  if (
    /(?:\d:|\b(?:minutos?|quarto|\d{1,2}|cinco|dez|quinze|vinte|vinte e cinco)\s+(?:para|pras?|antes d[ae])\s+(?:as?\s+)?)$/u.test(
      before
    ) ||
    /^\s*(?:[+−-]\s*\d|(?:menos|mais|passad[ao]s?)\b|e\s+(?!que\b|qual\b|quanto\b|gostaria\b|quero\b|preciso\b)\S)/u.test(
      after
    ) ||
    (half && (hMinutes !== undefined || colonMinutes !== undefined))
  )
    return null;
  const minutes = half ? '30' : (hMinutes ?? colonMinutes ?? '00');
  if (raw.startsWith('meia')) return period ? null : '00:' + minutes;
  if (raw.startsWith('meio')) return period ? null : '12:' + minutes;
  let hour = Number(clockHour ?? dayPartHour);
  if (period) {
    if (hour < 1 || hour > 12 || (period === 'da noite' && hour < 6)) return null;
    hour = (hour % 12) + (['pm', 'da tarde', 'da noite'].includes(period) ? 12 : 0);
    if (period === 'da noite' && hour === 12) hour = 0;
  }
  return parseChannelClock(String(hour) + ':' + minutes);
}

/** Interpret the stated direction, including “Que horas em X quando em Y são 14h?”. */
function direction(pattern: string): { from: number; to: number } | null {
  const pair =
    /@(\d)\s*(?:,?\s*(?:para|pra)|->|→)\s+(?:(?:o\s+)?(?:fuso|horario)\s+de\s+|a\s+hora\s+de\s+)?@(\d)/u.exec(
      pattern
    ) ?? /~\s*\(\s*@(\d)\s*\)\s*(?:em|para|pra)\s+@(\d)/u.exec(pattern);
  if (pair) return { from: Number(pair[1]), to: Number(pair[2]) };
  const source =
    /~\s*[,([]?\s*(?:(?:pelo|no|do|na)\s+)?(?:(?:horario|fuso|hora)\s+)?(?:de|em|do|da)\s+@(\d)/u.exec(
      pattern
    ) ??
    /~\s*\(\s*@(\d)\s*\)/u.exec(pattern) ??
    /(?:em|de|no fuso de)\s+@(\d)[, )]*(?:(?:sao|for|forem|e|as|a)\s+)*~/u.exec(pattern);
  const target =
    /(?:que horas?|que horario|qual (?:e o |o |seria o )?horario|equivalem?|correspondem?|quanto fica)[^@~?.!]{0,52}?\b(?:em|na|no|para|pra)\s+(?:(?:o\s+)?(?:fuso|horario)\s+de\s+)?@(\d)/u.exec(
      pattern
    ) ?? /(?:para|pra)\s+(?:(?:o\s+)?(?:fuso|horario)\s+de\s+)?@(\d)/u.exec(pattern);
  if (!source || !target || source[1] === target[1]) return null;
  return { from: Number(source[1]), to: Number(target[1]) };
}

/** Pure, informational conversion. It never reads an account, changes its timezone or schedules an event. */
export function tryChannelTimeConversion(raw: string, receivedAt: Date): string | null {
  if (raw.length > 600) return null;
  const text = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/(\d)t(?=\d{2}:)/gu, '$1 ')
    .replace(/\bas (\d{1,2})(?=\s+(?:de|em|do|no|para)\b)/gu, 'as $1h');
  const places = [...text.matchAll(placePattern)];
  const clocks = [...text.matchAll(timePattern)];
  const localQuestion =
    /\b(?:que horas?|que horario|qual (?:e o |o |seria o )?horario)\s+(?:(?:sao|serao|seria|sera|fica|ficaria|isso|agora)\s+)*(?:em|aqui|ai|no fuso|no horario)\b/u.test(
      text
    );
  const direct =
    /^(?:(?:no dia|dia|em|as)\s+)?(?:\d|meio[- ]dia|meia[- ]noite)/u.test(text) &&
    /\b(?:para|pra)\b|→|->/u.test(text) &&
    places.length >= 2 &&
    clocks.length > 0;
  if (
    !convert.test(text) &&
    !localQuestion &&
    /\b(?:custa|preco|custo|passagem|distancia|quilometros|duracao|quanto tempo)\b/u.test(text)
  )
    return null;
  if (!(
    direct ||
    (convert.test(text) && (clocks.length > 0 || /\b(?:hora|horas|horario|fuso)\b/u.test(text))) ||
    (query.test(text) && clocks.length > 0 && (places.length >= 2 || localQuestion))
  ))
    return null;
  // A compound command belongs to the normal, verified action pipeline.
  const actionText = text.replace(
    /\b(?:nao|sem)\s+(?:precisa\s+)?(?:agend[ae]r?|marqu?e?|marcar|registr[ae]r?)\b/gu,
    ''
  );
  if (
    /\b(?:agende|marque|reagende|remarque|anote|registre|cancele|envie|adicione|crie|me lembre|me avise)\b/u.test(
      actionText
    )
  )
    return null;
  if (
    places.length !== 2 ||
    /[@~]/u.test(text) ||
    /(?<![a-z_/])(?:utc|gmt)\s*[+-]\s*\d/u.test(text) ||
    /\b(?:cst|bst|ist|pst|pdt|edt|est|brt|brst)\b/u.test(text.replace(placePattern, ''))
  )
    return askZones;
  if (clocks.length !== 1) return askTime;
  if (/\b(?:ou|talvez)\b/u.test(text))
    return 'Informe uma única data, um horário e os dois fusos para a conversão.';
  const hour = sourceTime(clocks[0]!, text);
  if (!hour) return askTime;
  let placeIndex = 0;
  const pattern = text.replace(timePattern, '~').replace(placePattern, () => '@' + placeIndex++);
  const roles = direction(pattern);
  if (!roles) return askZones;
  const resolve = (place: string) => resolveCustomerTimeZone(cityZones[place] ?? place);
  const from = resolve(places[roles.from]![0]),
    to = resolve(places[roles.to]![0]);
  if (!from || !to) return askZones;
  if (!(receivedAt instanceof Date) || !Number.isFinite(receivedAt.getTime())) return askDate;
  const date = calendarDay(text, customerLocalDay(receivedAt, from));
  if (!date) return askDate;
  try {
    const at = customerLocalDateTime(date + 'T' + hour, from);
    let time = new Intl.DateTimeFormat('pt-BR', {
      timeZone: to,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    const day = customerLocalDay(at, to);
    // The destination can show the same wall time twice. The instant is known;
    // include its actual offset so the selected occurrence remains identifiable.
    try {
      customerLocalDateTime(day + 'T' + time, to);
    } catch {
      const offset = new Intl.DateTimeFormat('pt-BR', { timeZone: to, timeZoneName: 'longOffset' })
        .formatToParts(at)
        .find((part) => part.type === 'timeZoneName')?.value;
      if (offset) time += ' (' + offset + ')';
    }
    return day === date ? time : time + ' de ' + day.split('-').reverse().join('/') + '.';
  } catch {
    return 'Esse horário de origem é inexistente ou ocorre duas vezes nessa data por causa da mudança de fuso. Informe outro horário ou indique o instante em UTC.';
  }
}
