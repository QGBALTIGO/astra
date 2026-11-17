import { BRAZIL_TEAMS } from './football.js';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

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

/** An immediate public lookup never authorizes a subscription or a saved preference. */
export function radarPreviewRequest(
  text: string
): { action: 'preview'; source: 'football' | 'news'; subject: string } | undefined {
  const input = fold(text)
    .replace(/\s+/g, ' ')
    .replace(/^(?:astra[,!]?\s+)?(?:por favor[,]?\s+)?/, '')
    .replace(/[?!.]+$/, '')
    .trim();
  if (
    /\b(?:e|depois|tambem)\s+(?:me\s+)?(?:avise|lembre|registre|anote|apague|exclua|remova|ative|acompanhe)\b/.test(
      input
    )
  )
    return undefined;
  const nextGame =
    /^(?:quando (?:o |a )?(.+?) joga(?: (?:de novo|dnv|novamente|hoje|amanha))?|(?:qual (?:e )?(?:o )?|quando (?:e |sera )?(?:o )?|(?:me diga|mostre|consulte) (?:o )?)(?:proximo jogo|proxima partida) (?:do|da|de) (.+))$/.exec(
      input
    );
  const team = nextGame && canonicalFootballSubject(nextGame[1] ?? nextGame[2] ?? '');
  if (team) return { action: 'preview', source: 'football', subject: team };
  const news =
    /^(?:(?:quais (?:sao )?(?:as )?|(?:me (?:mostre|mande|diga)|mostre|consulte|quero ver) (?:as )?))?(?:(?:ultimas|principais|novas) )?noticias(?: (?:de|do|da|sobre) (.{1,100}))?$/.exec(
      input
    );
  if (news) return { action: 'preview', source: 'news', subject: news[1]?.trim() || 'mundo' };
  return undefined;
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
    /^(?:(?:uma?|duas?|\d{1,3}) (?:horas?|minutos?) )?antes(?: (?:do|da) (?:jogo|partida)(?: (?:comecar|iniciar))?| do inicio(?: (?:do|da) (?:jogo|partida))?| de (?:comecar|iniciar)(?: (?:o|a) (?:jogo|partida))?)?$/.test(
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
    /\b(?:sempre|quando|cada|toda vez|todos os jogos|todas as partidas|nos dias de jogo)\b/.test(
      text
    ) &&
    (!/\b(?:hoje|amanha|essa partida|esse jogo|nesta partida|neste jogo|dia \d)\b/.test(text) ||
      /\b(?:sempre|cada|todos os jogos|todas as partidas)\b/.test(text)) &&
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
