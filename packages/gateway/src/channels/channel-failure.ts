import { getLog } from '../services/log.js';
import { currentAstraLinksInText } from '../config/astra-public-urls.js';
import { ASTRA_ACCESS_REPLY, isAstraAccessAnswerRequested } from './astra-access.js';
import { channelOperations } from './receipt-state.js';
import {
  CHANNEL_UNVERIFIED_REPLY,
  verifiedWriteDetails,
  type ChannelToolReceipt,
} from './response-safety.js';
import { isConversationalOnlyChannelRequest } from './tool-selection.js';

/** Technical categories stay in diagnostics. Never copy the provider body into a channel reply. */
export function channelFailureKind(details: string) {
  if (/agent is already processing a request/i.test(details)) return 'agent_busy';
  if (
    /(?:api|stream) error:\s*429\b|\bhttp\s*429\b|\brate.?limit(?:ed| reached| exceeded)|tokens per minute|too many requests/i.test(
      details
    )
  )
    return 'rate_limited';
  if (
    /circuit(?:\s*breaker)?(?:\s+is)?\s+open|all providers (?:failed|unavailable)|no (?:usable|available) providers/i.test(
      details
    )
  )
    return 'provider_unavailable';
  if (/\b(?:time(?:d\s+out|out)|etimedout|deadline exceeded|aborterror)\b/i.test(details))
    return 'timeout';
  if (
    /api.?key|unauthorized|no.{0,12}provider.{0,12}configured|\b(?:http|error:)\s*401\b/i.test(
      details
    )
  )
    return 'provider_configuration';
  return 'agent_error';
}

