import { isAstraAccessAnswerRequested } from './astra-access.js';
import { astraCommercialIntent } from './astra-commercial.js';
import { hasChannelEmailSubject, isChannelEmailRequest } from './email-intent.js';
import { isFinanceReadOnlyRequest, isNonExecutableFinanceCorrection } from './finance-intent.js';
import { hasExplicitReminderTime, isConditionalNotificationRequest } from './reminder-request.js';

/** Read saved subscription facts rather than searching payment transactions. */
export function requiredChannelSubscriptionTool(text: string): string | undefined {
  if (isChannelEmailRequest(text) || isConversationalOnlyChannelRequest(text)) return undefined;
  const input = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (
    !/\bassinaturas?\b/.test(input) ||
    /\b(?:astra|google|gmail|e-?mail|exemplo|hipotetico|simulacao|temperatura|clima|lembretes?|gastos?|gastei|paguei|pagamentos?|despesas?|lancamentos?|transacoes)\b/.test(
      input
    ) ||
    /\b(?:cadastr\w*|assin(?:ar|e)|registr\w*|anot\w*|adicion\w*|atualiz\w*|alter\w*|corrig\w*|corrij\w*|remov\w*|exclu\w*|apag\w*|cancel\w*|agend\w*|lembr\w*|avise|avisar|crie|criar|mude|mudar)\b/.test(
      input
    )
  )
    return undefined;
  return /\b(?:qual|quais|quanto|quando|valor|preco|renova|vence|minhas|tenho|liste|lista|listar|mostre|mostra|ver|consulte)\b/.test(
    input
  )
    ? 'core.list_customer_subscriptions'
    : undefined;
}

export function requiredChannelEmailDigestTool(
  text: string,
  previousText = ''
): string | undefined {
  if (isConversationalOnlyChannelRequest(text)) return undefined;
  const input = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (
    /\b(?:nao (?:ative|agende|programe|crie)|so explique|apenas explique|exemplo|hipotetico)\b/.test(
      input
    )
  )
    return undefined;
  const dailyEmail =
    hasChannelEmailSubject(input) &&
    /\bresumo\b/.test(input) &&
    /\b(?:diario|diariamente|todo dia|todos os dias|toda manha)\b/.test(input);
  const timeAnswer =
    hasChannelEmailSubject(previousText.slice(-500)) &&
    /em qual horário você quer receber o resumo/i.test(previousText.slice(-500)) &&
    /^\s*(?:[aà]s?\s*)?\d{1,2}(?:(?:h|:)\d{0,2})?\s*(?:horas?)?[.!]?\s*$/i.test(text);
  return dailyEmail || timeAnswer ? 'core.manage_email_digest' : undefined;
}

