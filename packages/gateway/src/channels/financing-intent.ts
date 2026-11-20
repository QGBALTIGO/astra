/** Pure financing request parsing shared by routing and tool write guards. */

export type ParsedFinancingIntent =
  | { kind: 'unconfirmed' }
  | { kind: 'create'; name: string; principalCents: number; openingCents: number }
  | { kind: 'query'; name: string }
  | { kind: 'payment'; name: string; amountCents: number };

export function normalizeFinancingText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

/** Parse explicit Brazilian currency: 72 mil, 72.000, 930, 470,50. */
export function parseBrlCents(raw: string, multiplier?: string, allowZero = false): number | null {
  // WhatsApp sentences often put a comma immediately after the amount.
  const compact = raw.replace(/\s/g, '').replace(/[.,]+$/g, '');
  let normalized: string;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(compact)) {
    normalized = compact.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+(?:,\d{1,2})?$/.test(compact)) {
    normalized = compact.replace(',', '.');
  } else if (/^\d+\.\d{1,2}$/.test(compact)) {
    normalized = compact;
  } else {
    return null;
  }
  const number = Number(normalized);
  const value = number * (multiplier && /^(?:mil|k)$/.test(multiplier) ? 1000 : 1);
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents >= (allowZero ? 0 : 1) && cents <= 9_000_000_000_000
    ? cents
    : null;
}

function safeName(name: string): string | null {
  const clean = name.replace(/\s+/g, ' ').trim();
  return /^[a-z0-9][a-z0-9 -]{1,59}$/.test(clean) ? clean : null;
}

