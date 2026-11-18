function normalized(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/^(?:astra[,!:]?\s+)?(?:por favor[, ]*\s*)?/, '')
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/gu, ' ');
}
/** A bulk request is never permission for repeated single-record tool calls. */
export function financeBulkIntent(
  text: string
): 'global' | 'context' | 'confirm' | 'cancel' | null {
  const input = normalized(text);
  if (
    /^(?:confirmo excluir os pendentes|confirmo remover os pendentes|sim|confirmo|pode (?:excluir|remover|apagar))$/u.test(
      input
    )
  )
    return 'confirm';
  if (/^(?:nao|cancele a exclusao|cancelar exclusao|desisti)$/u.test(input)) return 'cancel';
  if (
    /^(?:(?:quero|pode|poderia) )?(?:remov[ae]r?|exclu[ai]r?|apag(?:a|ue|ar)|delet[ae]r?) (?:todos|todas) (?:(?:os|as) )?(?:(?:meus|minhas) )?(?:entradas|receitas|recebimentos|saidas|despesas) (?:(?:que )?(?:estao|ficaram|estiverem) )?pendentes$/u.test(
      input
    )
  )
    return 'global';
  if (
    /^(?:(?:quero|pode|poderia) )?(?:remov[ae]r?|exclu[ai]r?|apag(?:a|ue|ar)|delet[ae]r?) (?:(?:todos|todas) )?(?:(?:os|as) )?(?:(?:meus|minhas) )?(?:lancamentos|registros|transacoes)(?: financeiros)? (?:(?:que )?(?:estao|ficaram|estiverem) )?pendentes$/u.test(
      input
    )
  )
    return 'global';
  if (
    /^(?:(?:quero|pode|poderia) )?(?:remov[ae]r?|exclu[ai]r?|apag(?:a|ue|ar)|delet[ae]r?) (?:(?:esses|essas|estes|estas|aqueles|aquelas|os|as)(?: (?:meus|minhas))? )?(?:(?:lancamentos|registros|transacoes|recebimentos|entradas|receitas|saidas|despesas|contas|valores) )?(?:pendentes|pendencias)$/u.test(
      input
    ) ||
    /^(?:(?:quero|pode|poderia) )?(?:remov[ae]r?|exclu[ai]r?|apag(?:a|ue|ar)|delet[ae]r?) (?:esses|essas|estes|estas|aqueles|aquelas)(?: (?:lancamentos|registros|transacoes|recebimentos|entradas|receitas|saidas|despesas|contas|valores))?$/u.test(
      input
    )
  )
    return 'context';
  if (
    /^(?:(?:quero|pode|poderia) )?(?:remov[ae]r?|exclu[ai]r?|apag(?:a|ue|ar)|delet[ae]r?) (?:todos|todas|tudo)(?: (?:os|as))?(?: (?:(?:que )?(?:esta|estao|ficaram|estiver|estiverem) )?pendentes?)?$/u.test(
      input
    ) ||
    /^(?:(?:quero|pode) )?(?:remov[ae]r?|exclu[ai]r?|apag(?:a|ue|ar)) (?:os )?pendentes$/u.test(
      input
    )
  )
    return 'context';
  return null;
}

/** An explicit type narrows a review; it never authorizes a deletion itself. */
export function financeBulkTransactionType(text: string): 'income' | 'expense' | undefined {
  const intent = financeBulkIntent(text);
  if (intent !== 'global' && intent !== 'context') return undefined;
  const input = normalized(text);
  if (/\b(?:entradas|receitas|recebimentos)\b/u.test(input)) return 'income';
  if (/\b(?:saidas|despesas)\b/u.test(input)) return 'expense';
  return undefined;
}

export function isBulkFinanceDeletionRequest(text: string): boolean {
  const intent = financeBulkIntent(text);
  const input = normalized(text);
  return (
    intent === 'global' ||
    intent === 'context' ||
    intent === 'confirm' ||
    // This deny guard deliberately accepts more language than the executable
    // parser. An unclear bulk request must never become individual tool calls.
    /\b(?:remov[ae]r?|exclu[ai]r?|apag(?:a|ue|ar)|delet[ae]r?|limp[ae]r?|zer[ae]r?)\b[^\n]*\b(?:todos|todas|tudo|em lote)\b/u.test(
      input
    ) ||
    /\b(?:delete|remove|erase|wipe)\b[^\n]*\b(?:all|every|in bulk)\b/u.test(input) ||
    /\b(?:remov[ae]r?|exclu[ai]r?|apag(?:a|ue|ar)|delet[ae]r?)\b[^\n]*\b(?:esses|essas|estes|estas|aqueles|aquelas|pendentes|pendencias|lancamentos|registros|transacoes|recebimentos)\b/u.test(
      input
    )
  );
}
