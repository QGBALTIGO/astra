/** Only explicit morning preferences are changed; omitted components retain their settings. */
export interface MorningComponents {
  withCuriosity?: boolean;
  withWeather?: boolean;
  withEmailDigest?: boolean;
  emailPreviousDay?: boolean;
}
export const normalizeMorningText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export function morningComponents(text: string): MorningComponents {
  const input = normalizeMorningText(text);
  const parts: MorningComponents = {};
  if (/\b(?:curiosidades?|fatos? interessantes?)\b/.test(input))
    parts.withCuriosity =
      !/\bsem (?:a |uma )?curiosidade|\bnao (?:inclua|quero) (?:a |uma )?curiosidade/.test(input);
  if (/\b(?:temperatura|clima|previsao do tempo|tempo agora)\b/.test(input))
    parts.withWeather =
      !/\bsem (?:a )?(?:temperatura|clima|previsao)|\bnao (?:inclua|quero) (?:a )?(?:temperatura|clima)/.test(
        input
      );
  if (/\b(?:e[ -]?mails?|gmail)\b/.test(input)) {
    parts.withEmailDigest =
      !/\bsem (?:os )?(?:e[ -]?mails?|gmail)|\bnao (?:inclua|quero) (?:os )?e[ -]?mails?/.test(
        input
      );
    parts.emailPreviousDay = !/\bultimas?\s+24\s*(?:h|horas)\b/.test(input);
  }
  return parts;
}

export function isImmediateMorningRequest(text: string): boolean {
  const input = normalizeMorningText(text);
  if (!/\bbom dia\b/.test(input) || !Object.keys(morningComponents(text)).length) return false;
  // Leave unrelated actions and unsupported briefing sections to the regular agent.
  return (
    !/\b(?:todo dia|todos os dias|diario|diariamente|toda manha|todas as manhas|agende|agendar|programe|cancele|cancelar|desative|registre|anote|crie|lembre|pague|exclua|agenda|compromissos?|tarefas?|saldo|gastos|noticias|horoscopo|metas?)\b/.test(
      input
    ) && !/\b(?:nao|nunca) (?:me )?(?:de|mande|envie|traga)\b/.test(input)
  );
}
