/** A negated correction or example is not permission to mutate the ledger. */
export function isNonExecutableFinanceCorrection(text: string): boolean {
  const input = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (!/\b(?:gastos?|despesas?|lancamentos?|transacoes|financeiro)\b/.test(input)) return false;
  const correction =
    '(?:mude|muda|mudar|altere|altera|alterar|corrija|corrige|corrigir|troque|troca|trocar)';
  if (!new RegExp('\\b' + correction + '\\b').test(input)) return false;
  return (
    new RegExp('\\b(?:nao|nunca|jamais|nem)\\s+(?:me\\s+)?' + correction + '\\b').test(input) ||
    /\b(?:nao|sem)\s+(?:execute|executar|faca|fazer)\b/.test(input) ||
    /\b(?:se eu|se voce|caso eu|caso voce|talvez|exemplo|ficticio|hipotetico|simule)\b/.test(input)
  );
}

/** A financial lookup must never become a ledger mutation, regardless of the model. */
export function isGeneralReceivableQuery(text: string): boolean {
  const input = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/^(?:astra[,!:]?\s+)?(?:por favor[, ]*\s*)?/, '')
    .replace(/[?!.,]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return /^(?:quanto (?:eu )?(?:ainda )?tenho (?:a|para|pra) receber(?: no total)?|o que (?:eu )?tenho a receber|qual (?:e )?(?:o )?(?:meu )?saldo (?:total )?a receber|(?:mostre|liste|consulte|me diga|quero ver) (?:(?:os|meus|os meus) )?(?:recebiveis|valores (?:pendentes )?a receber|contas a receber)|meus (?:recebiveis|valores a receber)|minhas contas a receber)$/u.test(
    input
  );
}

export function isFinanceReadOnlyRequest(text: string): boolean {
  if (isGeneralReceivableQuery(text)) return true;
  const input = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/^(?:astra[,!:]?\s+)?(?:por favor[, ]*\s*)?(?:me\s+)?/, '');
  const reading =
    /^(?:(?:pode|poderia|consegue)\s+)?(?:mostr[ae]|mostrar|list[ae]|listar|consult[ae]|consultar|veja|ver|quero ver|qual|quais|quanto|resum[aoe]|resumir|extrato|meus? (?:gastos?|recebiveis|valores)|minhas? (?:despesas?|pendencias|contas)|tenho algum|o que (?:eu )?tenho a)\b/.test(
      input
    );
  const financial =
    /\b(?:gastos?|despesas?|lancamentos?|financeiro|financas|extrato|saldo|transacoes|entradas|saidas|pendencias|recebiveis|contas a (?:pagar|receber)|valores a (?:pagar|receber))\b/.test(
      input
    ) ||
    /^(?:quanto\s+(?:eu\s+)?(?:(?:ainda\s+)?tenho\s+(?:a|para|pra)\s+(?:pagar|receber)|gastei|paguei|recebi|entrou|ganhei)|o que (?:eu )?tenho a (?:pagar|receber))\b/.test(
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
