/** Parse only explicit, self-contained reminder requests; contextual requests stay with the agent. */
export type RelativeReminderRequest =
  { kind: 'valid'; title: string; delaySeconds: number } | { kind: 'invalid'; message: string };

const MAX_DELAY_SECONDS = 366 * 24 * 60 * 60;
const INVALID_DELAY = 'Informe um prazo entre 1 segundo e 366 dias para o lembrete.';

function durationAmount(value: string): number {
  const words: Record<string, number> = {
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
    onze: 11,
    doze: 12,
    quinze: 15,
    vinte: 20,
    trinta: 30,
    meia: 0.5,
  };
  const word = value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(words, word)) return words[word]!;
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
  if (text.length > 250 || /["“”«»\n]/u.test(text)) return null;
  const input = text
    .trim()
    .replace(/^(?:por favor[, ]+)?(?:astra[, ]+)?/iu, '')
    .replace(/\s+/gu, ' ');
  const suffix = input.match(
    /^(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar)\s+(?:para|pra|de|que)\s+(.+?)\s+(?:em|daqui(?:\s+(?:a|uns?|umas?))?)\s+(.+?)[.!?]*$/iu
  );
  const request =
    input.match(
      /^(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar)\s+(?:em|daqui(?:\s+(?:a|uns?|umas?))?)\s+(.+?)\s+(?:para|pra|de|que)\s+(.+)$/iu
    ) ??
    input.match(
      /^(?:daqui(?:\s+(?:a|uns?|umas?))?|em)\s+(.+?)\s*,?\s+(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar)\s+(?:para|pra|de|que)\s+(.+)$/iu
    ) ??
    input.match(/^lembrete\s+(?:em|daqui(?:\s+(?:a|uns?|umas?))?)\s+(.+?)\s*[,;:]\s*(.+)$/iu) ??
    (suffix ? [suffix[0], suffix[2], suffix[1]] : null);
  if (!request) return null;

  const duration = request[1]!
    .trim()
    .replace(/(\d+)h([0-5]\d)(?!\w)/giu, '$1h $2min')
    .replace(/(\b(?:\d+|um|uma)\s*horas?)\s+e\s+meia$/iu, '$1 e 30 minutos');
  const title = request[2]!
    .trim()
    .replace(/[.!?]+$/, '')
    .trim();
  if (!title || title.length > 160 || !/\p{L}/u.test(title)) {
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

  if (
    /\b(?:as|às|pelas)\s+\d{1,2}\b|\b\d{1,2}(?:h(?:\d{2})?|:\d{2})\b/iu.test(title) ||
    /\b(?:todo dia|todos os dias|diariamente|semanalmente|mensalmente)\b/iu.test(title) ||
    (/\b(?:se|quando|assim que|caso)\b/iu.test(title) &&
      !/^(?:verificar|conferir|consultar|checar|ver)\s+se\b/iu.test(title))
  ) {
    return null;
  }

  const components = duration.matchAll(
    /([+-]?(?:\d[\d.,]*|um|uma|dois|duas|tr[êe]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte|trinta|meia))\s*(segundos?|segs?|s|minutos?|mins?|min|m|horas?|hrs?|hr|h|dias?|semanas?)(?=\s|,|$|\d)/giu
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
    const multiplier = unit.startsWith('sem')
      ? 604_800
      : unit.startsWith('d')
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
