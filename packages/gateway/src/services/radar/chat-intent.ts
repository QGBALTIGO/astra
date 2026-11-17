import { BRAZIL_TEAMS } from './football.js';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** Only the customer's own stated interval can override the 60-minute default. */
export function footballLeadMinutes(text: string): number | undefined {
  const input = fold(text);
  const amount = '(\\d{1,4}|um|uma|dois|duas)';
  const unit = '(min(?:utos?)?|h(?:oras?)?)(?!\\p{L})';
  const start = '(?<![\\p{L}\\p{N}.,-])';
  const atom = start + amount + '\\s*' + unit;
  const matches = [
    ...input.matchAll(
      new RegExp(
        atom + '(?:\\s*(?:e\\s*)?' + amount + '\\s*' + unit + ')?\\s*(?:antes|de antecedencia)\\b',
        'gu'
      )
    ),
  ];
  if (matches.length !== 1 || /\b(?:ou|entre)\b/.test(input)) return undefined;
  const [, value, firstUnit, secondValue, secondUnit] = matches[0]!;
  const atoms = [...input.matchAll(new RegExp(amount + '\\s*' + unit, 'gu'))];
  if (atoms.length !== (secondValue ? 2 : 1)) return undefined;
  if (secondValue && firstUnit!.startsWith('h') === secondUnit!.startsWith('h')) return undefined;
  const valueOf = (v: string) =>
    /^(?:um|uma)$/.test(v) ? 1 : /^(?:dois|duas)$/.test(v) ? 2 : Number(v);
  const duration = (v: string, u: string) => valueOf(v) * (u.startsWith('h') ? 60 : 1);
  const minutes =
    duration(value!, firstUnit!) + (secondValue ? duration(secondValue, secondUnit!) : 0);
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440 ? minutes : undefined;
}

export function canonicalFootballSubject(subject: string): string | undefined {
  const query = fold(subject).replace(/\s+/g, ' ');
  if (query.length < 3) return undefined;
  const teams = BRAZIL_TEAMS.filter(
    (team) =>
      [team[1], team[2]].some((name) => fold(name) === query) ||
      (' ' + fold(team[3]) + ' ').includes(' ' + query + ' ')
  );
  return teams.length === 1 ? teams[0]![1] : undefined;
}

/** These short clarifications carry a public topic, never recurring consent. */
export function footballTimingReply(
  text: string
): { kind: 'before' } | { kind: 'all-team'; subject: string } | undefined {
  const input = fold(text)
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
  if (
    /^(?:(?:um|uma|dois|duas|\d{1,4})\s*(?:h(?:oras?)?|min(?:utos?)?)\s*)?antes(?: (?:do|da) (?:jogo|partida)(?: (?:comecar|iniciar))?| de cada (?:jogo|partida)| do inicio(?: (?:do|da) (?:jogo|partida))?| de (?:comecar|iniciar)(?: (?:o|a) (?:jogo|partida))?)?$/.test(
      input
    )
  )
    return { kind: 'before' };
  if (
    footballLeadMinutes(input) !== undefined &&
    /^(?:(?:um|uma|dois|duas|\d{1,4})\s*(?:h(?:oras?)?|min(?:utos?)?)\s*(?:e\s*)?){1,2}antes(?: (?:do|da) (?:jogo|partida)(?: (?:comecar|iniciar))?)?$/.test(
      input
    )
  )
    return { kind: 'before' };
  const all = /^tod(?:os|as)\s*(?:(?:os\s*)?jogos|(?:as\s*)?partidas)?\s*(?:do|da|de)\s*(.+)$/.exec(
    input
  );
  const subject = all?.[1] ? canonicalFootballSubject(all[1]) : undefined;
  return subject ? { kind: 'all-team', subject } : undefined;
}

/** Only the customer's own explicit recurring game request authorizes a follow. */
export function gameAlertRequest(s: string): boolean {
  const text = fold(s).replace(
    /\b(?:mas )?nao (?:todo dia|todos os dias|diariamente)\b|\bsem (?:um )?resumo diario\b/g,
    ''
  );
  return (
    !/["“”«»]|\b(?:disse|falou|mensagem|frase|nao|pare|parar|paus\w*|cancel\w*|desativ\w*|deslig\w*|exemplo|hipotetic\w*|so explique|apenas explique)\b/.test(
      text
    ) &&
    /^(?:(?:oi|ola)[,!]?\s+)?(?:astra[,!]?\s+)?(?:por favor[,]?\s+)?(?:me (?:avise|avisar|lembre|notifique)|avisa|quero (?:ser avisad[oa]|um aviso|avisos))\b/.test(
      text
    ) &&
    /\b(?:jogos?|jogar|partidas?)\b/.test(text) &&
    /\b(?:sempre|quando|cada|toda vez|todos os jogos|todas as partidas|nos dias de jogo|dos jogos|das partidas)\b/.test(
      text
    ) &&
    (!/\b(?:hoje|amanha|essa partida|esse jogo|nesta partida|neste jogo|dia \d|(?:o|do|a|da) (?:proxim[oa] )?(?:jogo|partida)|proxim[oa] (?:jogo|partida))\b/.test(
      text
    ) ||
      /\b(?:sempre|cada|toda vez|todos os jogos|todas as partidas)\b/.test(text)) &&
    !/\b(?:resumo diario|todo dia|todos os dias|diariamente)\b/.test(text)
  );
}

/** A time must be written by the customer; multiple clocks need clarification. */
export function explicitRadarTime(text: string): string | undefined {
  const input = fold(text);
  const times = [
    ...input.matchAll(
      /(?:\bas\s+|\ba\s+|^\s*)(\d{1,2})(?:(?:h|:)(\d{1,2})?)?(?:\s*(?:h|horas?))?(?:\s+(?:da|a)\s+(manha|tarde|noite))?\b/g
    ),
  ];
  if (times.length !== 1) return undefined;
  const time = times[0]!;
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  if (['tarde', 'noite'].includes(time[3] ?? '') && hour < 12) hour += 12;
  if (time[3] === 'manha' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}