export function parseFinancingIntent(input: string): ParsedFinancingIntent | null {
  const text = normalizeFinancingText(input);
  const prefix = /^(?:astra[,!:]?\s+)?(?:(?:registr[ae]|anot[ae])\s+que\s+)?$/u;

  // "O valor do carro é 72 mil, já foi pago 930, vai registrando..."
  // Requires BOTH the total and opening amount; never guesses missing data.
  const setup = text.match(
    /\bvalor\s+(?:total\s+)?(?:do|da)\s+([a-z0-9 -]{2,60}?)\s+(?:e|de|foi)\s+(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?\s*[,;]?\s*(?:ja\s+(?:foi\s+)?pago|ja\s+paguei|ja\s+pagamos|ja\s+(?:foi\s+)?quitado)\s*(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?/u
  );
  if (setup) {
    const before = text.slice(0, setup.index).replace(/\bo\s+$/u, '');
    const after = text.slice(setup.index! + setup[0].length).trim();
    if (
      !prefix.test(before) ||
      !/^(?:[,;]?\s*(?:acompanha(?: mensalmente)?|vai registrando(?: e dando baixa todo mes)?))?[.!]?$/u.test(
        after
      )
    ) {
      return { kind: 'unconfirmed' };
    }
    const name = safeName(setup[1] ?? '');
    const principalCents = parseBrlCents(setup[2] ?? '', setup[3]);
    const openingCents = parseBrlCents(setup[4] ?? '', setup[5], true);
    if (name && principalCents && openingCents !== null && openingCents <= principalCents) {
      return { kind: 'create', name, principalCents, openingCents };
    }
    // A recognizable but invalid debt request must not be misread as a payment.
    return { kind: 'unconfirmed' };
  }

  // "Quanto falta pagar do carro?" / "Saldo do carro?"
  const query = text.match(
    /\b(?:quanto\s+(?:falta|resta)\s+(?:pagar\s+)?(?:do|da)|saldo\s+(?:restante\s+)?(?:do|da)|quanto\s+(?:ja\s+)?paguei\s+(?:do|da))\s+([a-z0-9 -]{2,60}?)(?:[?!.]|$)/u
  );
  if (query) {
    const name = safeName(query[1] ?? '');
    if (name) return { kind: 'query', name };
  }

  // Only unambiguous, completed payments. A scheduled/expected installment
  // or "vou pagar" must never be automatically deducted.
  const paid = text.match(
    /\b(?:paguei|abati|dei\s+baixa\s+em)\s+(?:mais\s+)?(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?\s*(?:real|reais)?\s+(?:do|da)\s+([a-z0-9 -]{2,60})(?![a-z0-9 -])/u
  );
  if (paid) {
    const before = text.slice(0, paid.index).replace(/\beu\s+$/u, '');
    const after = text.slice(paid.index! + paid[0].length).trim();
    const amountCents = parseBrlCents(paid[1] ?? '', paid[2]);
    const name = safeName(paid[3] ?? '');
    // A payment clause inside a question, quotation, correction or compound
    // request does not authorize a ledger write, including through AI fallback.
    if (
      !prefix.test(before) ||
      !/^[.!]?$/u.test(after) ||
      /\b(?:nao|nunca|nem|mas|porem|se|talvez|acho|mentira|brincadeira|ou|e|amanha|ontem|hoje|agora|ja|total)\b/u.test(
        paid[3]!
      )
    ) {
      return { kind: 'unconfirmed' };
    }
    if (name && amountCents) return { kind: 'payment', name, amountCents };
  }
  return null;
}

export type FinancingPaymentAuthority =
  | { kind: 'none' | 'historical' | 'ambiguous' | 'correction' }
  | { kind: 'new_payment'; name: string; amountCents: number };

/**
 * A cumulative balance is not a new payment. In particular, "paguei 28 mil já"
 * does not say whether this is an accumulated total or another payment today.
 * This classifier only supplies write authority for a complete, single payment
 * in the customer's original message, never from tool arguments or old replies.
 */
export function classifyFinancingPaymentAuthority(input: string): FinancingPaymentAuthority {
  const text = normalizeFinancingText(input);
  if (!text) return { kind: 'none' };
  const parsed = parseFinancingIntent(text);
  const correction =
    /^(?:nao\s*[,;:]?\s+(?:do|da|era|e|esse|isso)\b|corrig[ea]\b|corrija\b|correcao\b|era\s+(?:do|da)\b|e\s+(?:do|da)\b|na verdade\b|na realidade\b|(?:isso|esse|essa)\s+(?:e|era)\b|me refiro\b|estou falando\b)/u.test(
      text
    );
  const historical =
    /\b(?:no total|ao todo|acumulad[oa]s?|ate agora|ate hoje|desde|ao longo|historico|valor total pago|total ja pago|total pago|total (?:que )?(?:ja )?paguei)\b/u.test(
      text
    );
  const financingContext =
    /\b(?:financiamento|parcelamento|parcela|parcelas|divida)\b/u.test(text) ||
    /\b(?:paguei|pagamos|pago|pagos|abati|pagar|debita|debite|abata|abate|baixe)\s+(?:(?:mais|ja|no total|ao todo|ate agora)\s+)*(?:r\$\s*)?\d[\d.,]*\s*(?:(?:mil|k|real|reais|ja|hoje|agora|no total|ao todo)\s*)*(?:do|da|no|na)\s+(?:(?:meu|minha|seu|sua)\s+)?(?:carro|moto|veiculo|automovel|casa|apartamento|imovel)\b/u.test(
      text
    ) ||
    ((correction || historical) &&
      /\b(?:do|da|no|na)\s+(?:(?:meu|minha|seu|sua)\s+)?(?:carro|moto|veiculo|automovel|casa|apartamento|imovel)\b/u.test(
        text
      ));
  if (!financingContext || parsed?.kind === 'query' || parsed?.kind === 'create') {
    return { kind: 'none' };
  }
  if (correction) {
    return { kind: 'correction' };
  }
  const paymentWords =
    /\b(?:paguei|pagamos|pago|pagos|pagamento|pagamentos|abati|baixa|debita|debite|acabei de pagar)\b/u.test(
      text
    );
  if (!paymentWords) return { kind: 'none' };
  if (historical) {
    return { kind: 'historical' };
  }
  const explicitNewPayment =
    /\b(?:hoje|agora|acabei de pagar|mais|novo pagamento|nova parcela)\b/u.test(text);
  if (/\bja\b/u.test(text) && !explicitNewPayment) return { kind: 'ambiguous' };
  if (parsed?.kind === 'payment') {
    return { kind: 'new_payment', name: parsed.name, amountCents: parsed.amountCents };
  }

  // An explicit date qualifier can establish a new payment; keep the grammar
  // anchored so a quote, future promise, correction or second action cannot.
  const currentPayment = text.match(
    /^(?:astra[,!:]?\s+)?(?:(?:registr[ae]|anot[ae])\s+que\s+)?(?:eu\s+)?(?:(?:ja|hoje|agora)\s+)?(?:paguei|acabei\s+de\s+pagar)\s+(?:mais\s+)?(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?\s*(?:real|reais)?\s*(?:(?:hoje|agora)\s+)?(?:do|da)\s+([a-z0-9 -]{2,60}?)(?:\s+(?:hoje|agora))?[.!]?$/u
  );
  if (currentPayment && explicitNewPayment) {
    const name = safeName(currentPayment[3] ?? '');
    const amountCents = parseBrlCents(currentPayment[1] ?? '', currentPayment[2]);
    if (
      name &&
      amountCents &&
      !/\b(?:nao|nunca|nem|mas|porem|se|talvez|acho|mentira|brincadeira|ou|e|amanha|ontem|hoje|agora)\b/u.test(
        name
      )
    ) {
      return { kind: 'new_payment', name, amountCents };
    }
  }
  return { kind: 'ambiguous' };
}
