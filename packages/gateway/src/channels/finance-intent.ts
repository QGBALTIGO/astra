/** A financial lookup must never become a ledger mutation, regardless of the model. */
export function isFinanceReadOnlyRequest(text: string): boolean {
  const input = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/^(?:astra[,!:]?\s+)?(?:por favor[, ]*\s*)?(?:me\s+)?/, '');
  const reading =
    /^(?:(?:pode|poderia|consegue)\s+)?(?:mostr[ae]|mostrar|list[ae]|listar|consult[ae]|consultar|veja|ver|quero ver|qual|quais|quanto|resum[aoe]|resumir|extrato|meus? gastos?|minhas? despesas?|tenho algum|o que tenho a)\b/.test(
      input
    );
  const financial =
    /\b(?:gastos?|despesas?|lancamentos?|financeiro|financas|extrato|saldo|transacoes|entradas|saidas|pendencias)\b/.test(
      input
    ) ||
    /^(?:quanto\s+(?:eu\s+)?(?:gastei|paguei|recebi|entrou|ganhei)|o que tenho a (?:pagar|receber))\b/.test(
      input
    );
  if (!reading || !financial) return false;
  const positive = input.replace(
    /\b(?:nao|sem)\s+(?:me\s+)?(?:mudar|mude|altere|alterar|registre|registrar|anote|anotar|atualize|atualizar|exclua|excluir|apague|apagar|remova|remover)\b/g,
    ''
  );
  return !/\b(?:e|depois|tambem|quero|pode)\s+(?:me\s+)?(?:anot[ae]|anotar|registr[ae]|registrar|cri[ae]|criar|corrij[ae]|corrig[ae]|corrigir|mud[ae]|mudar|alter[ae]|alterar|atualiz[ae]|atualizar|exclu[ai]|excluir|apag[ae]|apagar|remov[ae]|remover|troqu[ae]|trocar)\b/.test(
    positive
  );
}

export function requiredFinanceReadTool(text: string): string | undefined {
  if (
    !isFinanceReadOnlyRequest(text) ||
    /\b(?:google|gmail|drive|planilha|notion|todoist|trello|e-?mail|exemplo|ficticio|simulacao|hipotetico)\b/iu.test(
      text.normalize('NFD').replace(/\p{M}/gu, '')
    )
  )
    return undefined;
  return 'core.list_transactions';
}