export function requiredChannelRadarTool(text: string, previousText = ''): string | undefined {
  if (isConversationalOnlyChannelRequest(text)) return undefined;
  const input = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (/\b(?:gastei|paguei|recebi|lancamento|assinatura)\b/.test(input)) return undefined;
  const direct =
    /\b(?:radar|noticias|manchetes|brasileirao|futebol)\b/.test(input) &&
    !/\b(?:gastei|paguei|recebi|lancamento|assinatura)\b/.test(input);
  const team =
    /\b(?:meu time|me avise quando.{0,35}jogar|acompanhe.{0,30}(?:flamengo|palmeiras|corinthians|vasco))\b/.test(
      input
    );
  const footballQuery =
    /\b(?:jog[oa]s?|jogar|partidas?|calendario|tabela|resultados?|placar)\b/.test(input) &&
    /\b(?:flamengo|palmeiras|corinthians|vasco|santos|sao paulo|spfc|gremio|internacional|botafogo|fluminense|cruzeiro|atletico|athletico|bahia|bragantino|chapecoense|coritiba|mirassol|remo|vitoria)\b/.test(
      input
    );
  const recurringWeather =
    /\b(?:clima|temperatura|previsao)\b/.test(input) &&
    /\b(?:todo dia|todos os dias|diariamente|diario)\b/.test(input) &&
    /\b(?:mande|envie|receber|acompanhe|quero)\b/.test(input);
  const followup =
    /\bradar\b/i.test(previousText.slice(-500)) &&
    /^\s*(?:(?:as?|[àa]s?)\s+)?(?:\d{1,2}(?:(?:h|:)\d{0,2})?|[\p{L}\p{M}\s,.'()–-]{2,70})[.!?]?\s*$/u.test(
      text
    ) &&
    !/\b(?:oi|ola|qual|quais|como|quando|quanto|temperatura|clima|reais|gastei|gastos?|paguei|recebi|lembre|lembretes?|assinaturas?|cancelar tudo|bom dia|boa tarde|boa noite|obrigad\w*)\b/.test(
      input
    );
  return direct || team || footballQuery || recurringWeather || followup
    ? 'core.manage_radar'
    : undefined;
}

export function requiredChannelWeatherTool(text: string, previousText = ''): string | undefined {
  if (isConversationalOnlyChannelRequest(text)) return undefined;
  if (requiredChannelRadarTool(text, previousText)) return undefined;
  const clean = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  const input = clean(text),
    previous = clean(previousText);
  if (
    /\b(?:forno|assar|fritar|febre|corporal|termometro|geladeira|freezer|ferver|ebulicao|agua|feijao|arroz|bolo|oleo)\b/.test(
      input
    )
  )
    return undefined;
  const weather =
    /\b(?:temperatura|tempretura|tempratura|temperature|clima|previsao|chover|chuva)\b|\b(?:como (?:esta|ta) o tempo|tempo (?:agora|hoje|aqui|em))\b/.test(
      input
    );
  const cityPreference =
    !/\bnao\s+(?:guarde|salve|memorize|(?:mude|altere)\s+(?:a\s+|minha\s+)?cidade)\b/.test(input) &&
    /\b(?:guarde|salve|memorize|moro em|morando em|minha cidade (?:e|agora e)|(?:pode|quero|preciso) (?:guardar|salvar))\b/.test(
      input
    ) &&
    /\b(?:cidade|tempo|clima|temperatura|moro|morando)\b/.test(input);
  if (cityPreference) return 'core.set_weather_city';
  const cityAnswer =
    /\b(?:qual cidade|em qual cidade|cidade e (?:o )?estado)\b/.test(previous.slice(-500)) &&
    /^[\p{L}\p{M}\s,.'()–-]{2,100}$/u.test(text.trim()) &&
    !/\b(?:nao|cancelar|oi|sim|obrigad\w*)\b/.test(input);
  if (cityAnswer && !weather) return 'core.set_weather_city';
  return weather ? 'core.get_local_weather' : undefined;
}

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

/** Cooking advice is conversation, even after a financial thread used "receita" as income. */
export function isCulinaryChannelAdvice(text: string): boolean {
  if (hasChannelEmailSubject(text)) return false;
  const input = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (
    /\b(?:registr[ae]|anot[ae]|salv[ae]|agend[ae]|lembre|avis[ae]|cancele|exclua|apag[ae]|pague|transfira|corrija|atualize|altere)\b/u.test(
      input
    ) ||
    /\b(?:quanto (?:gastei|paguei|recebi)|meus? gastos?|meu saldo|meus? lancamentos?|minhas despesas)\b/u.test(
      input
    )
  )
    return false;
  return (
    /\b(?:frango|feijao|arroz|carne|macarrao|ovo|ovos|bolo|pao|pudim|sopa|legumes|batata|peixe|cozinhar|frigideira|cozimento)\b/u.test(
      input
    ) &&
    /\b(?:receitas?|dicas?|como (?:faco|fazer|preparo|preparar|cozinho|cozinhar)|tempero|cozimento|frigideira|macio)\b/u.test(
      input
    )
  );
}

/** Ask the model to write or advise, never to execute a payment or write data. */
export function isConversationalOnlyChannelRequest(text: string): boolean {
  if (
    astraCommercialIntent(text) ||
    isAstraAccessAnswerRequested(text) ||
    isConversationalOnlyChannelQuestion(text)
  )
    return true;
  if (isCulinaryChannelAdvice(text)) return true;
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
  if (isNonExecutableFinanceCorrection(text)) return true;
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

/** Generic linked-account requests need the same schemas as a named application. */
function hasConnectedAppSubject(input: string): boolean {
  return (
    /\b(?:google|gmail|drive|planilh\w*|todoist|notion|trello|conexo\w*|integra\w*|sincroniz\w*|e-?mails?)\b/.test(
      input
    ) ||
    (/\b(?:apps?|aplicativos?|contas?|servicos?)\b/.test(input) &&
      /\b(?:conectad[oa]s?|conectei|vinculad[oa]s?|vinculei)\b/.test(input))
  );
}

/**
 * A simple reminder's subject (pagar, enviar e-mail, consulta, etc.) is not an
 * instruction to execute that action now. Expose only the relevant schema.
 * Compound, contextual, conditional and recurring requests keep normal routing.
 */
function isSingleClockReminder(text: string): boolean {
  const input = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  if (
    !/^(?:astra[,!]?\s+)?(?:por favor[, ]+)?(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)(?:-me)?|pode\s+me\s+lembrar|lembrete)\b/u.test(
      input
    ) ||
    !hasExplicitReminderTime(text) ||
    isConditionalNotificationRequest(text) ||
    /["“”«»;\n?]|\b(?:mas|ou|se|quando|caso|todo dia|todos os dias|diariamente|semanalmente|mensalmente|a cada|exemplo|hipotetico|nao agende|nao quero)\b/u.test(
      input
    ) ||
    /\be\s+(?:tambem\s+)?(?:(?:me\s+)?(?:lembre|lembra|avise|avisa)|registr[ae]|anot[ae]|salv[ae]|agend[ae]|crie|canc[ae]le|exclua|apague|pague|transfira|envie|mande|mostre|liste|consulte)\b/u.test(
      input
    )
  )
    return false;
  return true;
}

/** Small native tool set per intent; discovery remains available for everything else. */
export function channelToolsForMessage(text: string, previousText = ''): string[] {
  if (isConversationalOnlyChannelRequest(text)) return [];
  if (isSingleClockReminder(text)) return ['core.schedule_channel_reminder'];
  // Explicit current subjects choose their own schemas. Old email/finance
  // replies must not attach unrelated action schemas to a new weather request.
  // Elliptical follow-ups still use recent conversation for intent resolution.
  const current = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const emailRequest = isChannelEmailRequest(text, previousText);
  const explicitSubject =
    hasChannelEmailSubject(text) ||
    hasConnectedAppSubject(current) ||
    /\b(?:assinaturas?|mensalidades?|temperatura|clima|chuva|previsao|cidade|moro|lembre\w*|avis\w*|alarme|reagend\w*|financeiro|financas|reais|recebi|receber|ganhei|gastei|gastos?|paguei|pagamentos?|saldo|lancamentos?|faturas?|metas?|objetivos?|financiamentos?|tarefas?|afazeres?|dentista|reuniao|compromisso|calendario|agenda|memoria|memorize|radar|noticias?|jogos?|futebol)\b|r\s*\$/u.test(
      current
    );
  const input = (explicitSubject ? text : `${text}\n${previousText.slice(-2500)}`)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const tools = new Set<string>();
  const add = (...names: string[]) => names.forEach((name) => tools.add(`core.${name}`));
  if (requiredChannelRadarTool(text, previousText)) add('manage_radar');
  if (/\bassinaturas?\b/.test(input)) add('list_customer_subscriptions');
  // A subscription lookup needs current planning facts, not the preceding
  // expense's mutation tools. The AI still resolves the reference and writes the reply.
  if (requiredChannelSubscriptionTool(text)) return ['core.list_customer_subscriptions'];
  if (requiredChannelWeatherTool(text, previousText)) add('get_local_weather', 'set_weather_city');
  if (
    /\b(?:temperatura|clima|calor|frio|chuva|chover|previsao|weather|cidade|moro|morando)\b/.test(
      input
    ) ||
    /\b(?:como (?:esta|ta|vai) o tempo|tempo (?:agora|hoje|amanha|aqui|em))\b/.test(input)
  )
    add('get_local_weather', 'set_weather_city');
  // A new subject must not inherit mail tools just because an older response
  // mentioned Gmail. Explicit mail continuations and digest time answers retain them.
  const integrationInput = hasChannelEmailSubject(previousText) && !emailRequest ? current : input;
  if (
    emailRequest ||
    hasChannelEmailSubject(text) ||
    requiredChannelEmailDigestTool(text, previousText) ||
    hasConnectedAppSubject(integrationInput)
  )
    add(
      'connected_apps_status',
      'manage_email_digest',
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
    !emailRequest &&
    (mentionsFinancialIncome ||
      /\b(?:reais|recebi|receber|recebimentos?|ganhei|ganhar|salarios?|entrada|entradas|saida|saidas|despesa|despesas|gastei|gastar|gastos?|paguei|pagar|pagamentos?|financeiro|saldo|valor|cakto|lancamento|lancamentos|faturas?)\b|\b\d[\d.,]*\s*real\b|r\s*\$/.test(
        input
      ))
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
    !emailRequest &&
    (/\b(?:metas?|objetivos?|economiz(?:ar|ando)|poup(?:ar|ando)|junt(?:ar|ando)|financiamentos?|quitar|quitacao|contribuicao|contribuicoes)\b/.test(
      input
    ) ||
      /\bguardar\s+(?:r\$|\d|dinheiro)\b/.test(input))
  ) {
    add('create_goal', 'list_goals', 'update_goal', 'get_goal_details', 'get_goal_stats');
    add('list_customer_planning');
  }
  if (!emailRequest && /\b(?:orcamentos?|parcelas?|planejamento)\b/.test(input))
    add('list_customer_planning');
  if (/\b(?:tarefa|tarefas|afazer|afazeres)\b/.test(input)) add('add_task', 'list_tasks');
  if (/\b(?:consulta|dentista|reuniao|compromisso|calendario|agenda)\b/.test(input))
    add('add_calendar_event', 'list_calendar_events');
  if (/\b(?:nome|memoria|memorize|guarde|preferencia|lembra)\b/.test(input))
    add('create_memory', 'search_memories');
  if (isFinanceReadOnlyRequest(text))
    for (const name of [
      'record_transaction',
      'update_transaction',
      'delete_transaction',
      'add_expense',
      'batch_add_expenses',
      'update_expense',
      'delete_expense',
    ])
      tools.delete('core.' + name);
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
