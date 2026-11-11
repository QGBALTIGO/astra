/** Small native tool set per intent; discovery remains available for everything else. */
export function channelToolsForMessage(text: string, previousText = ''): string[] {
  const input = `${text}\n${previousText.slice(-2500)}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const tools = new Set<string>();
  const add = (...names: string[]) => names.forEach((name) => tools.add(`core.${name}`));
  // "Receita" means both income and a cooking recipe in Portuguese. Keep
  // cooking requests out of financial tool selection.
  const mentionsFinancialIncome =
    /\breceitas?\b/.test(input) &&
    !/\b(?:culinari\w*|ingredientes?|cozinhar|preparar|bolo|bolos|frango|arroz|jantar|almoco|sobremesa|sobremesas|chocolate|pudim|pao|paes)\b/.test(
      input
    );
  if (
    /\b(?:lembre|lembra|lembrete|lembretes|avise|avisar|aviso|alarme|reagend\w*|segundos?|minutos?|codex)\b/.test(
      input
    )
  ) {
    add(
      'schedule_channel_reminder',
      'list_channel_reminders',
      'reschedule_channel_reminder',
      'cancel_channel_reminder'
    );
  }
  if (
    mentionsFinancialIncome ||
    /\b(?:reais|recebi|receber|recebimentos?|ganhei|ganhar|salarios?|entrada|entradas|saida|saidas|despesa|despesas|gastei|gastar|gastos?|paguei|pagar|pagamentos?|financeiro|saldo|valor|cakto|lancamento|lancamentos|faturas?)\b|\b\d[\d.,]*\s*real\b|r\s*\$/.test(
      input
    )
  ) {
    add(
      'record_transaction',
      'list_transactions',
      'update_transaction',
      'delete_transaction',
      'financial_summary'
    );
  }
  // Goals exist in the OwnPilot tool registry but were not surfaced for normal
  // Portuguese requests. Do not confuse generic "guardar" (remember/save a
  // note) with saving money: require an explicit goal/savings/debt term.
  if (
    /\b(?:metas?|objetivos?|economiz(?:ar|ando)|poup(?:ar|ando)|junt(?:ar|ando)|financiamentos?|quitar|quitacao|contribuicao|contribuicoes)\b/.test(
      input
    ) ||
    /\bguardar\s+(?:r\$|\d|dinheiro)\b/.test(input)
  ) {
    add('create_goal', 'list_goals', 'update_goal', 'get_goal_details', 'get_goal_stats');
  }
  if (/\b(?:tarefa|tarefas|afazer|afazeres)\b/.test(input)) add('add_task', 'list_tasks');
  if (/\b(?:consulta|dentista|reuniao|compromisso|calendario|agenda)\b/.test(input))
    add('add_calendar_event', 'list_calendar_events');
  if (/\b(?:nome|memoria|memorize|guarde|preferencia|lembra)\b/.test(input))
    add('create_memory', 'search_memories');
  return [...tools];
}

export function recentChannelText(conversation: {
  messages?: readonly { content: unknown }[];
}): string {
  return (conversation.messages ?? [])
    .slice(-3)
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
    .slice(-2500);
}
