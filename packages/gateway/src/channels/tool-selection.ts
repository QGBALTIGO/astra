import { isAstraAccessAnswerRequested } from './astra-access.js';

/** Only clear, non-action opinion questions bypass financial tool discovery. */
export function isConversationalOnlyChannelQuestion(text: string): boolean {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!normalized.includes('?')) return false;
  if (
    /\b(?:registra|registre|registrar|anota|anote|anotar|salva|salve|salvar|agende|agenda|agendar|pague|paga|manda|mande|envia|envie|transferir|transfere|transfira|crie|cria|exclua|apague|cancele|altere|atualize)\b/.test(
      normalized
    ) ||
    /\b(?:quanto (?:gastei|paguei|recebi)|meus? gastos?|meu saldo|meus? lancamentos?)\b/.test(
      normalized
    )
  ) {
    return false;
  }
  return /\b(?:merece|mereceria|merecia|voce acha|acha que|qual sua opiniao|o que (?:voce )?acha|vale a pena|seria justo)\b/.test(
    normalized
  );
}

/** Ask the model to write or advise, never to execute a payment or write data. */
export function isConversationalOnlyChannelRequest(text: string): boolean {
  if (isAstraAccessAnswerRequested(text) || isConversationalOnlyChannelQuestion(text)) return true;
  const input = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^(?:astra[,!:]?\s+)?(?:por favor[, ]+\s*)?/, '');
  // A final explicit no-action boundary also covers commands quoted in an exercise.
  if (/\bso estamos conversando sobre esse exemplo[.!?]*$/.test(input)) return true;
  // Compound requests must go through the normal, verified action pipeline.
  if (
    /\be\s+(?:registr[ae]|anot[ae]|salv[ae]|agend[ae]|crie|canc[ae]le|exclua|pague|transfira)\b/.test(
      input
    )
  ) {
    return false;
  }
  // A calendar exercise and its explicitly hypothetical follow-up use the
  // conversation as their source. Do not give the model a real calendar.
  if (
    /\b(?:so estamos conversando sobre esse exemplo|so quero (?:uma orientacao|uma sugestao)|apenas orientacao|so analise|apenas analise)\b/.test(
      input
    )
  )
    return true;
  if (
    /\b(?:(?:exercicio|simulacao) de agenda|agenda (?:do|desse|deste) (?:exemplo|cenario|exercicio))\b/.test(
      input
    ) &&
    /\b(?:como (?:ficaria|seria)|(?:precisa|deveria) perguntar)\b/.test(input) &&
    input.endsWith('?') &&
    !/\b(?:agende|reagende|remarque|cancele|altere|registre|salve|crie|envie|pague|transfira)\b/.test(
      input
    )
  )
    return true;
  return (
    /^(?:pede|peca|fala|diz|diga)\s+(?:pro|pra|para(?:\s+(?:o|a))?|ao|a)\s+(?:(?:meu|minha|o|a)\s+)?(?:namorad[oa]|marido|esposa|mae|pai|amig[oa]|client[ea]|chefe|irma[oa])\b/.test(
      input
    ) ||
    /^(?:(?:pode|poderia|consegue)\s+)?(?:escrev(?:a|e|er)|redig(?:a|e|ir)|mont(?:a|e|ar)|cri(?:a|e|ar)|faz|faca|fazer|ger(?:a|e|ar))\s+(?:(?:uma|um)\s+)?(?:mensagem|texto|recado|pedido|convite|resposta)\b/.test(
      input
    ) ||
    /^(?:me ajuda|pode me ajudar|quero ajuda)\s+(?:a\s+)?(?:pedir|escrever|responder|falar|dizer)\b/.test(
      input
    ) ||
    /^(?:quero|preciso)\s+(?:mandar|enviar|escrever)\s+(?:uma\s+)?mensagem\b/.test(input)
  );
}

export const CHANNEL_CONVERSATIONAL_RETRY_PROMPT =
  'Releia o pedido original e o contexto. Responda em português à pergunta, ao exercício hipotético ou ao pedido de texto para copiar. Em exercícios, mantenha os dados do exemplo e descreva o resultado no condicional. Não use ferramentas, não alegue execução real nem mostre mensagens técnicas.';

/** Detect a generic assistant error or a misunderstanding of a chat request. */
export function needsConversationalRewrite(text: string): boolean {
  const input = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[*_~]/g, '')
    .toLowerCase()
    .trim();
  return /^(?:nao entendi bem o que voce quer|nao consegui confirmar (?:o pedido|a execucao)|ainda nao tenho uma alteracao confirmada)/.test(
    input
  );
}

/** Small native tool set per intent; discovery remains available for everything else. */
export function channelToolsForMessage(text: string, previousText = ''): string[] {
  if (isConversationalOnlyChannelRequest(text)) return [];
  const input = `${text}\n${previousText.slice(-2500)}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const tools = new Set<string>();
  const add = (...names: string[]) => names.forEach((name) => tools.add(`core.${name}`));
  if (
    /\b(?:google|gmail|drive|planilh\w*|todoist|notion|trello|conexo\w*|integra\w*|sincroniz\w*|e-?mails?)\b/.test(
      input
    )
  )
    add(
      'connected_apps_status',
      'search_connected_actions',
      'run_connected_action',
      'sync_connected_app'
    );
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
