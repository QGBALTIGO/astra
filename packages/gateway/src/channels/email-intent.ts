const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Subject nouns outweigh ambiguous verbs such as "recebi" and "receber". */
export function hasChannelEmailSubject(text: string): boolean {
  return /\b(?:gmails?|gmais|e[-\u2010-\u2015\s]?mails?|inbox|caixa (?:de )?entrada)\b/u.test(
    fold(text)
  );
}

function hasExplicitFinanceInstruction(text: string): boolean {
  return fold(text)
    .split(/[.!?;]\s*|\s+(?:e|depois|tambem)\s+/u)
    .some((clause) => {
      const input = clause
        .trim()
        .replace(
          /^(?:astra[,!:]?\s+)?(?:por favor[, ]*\s*)?(?:(?:pode|poderia|consegue)\s+)?(?:me\s+)?/u,
          ''
        );
      return (
        /^(?:gastei|paguei|ganhei)\b/u.test(input) ||
        /^recebi\s+(?:r\$\s*\d|\d[\d.,]*\s*reais?\b)/u.test(input) ||
        /^quanto\s+(?:eu\s+)?(?:(?:ainda\s+)?tenho\s+(?:a|para|pra)\s+(?:pagar|receber)|gastei|paguei|recebi|ganhei)\b/u.test(
          input
        ) ||
        /^(?:mostr[ae]|list[ae]|consult[ae]|ver|quero ver|qual|quais|quanto)\s+(?:(?:o|a|os|as|meu|minha|meus|minhas|ultimo|ultima|ultimos|ultimas|total|dos|das|de)\s+)*(?:gastos?|despesas?|receitas?|entradas?|saidas?|parcelas?|saldo|transacoes|lancamentos?|recebiveis|contas a (?:pagar|receber))\b/u.test(
          input
        ) ||
        /^(?:(?:quero|preciso)\s+(?:que\s+voce\s+)?)?(?:registr[ae]|registrar|anot[ae]|anotar|atualiz[ae]|atualizar|corrij[ae]|corrigir|remov[ae]|remover|exclu[ai]|excluir|apag[ae]|apagar)\s+(?:(?:o|a|os|as|um|uma|meu|minha|meus|minhas|todos|todas)\s+)*(?:gastos?|despesas?|receitas?|entradas?|saidas?|parcelas?|saldo|transacoes|lancamentos?|recebiveis|r\$|\d[\d.,]*\s*reais?)/u.test(
          input
        )
      );
    });
}

/** Mail lookup/action without a separate explicit instruction to operate on the ledger. */
export function isChannelEmailRequest(text: string, previousText = ''): boolean {
  if (hasExplicitFinanceInstruction(text)) return false;
  if (hasChannelEmailSubject(text)) return true;
  // Only an elliptical received-message followup can inherit the mail subject.
  // Anchor the entire continuation: "último jogo" or "filmes recentes" introduces
  // a new subject even when an older reply happened to mention email.
  const input = fold(text).trim();
  return (
    hasChannelEmailSubject(previousText.slice(-500)) &&
    /^(?:e\s+)?(?:(?:me\s+)?(?:mostr[ae]|list[ae]|consult[ae]|quero ver|quais(?: sao)?|quantos(?: sao)?|qual(?: e)?)\s+)?(?:(?:so|apenas)\s+)?(?:(?:os|as|o|a|meus|minhas)\s+)?(?:\d{1,2}\s+)?(?:ultim[oa]s?|(?:mais )?recentes?|recebid[oa]s?|importantes?|nao lid[oa]s?)(?:\s+(?:recebid[oa]s?|importantes?|nao lid[oa]s?)){0,2}(?:\s+(?:que (?:eu )?recebi|que chegaram|hoje|ontem|de hoje|de ontem|desta semana|dessa semana))?[.!?]*$/u.test(
      input
    )
  );
}
