const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

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
