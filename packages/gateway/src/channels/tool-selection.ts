/** Small native tool set per intent; discovery remains available for everything else. */
export function channelToolsForMessage(text: string, previousText = ''): string[] {
  const input = `${text}\n${previousText.slice(-2500)}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const tools = new Set<string>();
  const add = (...names: string[]) => names.forEach((name) => tools.add(`core.${name}`));
  if (
    /\b(?:lembre|lembra|lembrete|lembretes|avise|avisar|aviso|alarme|reagend\w*|minutos?|codex)\b/.test(
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
    /\b(?:reais|recebi|receber|recebimento|entrada|entradas|saida|saidas|despesa|despesas|gastei|paguei|financeiro|saldo|valor|cakto|lancamento|lancamentos)\b|r\s*\$/.test(
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