type Failure = ReturnType<typeof channelFailureKind>;
const guidance = {
  calendar: {
    check: 'Você pode conferir o compromisso em Agenda no painel.',
    read: 'Sua agenda não abriu por aqui agora. Dá uma olhada em Agenda no painel para conferir os horários.',
    write:
      'Fiquei sem a confirmação desse compromisso. Antes de pedir outra alteração, veja em Agenda no painel se a mudança já aparece.',
  },
  reminder: {
    check: 'Para conferir o aviso e o horário, abra Agenda no painel.',
    read: 'A lista de avisos não abriu agora. Dá uma olhada em Agenda no painel. Se quiser consultar por aqui depois, pergunte “Quais são meus lembretes de hoje?”',
    write:
      'A confirmação do aviso não chegou. Confira o horário e o status em Agenda no painel antes de criar outro.',
  },
  task: {
    check: 'Para conferir como a tarefa está, mande “Consulte a tarefa” com o título.',
    read: 'Estou sem a lista de tarefas por aqui. Você também encontra seus itens em Agenda no painel.',
    write:
      'Fiquei sem a confirmação da tarefa. Para ver como ela ficou, mande “Consulte a tarefa” seguido do título.',
  },
  subscription: {
    check: 'Para conferir o que está no seu controle, mande “Minhas assinaturas”.',
    read: 'Os dados da assinatura não carregaram agora. No painel, abra Meu planejamento e escolha Assinaturas. Por aqui, use “Minhas assinaturas”.',
    write:
      'A confirmação da assinatura não chegou. Mande “Minhas assinaturas” para conferir se a mudança já aparece.',
  },
  finance: {
    check: 'Dá para conferir o lançamento em Transações no painel.',
    read: 'Fiquei sem os dados dos seus lançamentos. Para conferir os valores agora, abra Transações no painel.',
    write:
      'A confirmação do lançamento não chegou. Confira em Transações no painel antes de anotar de novo, para não contar duas vezes.',
  },
} as const;
/** The deterministic lookup already knows its intent; keep its error details out of the reply. */
export function channelDataFailure(
  domain: keyof typeof guidance,
  operation: 'read' | 'write',
  cause: unknown
): string {
  const reason = channelFailureKind(
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  );
  getLog('ChannelData').warn('Channel operation unavailable', { domain, operation, reason });
  return guidance[domain][operation];
}
const domains = [
  { name: 'subscription', words: /\b(?:assinaturas?|mensalidades?|renovacao)\b/ },
  {
    name: 'reminder',
    words:
      /\b(?:lembretes?|lembrar|lembre|lembra|avisos?|avis[ae]r?|(?:da|dar|de) (?:um|aquele) toque)\b/,
  },
  { name: 'task', words: /\b(?:tarefas?|afazeres?)\b/ },
  {
    name: 'calendar',
    words:
      /\b(?:agenda|eventos?|compromissos?|reuniao|reunioes|videochamada|calendario|dentista|(?:minha|uma|essa|a) consulta)\b/,
  },
  {
    name: 'finance',
    words:
      /\b(?:financeiro|financas|gastos?|gastei|paguei|recebi|receitas?|despesas?|cartao|saldo|parcelas?|pagamentos?|lancamentos?|transacoes|dinheiro|reais)\b|r\$/,
  },
] as const;
function classifyRequest(text: string) {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  // “Se não encontrar, me avisa” requests a reply about the preceding operation.
  // A scheduled notice (e.g. “me avisa amanhã”) retains its own reminder intent.
  const s = normalized.replace(
    /(?:[.,;!?]\s*|\s+e\s+)(?:se nao (?:encontrar|achar|localizar)\s*,?\s*(?:so )?me avis[ae]|me avis[ae] se nao (?:encontrar|achar|localizar))(?:,? por favor)?[.!?]*$/u,
    ''
  );
  // A question mark alone does not identify a read: "Pode corrigir o lançamento?" is a request.
  const capabilityWords =
    /\b(?:como (?:isso )?funciona|quero (?:entender|aprender)|(?:so|apenas) (?:uma? )?duvida|(?:so |apenas )?quero saber se voce (?:faz|pode|consegue)|se eu pedir|estou perguntando|basta eu|preciso (?:pedir|criar)|explic[ae] (?:a diferenca|como))\b/;
  const capability =
    capabilityWords.test(s) ||
    (/\b(?:aprendendo a usar|consigo (?:pedir|usar)|automaticamente|sozinh[oa]s?)\b/.test(s) &&
      s.includes('?')) ||
    /\bou (?:so acompanha|precisa ser|preciso abrir|(?:eu )?(?:tenho|preciso) (?:de |que )?\w+)\b/.test(
      s
    );
  const lookupOnly =
    /\b(?:(?:so|apenas) (?:me diga|consulta)|quero (?:saber|ver)|(?:que )?eu mesm[oa] (?:marco|agendo)|explic[ae] (?:a diferenca|como))\b/.test(
      s
    );
  // Test each instruction in its own clause so "não apague; mude o horário" retains the write.
  const instructions = s.split(/[,.!?;:]\s*|\s+(?:e|mas)\s+/);
  const write =
    instructions.some((clause, index) => {
      const instruction = clause
        .trim()
        .replace(/^(?:(?:e|mas)\s+)?(?:astra\s+|por favor\s+|a partir de (?:hoje|agora)\s+)?/, '');
      const modal = /^(?:voce\s+)?(?:pode|poderia|consegue)\s+/.test(instruction);
      if (
        modal &&
        capability &&
        (capabilityWords.test(clause) ||
          /\bou (?:so acompanha|precisa ser|preciso abrir)\b/.test(clause) ||
          capabilityWords.test(instructions[index + 1] ?? '') ||
          /\bse eu pedir\b/.test(instructions[index - 1] ?? ''))
      )
        return false;
      const verb = instruction
        .replace(
          /^(?:(?:voce\s+)?(?:pode|poderia|consegue)\s+|(?:quero|preciso)\s+que\s+(?:voce\s+)?)/,
          ''
        )
        .replace(/^me\s+/, '');
      return /^(?:agend(?:e|ar)|agenda(?=\s+(?:um|uma|o|a|na|no|minha|meu|para|pra)\b)|marc(?:a|ar)|marque|remarc(?:a|ar)|remarque|reagend(?:a|e|ar)|cr(?:ia|ie|iar)|lemb(?:ra|re|rar)|avis(?:a|e|ar)|(?:da|de|dar) (?:um|aquele) toque|regist(?:ra|re|rar)|anot(?:a|e|ar)|lanc(?:a|ar)|lance|salv(?:a|e|ar)|exclu(?:a|ir)|apag(?:a|ue|ar)|remov(?:a|er)|cancel(?:a|e|ar)|atualiz(?:a|e|ar)|alter(?:a|e|ar)|conclu(?:a|ir)|cadast(?:ra|re|rar)|corr(?:ija|ige|igir)|ajust(?:a|e|ar)|troc(?:a|ar)|troque|mud(?:a|e|ar)|tir(?:a|e|ar)|bot(?:a|e|ar)|pass(?:a|e|ar) (?:pro|para o) (?:meu )?controle|deix(?:a|e|ar) (?:de acompanhar|.{0,35}\bpendente)|adicione|adicionar|inclua|coloc(?:a|ar)|coloque|renove|pague|confirme|transfira|mande|envie)\b/.test(
        verb
      );
    }) ||
    (!lookupOnly &&
      !s.includes('?') &&
      /^(?:hoje\s+|acabei de\s+)?(?:gastei|paguei|recebi|comprei|gastar|pagar)\b/.test(s));
  // Unknown imperatives often end with a friendly question ("pode ser?"). Only
  // announce a lookup failure when there is evidence of a lookup in the text.
  const readRequest =
    /\b(?:qual|quais|quanto|quantos|que horas|sera que tenho|confer[ei]|confir[ae]|consult[ae]|mostr[ae]|liste|me diga|quero saber|quero ver)\b/.test(
      s
    ) ||
    /^(?:minhas?|meus?|agenda de|gastos do|tarefas de|lembretes de)\b/.test(s) ||
    (s.includes('?') &&
      /\b(?:ficou (?:salv[oa]|pendente|concluid[oa])|ainda (?:esta|ta) de pe|(?:ja |ainda )?(?:aparec(?:e|eu)|consta|vence)|quando (?:eu |el[ae] )?(?:paguei|recebi|vence)|ontem ou (?:foi )?hoje|antes de eu ver|o que (?:eu|voce)|voce acha)\b/.test(
        s
      ));
  const query =
    !write && (capability || lookupOnly || readRequest || isConversationalOnlyChannelRequest(text));
  const listedDomain = domains.find((entry) => entry.words.test(s))?.name;
  // Ordinary activities become calendar candidates only when the speaker asks
  // to check an arrangement on a date. A reminder needs a future memory cue.
  const domain =
    listedDomain ??
    (/\b(?:pra|para)(?: eu)? nao (?:me )?esquecer\b/.test(s)
      ? 'reminder'
      : readRequest &&
          /\b(?:almoco|jantar|cafe|aula|encontro)\b/.test(s) &&
          /\b(?:hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.test(s)
        ? 'calendar'
        : undefined);
  const conversion =
    query &&
    /\b(?:fuso|brasilia|cuiaba|horario de)\b/.test(s) &&
    /\b(?:que horas|qual (?:o )?horario|converta|diferenca de horario)\b/.test(s);
  return { domain, query, write, capability, conversion, normalized: s };
}

type Domain = keyof typeof guidance;
// These facts come from the subscription planner, scoped reminders, task status filter,
// expense currency grouping, and the Agenda editor. None claim a personal lookup succeeded.
function capabilityAnswer(domain: Domain | undefined, s: string): string | undefined {
  switch (domain) {
    case 'subscription':
      if (/\b(?:avis\w+|lembr\w+)\b/.test(s) && /\b(?:renovacao|vencer)\b/.test(s))
        return 'Para receber o aviso de renovação, peça um lembrete separado com o nome da assinatura, o dia e o horário. A data de renovação fica em Meu planejamento.';
      if (/\b(?:cancel\w+|fornecedor|cobranca)\b/.test(s))
        return 'Por aqui você pode tirar a assinatura do seu controle no Astra. Para encerrar a cobrança, o cancelamento é com o fornecedor.';
      break;
    case 'reminder':
      if (/\bsenhas?\b/.test(s))
        return 'Sim. Para pedir um lembrete, basta dizer o horário e dar um título, como “Trocar a senha do banco”. Guarde a senha só com você.';
      if (/\b(?:venc\w+|conta|whatsapp|telegram|painel|chega)\b/.test(s))
        return 'O lembrete pode chegar aqui mesmo na conversa. Para agendar um, diga o que quer lembrar e quando quer receber o aviso.';
      break;
    case 'task':
      if (/\b(?:concluid\w*|pendente\w*)\b/.test(s))
        return 'Uma tarefa pendente ainda está na sua lista para fazer. A concluída já foi marcada como feita. Você pode pedir para ver só as concluídas.';
      break;
    case 'calendar':
      if (/\b(?:coincid\w*|sobrep\w*|conflit\w*|mesmo horario)\b/.test(s))
        return 'Em Agenda, abra o dia para ver os compromissos e comparar os horários. Se dois coincidirem, você pode abrir um deles e escolher Editar.';
      if (/\b(?:reagend\w+|remarc\w+|mud\w+|alter\w+)\b/.test(s))
        return 'Para mudar o horário, abra o compromisso em Agenda no painel, escolha Editar e salve o novo horário.';
      break;
    case 'finance':
      if (/\b(?:moedas?|dolares?|dolar|usd|euros?|eur)\b/.test(s))
        return 'Você pode informar o valor e a moeda do gasto, inclusive em dólar. Os totais ficam separados por moeda. A tela Transações do painel mostra os lançamentos em reais.';
      break;
  }
  return undefined;
}

export function channelFailureReply(
  request: string,
  reason: Failure,
  receipts: ChannelToolReceipt[] = [],
  timeZone?: string
): string {
  const details = verifiedWriteDetails(receipts, timeZone);
  const operations = channelOperations(receipts);
  if (details.length) {
    if (operations.length > details.length)
      details.push('Sobre a outra parte do pedido, ainda não tenho confirmação.');
    return details.join('\n\n');
  }
  if (reason === 'agent_busy')
    return 'Sua mensagem anterior ainda está em processamento. Aguarde a resposta dela antes de enviar outro pedido.';
  if (!operations.length && isAstraAccessAnswerRequested(request)) return ASTRA_ACCESS_REPLY;
  const { domain, query, write, capability, conversion, normalized } = classifyRequest(request);
  // An actual write invocation outweighs a read-like sentence or a question mark,
  // including partial tool failures where the final reply never arrived.
  const attemptedWrite = operations.some((r) =>
    /^(?:(?:core(?:\.|__))?)(?:add_|batch_add_|create_|record_|schedule_|reschedule_|cancel_|complete_|delete_|update_|remove_)/.test(
      r.name
    )
  );
  const reading = query && !attemptedWrite;
  const knownAnswer = reading && capability && capabilityAnswer(domain, normalized);
  if (knownAnswer) return knownAnswer;
  let reply: string;
  if (reading && conversion)
    reply =
      'Quero te passar o horário certo. Ainda não consegui conferir a diferença entre os dois fusos.';
  else if (reading && domain === 'finance' && /\bse eu (?:gastar|pagar|comprar)\b/.test(normalized))
    reply = 'Fiquei sem o resultado dessa conta agora.';
  else if (reading && capability)
    reply = 'Quero te orientar direito. Ainda não consegui conferir como isso funciona.';
  else if (domain && (reading || write || attemptedWrite))
    reply = guidance[domain][reading ? 'read' : 'write'];
  else if (domain) reply = 'Fiquei sem a resposta completa por aqui. ' + guidance[domain].check;
  else if (
    !attemptedWrite &&
    (reading ||
      /^(?:oi|olá|ola|hello|hey|bom dia|boa tarde|boa noite)[.!\s]*$/iu.test(request.trim()))
  )
    reply = 'Não consegui te responder agora. Sua pergunta ficou em aberto.';
  else
    reply =
      'Não consegui terminar minha resposta agora. Se o pedido envolvia um registro, confira no painel como ele ficou.';
  return reason === 'rate_limited'
    ? 'Cheguei ao limite de respostas por enquanto. ' + reply
    : reason === 'timeout'
      ? 'A resposta demorou mais do que o esperado. ' + reply
      : reply;
}

// Match a complete historical runtime banner only. Explanations and quotations must survive.
const oldResponses = new Set([
  'Não consegui processar sua mensagem agora. Tente novamente em instantes.',
  'No AI provider configured. Please set up an API key (e.g. OpenAI, Anthropic) in OwnPilot Settings or Config Center.',
  'Sorry, I encountered an internal error. Please try again.',
  '(No response generated)',
  'Não consegui confirmar a execução. Confira seus registros antes de tentar novamente.',
  '⚠️ *Não consegui confirmar o pedido*\n\nNão consegui confirmar a execução. Confira seus registros antes de tentar novamente.',
  'Essa alteração ainda não está confirmada. Confira seus registros antes de pedir novamente, para evitar duplicidade.',
]);
export function presentChannelReply(
  answer: string,
  request: string,
  receipts: ChannelToolReceipt[] = [],
  timeZone?: string
): string {
  const trimmed = answer.trim();
  if (!trimmed || oldResponses.has(trimmed) || trimmed === CHANNEL_UNVERIFIED_REPLY)
    return channelFailureReply(request, 'agent_error', receipts, timeZone);
  if (
    trimmed ===
    'O serviço de IA atingiu temporariamente o limite de uso. Aguarde alguns instantes. Se a mensagem era para registrar algo, confira seus registros antes de repetir para evitar duplicidade.'
  )
    return channelFailureReply(request, 'rate_limited', receipts, timeZone);
  return currentAstraLinksInText(answer);
}
