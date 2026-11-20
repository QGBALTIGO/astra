import { createHash } from 'node:crypto';

export interface ChannelFinanceCreateScope {
  userId: string;
  channelPluginId: string;
  platformChatId: string;
  channelMessageId: string;
  /** The authenticated incoming text, never a model-generated description. */
  requestText?: string;
}

type CreationIdentity = { ok: true; key: string } | { ok: false; message: string };

interface RequestedItem {
  cents: number;
  words: ReadonlySet<string>;
}

const NON_ITEM_WORDS = new Set(
  'a o as os um uma uns umas de do da dos das no na nos nas em com por para pra e eu meu meus minha minhas astra anote anota registre registra registrar anotar que gastei paguei recebi ganhei gasto gastos despesa despesas entrada entradas saida saidas lancamento lancamentos transacao transacoes estes essas esses estas seguintes reais real mil r hoje'.split(
    ' '
  )
);

function words(text: string): ReadonlySet<string> {
  return new Set(
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLocaleLowerCase('pt-BR')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1 && !/^\d+$/u.test(word) && !NON_ITEM_WORDS.has(word))
  );
}

function cents(amount: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const value = Math.round(amount * 100);
  return Number.isSafeInteger(value) && Math.abs(amount * 100 - value) < 1e-6 ? value : null;
}

function monetaryValue(raw: string, multiplier?: string): number | null {
  if (!/^(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[,.]\d{1,2})?)$/u.test(raw)) {
    return null;
  }
  const grouped = /^\d{1,3}(?:\.\d{3})+/u.test(raw);
  const amount = Number((grouped ? raw.replace(/\./gu, '') : raw).replace(',', '.'));
  return cents(amount * (multiplier ? 1_000 : 1));
}

/** Deliberately narrow: a list item must contain one amount and an item label. */
function requestedItem(clause: string): RequestedItem | null {
  const explicit = [
    ...clause.matchAll(
      /r\$\s*(\d[\d.,]*)(?:\s*(mil|k)\b)?|(\d[\d.,]*)\s*(mil|k)?\s*(?:real|reais)\b/giu
    ),
  ];
  let value: number | null;
  let label: string;
  if (explicit.length === 1) {
    const match = explicit[0]!;
    value = monetaryValue(match[1] ?? match[3]!, match[2] ?? match[4]);
    label = clause.slice(0, match.index) + ' ' + clause.slice(match.index! + match[0].length);
    // Dates, quantities, or a second unlabelled amount need a clearer item list.
    if (/\d/u.test(label)) return null;
  } else if (explicit.length === 0) {
    const bare =
      /^(?:(?:eu\s+)?(?:gastei|paguei|recebi|ganhei)\s+)?(\d[\d.,]*)(?:\s*(mil|k)\b)?\s+(?:com|de|do|da|no|na|em)\s+([^\d]+)$/iu.exec(
        clause.trim()
      );
    if (!bare) return null;
    value = monetaryValue(bare[1]!, bare[2]);
    label = bare[3]!;
  } else {
    return null;
  }
  const labelWords = words(label);
  return value !== null && labelWords.size > 0 ? { cents: value, words: labelWords } : null;
}

/**
 * A model cannot create another item by renaming a retry. Most messages have a
 * single stable slot. Extra slots come only from a complete, explicit list in
 * the original message, and matching never depends on tool execution order.
 * This determines identity, not permission to perform a financial operation.
 */
export function channelFinanceCreateIdentity(
  scope: ChannelFinanceCreateScope,
  item: { amount: number; description: string }
): CreationIdentity {
  if (
    !scope.userId.trim() ||
    !scope.channelPluginId.trim() ||
    !scope.platformChatId.trim() ||
    !scope.channelMessageId.trim()
  ) {
    return { ok: false, message: 'Registro exige uma mensagem autenticada no canal.' };
  }

  let slot = 0;
  const clauses = (scope.requestText ?? '')
    .split(/\s*(?:[;\r\n]+|\s+e\s+)\s*/iu)
    .map((clause) => clause.replace(/^\s*[-•]\s*/u, '').trim())
    .filter(Boolean);
  if (clauses.length > 1 && clauses.length <= 20) {
    const requested = clauses.map(requestedItem);
    if (requested.every((entry) => entry !== null)) {
      const amount = cents(item.amount);
      const label = words(item.description);
      const matches = requested
        .map((entry, index) => ({ entry, index }))
        .filter(
          ({ entry }) => entry.cents === amount && [...entry.words].some((word) => label.has(word))
        );
      if (matches.length !== 1) {
        return {
          ok: false,
          message:
            'Não consegui identificar um único item dessa lista para registrar. Envie cada lançamento separadamente, com valor e descrição.',
        };
      }
      slot = matches[0]!.index;
    }
  }

  return {
    ok: true,
    key: createHash('sha256')
      .update(
        JSON.stringify([
          'channel-finance-create-v1',
          scope.userId,
          scope.channelPluginId,
          scope.platformChatId,
          scope.channelMessageId,
          slot,
        ])
      )
      .digest('hex'),
  };
}
