import { getLog } from '../services/log.js';
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
    read: 'Sua agenda não abriu por aqui agora. Dá uma olhada em Agenda no painel para conferir os horários.',
    write:
      'Fiquei sem a confirmação desse compromisso. Antes de pedir outra alteração, veja em Agenda no painel se a mudança já aparece.',
  },
  reminder: {
    read: 'A lista de avisos não abriu agora. Você pode olhar em Agenda no painel ou me perguntar daqui a pouco “Quais são meus lembretes de hoje?”.',
    write:
      'A confirmação do aviso não chegou. Confira o horário e o status em Agenda no painel antes de criar outro.',
  },
  task: {
    read: 'Estou sem a lista de tarefas por aqui. Você também encontra seus itens em Agenda no painel.',
    write:
      'Fiquei sem a confirmação da tarefa. Para ver como ela ficou, mande “Consulte a tarefa” seguido do título.',
  },
  subscription: {
    read: 'Os dados da assinatura não carregaram agora. Para ver o que está cadastrado, mande “Minhas assinaturas”.',
    write:
      'A confirmação da assinatura não chegou. Mande “Minhas assinaturas” para conferir se a mudança já aparece.',
  },
  finance: {
    read: 'Fiquei sem os dados dos seus lançamentos. Para conferir os valores agora, abra Transações no painel.',
    write:
      'A confirmação do lançamento não chegou. Confira em Transações no painel antes de anotar de novo, para não contar duas vezes.',
  },
} as const;
/** The deterministic lookup already knows its intent; keep its error details out of the reply. */
export function channelReadFailure(domain: keyof typeof guidance, cause: unknown): string {
  const reason = channelFailureKind(
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  );
  getLog('ChannelRead').warn('Channel lookup unavailable', { domain, reason });
  return guidance[domain].read;
}
const domains = [
  { name: 'subscription', words: /\b(?:assinaturas?|mensalidades?|renovacao)\b/ },
  { name: 'reminder', words: /\b(?:lembretes?|lembrar|lembre|lembra|avisos?|avisar)\b/ },
  { name: 'task', words: /\b(?:tarefas?|afazeres?)\b/ },
  {
    name: 'calendar',
    words:
      /\b(?:agenda|compromissos?|reuniao|reunioes|videochamada|calendario|dentista|(?:minha|uma|essa|a) consulta)\b/,
  },
  {
    name: 'finance',
    words:
      /\b(?:financeiro|financas|gastos?|gastei|paguei|recebi|receitas?|despesas?|cartao|saldo|parcelas?|pagamentos?|lancamentos?|transacoes|dinheiro|reais)\b|r\$/,
  },
] as const;
function classifyRequest(text: string) {
  const s = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  const write =
    /(?:^|[;.!]\s*|,\s*|\be\s+)(?:astra[, ]+\s*)?(?:por favor[, ]+\s*)?(?:(?:voce\s+)?(?:pode|poderia|consegue)\s+|(?:quero|preciso)\s+que\s+(?:voce\s+)?)?(?:me\s+)?(?:agend(?:e|ar)|agenda(?=\s+(?:um|uma|o|a|na|no|minha|meu|para|pra)\b)|marc(?:a|ar)|marque|remarc(?:a|ar)|remarque|reagend(?:a|e|ar)|cr(?:ia|ie|iar)|lemb(?:ra|re|rar)|avis(?:a|e|ar)|regist(?:ra|re|rar)|anot(?:a|e|ar)|lanc(?:a|ar)|lance|salv(?:a|e|ar)|exclu(?:a|ir)|apag(?:a|ue|ar)|remov(?:a|er)|cancel(?:a|e|ar)|atualiz(?:a|e|ar)|alter(?:a|e|ar)|conclu(?:a|ir)|cadast(?:ra|re|rar)|adicione|adicionar|inclua|coloque|renove|pague|confirme|transfira|mande|envie)\b/.test(
      s
    ) || /^(?:hoje\s+|acabei de\s+)?(?:gastei|paguei|recebi|comprei|gastar|pagar)\b/.test(s);
  const explanation =
    /\b(?:quero entender|como funciona|basta|preciso (?:pedir|criar)|que eu mesm[oa] (?:marco|agendo)|so me diga)\b/.test(
      s
    );
  const query =
    !write &&
    (explanation ||
      isConversationalOnlyChannelRequest(text) ||
      s.includes('?') ||
      /^(?:qual|quais|quanto|quantos|quando|como|que horas|consult[ae]|confir[ae]|confere|mostr[ae]|liste|meus?|minhas?|agenda de|gastos do|tarefas de|lembretes de)\b/.test(
        s
      ));
  const domain = domains.find((entry) => entry.words.test(s))?.name;
  const conversion =
    query &&
    /\b(?:fuso|brasilia|cuiaba|horario de)\b/.test(s) &&
    /\b(?:que horas|qual (?:o )?horario|converta|diferenca de horario)\b/.test(s);
  return { domain, query, explanation, conversion };
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
  const { domain, query, explanation, conversion } = classifyRequest(request);
  // An actual write invocation outweighs a read-like sentence or a question mark,
  // including partial tool failures where the final reply never arrived.
  const attemptedWrite = operations.some((r) =>
    /^(?:(?:core(?:\.|__))?)(?:add_|batch_add_|create_|record_|schedule_|reschedule_|cancel_|complete_|delete_|update_|remove_)/.test(
      r.name
    )
  );
  const reading = query && !attemptedWrite;
  let reply: string;
  if (reading && conversion)
    reply =
      'Quero te passar o horário certo. Ainda não consegui conferir a diferença entre os dois fusos.';
  else if (reading && explanation && domain === 'subscription')
    reply =
      'Quero te orientar direito sobre o aviso de renovação. Ainda não consegui conferir como ele funciona.';
  else if (reading && explanation)
    reply =
      'Não consegui conferir essa orientação agora. Pode me fazer a pergunta de novo em instantes?';
  else if (domain) reply = guidance[domain][reading ? 'read' : 'write'];
  else if (
    !attemptedWrite &&
    (reading || /^(?:oi|ola|hello|hey|bom dia|boa tarde|boa noite)[.!\s]*$/iu.test(request.trim()))
  )
    reply = 'Não consegui te responder agora. Pode me chamar de novo em instantes?';
  else
    reply =
      'Não consegui terminar minha resposta agora. Se você pediu para mudar algum registro, vale conferir o painel antes de repetir.';
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
  return answer;
}
