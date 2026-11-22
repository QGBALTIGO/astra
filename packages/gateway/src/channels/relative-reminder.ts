/** Parse only explicit, self-contained reminder requests; contextual requests stay with the agent. */
export type RelativeReminderRequest =
  { kind: 'valid'; title: string; delaySeconds: number } | { kind: 'invalid'; message: string };

const MAX_DELAY_SECONDS = 366 * 24 * 60 * 60;
const INVALID_DELAY = 'Informe um prazo entre 1 segundo e 366 dias para o lembrete.';

function durationAmount(value: string): number {
  const word = value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const numbers: Record<string, number> = {
    um: 1,
    uma: 1,
    dois: 2,
    duas: 2,
    tres: 3,
    quatro: 4,
    cinco: 5,
    seis: 6,
    sete: 7,
    oito: 8,
    nove: 9,
    dez: 10,
    quinze: 15,
    vinte: 20,
    trinta: 30,
    meia: 0.5,
  };
  if (Object.hasOwn(numbers, word)) return numbers[word]!;
  // In Brazilian notation, 1.000 is one thousand, never one second.
  if (/^[+-]?[1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?$/u.test(value)) {
    return Number(value.replace(/\./g, '').replace(',', '.'));
  }
  if (/^[+-]?\d+(?:,\d+)?$/u.test(value)) return Number(value.replace(',', '.'));
  // Keep unambiguous decimal forms already supported, such as 1.5 hours.
  if (/^[+-]?\d+\.\d{1,2}$/u.test(value)) return Number(value);
  return Number.NaN;
}

export function parseRelativeReminderRequest(text: string): RelativeReminderRequest | null {
  const input = text.trim();
  const request =
    input.match(
      /^(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar)\s+(?:em|daqui(?:\s+(?:a|uns?|umas?))?)\s+(.+?)\s+(?:para|pra|de|que)\s+(.+)$/iu
    ) ??
    input.match(
      /^(?:daqui(?:\s+(?:a|uns?|umas?))?|em)\s+(.+?)\s*,?\s+(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar)\s+(?:para|pra|de|que)\s+(.+)$/iu
    );
  if (!request) return null;

  const duration = request[1]!.trim();
  const title = request[2]!
    .trim()
    .replace(/[.!?]+$/, '')
    .trim();
  if (!title || title.length > 160) {
    return {
      kind: 'invalid',
      message: 'Informe um assunto de até 160 caracteres para o lembrete.',
    };
  }
  // A request to withhold scheduling must reach the conversational flow.
  // This deliberately does not match subjects such as "não esquecer o PC".
  if (
    /\b(?:não|nao|nunca)\s+(?:me\s+)?(?:agende|agenda|marque|crie|registre|salve|programe|lembre|lembra|avise|avisa|envie|mande)\b/iu.test(
      title
    )
  ) {
    return null;
  }
  // A second action needs the conversational flow to execute and confirm each part.
  if (
    /(?:\be\s+|;\s*)(?:tamb[eé]m\s+)?(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)|registre|anote|cancele|apague|exclua|reagende|crie|adicione|salve)\b/iu.test(
      title
    ) ||
    /\be\s+(?:em|daqui)\s+\d/iu.test(title)
  ) {
    return null;
  }

  const components = duration.matchAll(
    /([+-]?\d[\d.,]*|uma?|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|quinze|vinte|trinta|meia)\s*(segundos?|segs?|s|minutos?|mins?|min|m|horas?|hrs?|hr|h|dias?|semanas?)(?=\s|,|$|\d)/giu
  );
  let offset = 0;
  let delaySeconds = 0;
  let invalidNumber = false;
  const seenUnits = new Set<number>();
  for (const component of components) {
    const separator = duration.slice(offset, component.index);
    if (!(offset === 0 ? /^\s*$/u : /^\s*(?:,?\s*e|,)?\s*$/iu).test(separator)) {
      return null;
    }
    const amount = durationAmount(component[1]!);
    const unit = component[2]!.toLowerCase();
    const multiplier = unit.startsWith('semana')
      ? 604_800
      : unit.startsWith('dia')
        ? 86_400
        : unit.startsWith('h')
          ? 3_600
          : unit.startsWith('m')
            ? 60
            : 1;
    if (seenUnits.has(multiplier)) return null;
    seenUnits.add(multiplier);
    if (!Number.isFinite(amount) || amount < 0) invalidNumber = true;
    delaySeconds += amount * multiplier;
    offset = component.index + component[0].length;
  }
  // Do not interpret alternatives, unknown units, or extra text as a single duration.
  if (offset === 0 || duration.slice(offset).trim()) return null;
  if (
    invalidNumber ||
    !Number.isSafeInteger(delaySeconds) ||
    delaySeconds < 1 ||
    delaySeconds > MAX_DELAY_SECONDS
  ) {
    return { kind: 'invalid', message: INVALID_DELAY };
  }
  return { kind: 'valid', title, delaySeconds };
}
