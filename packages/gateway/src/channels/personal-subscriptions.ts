import { createHash } from 'node:crypto';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { validateCustomerFinanceDate } from '../db/repositories/customer-finance.js';
import {
  CustomerPlanningRepository,
  subscriptionTitleKey,
  type CustomerPlan,
  type SubscriptionChange,
  type SubscriptionResult,
} from '../db/repositories/customer-planning.js';
import { getLog } from '../services/log.js';

const HELP =
  'Para acompanhar uma assinatura, envie “Cadastre a assinatura Música por R$ 24,90 com renovação em 15/12/2026”. Depois, use “Minhas assinaturas”, “Atualize a assinatura Música para R$ 29,90” ou “Remova a assinatura Música”.';
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const pageSize = 8;
type Intent =
  | SubscriptionChange
  | { action: 'list'; page: number; title?: string }
  | { action: 'clarify' }
  | { action: 'explainRenewalReminder' };
const clarify = { action: 'clarify' } as const;
const fieldConnectors =
  /(?:\s|,)+(?=(?:(?:por|de|para|com|no|valor|novo|a|pr[oó]xima|nova|e|renova[çc][aã]o|em|dia|vencimento|vence|renova)\s+)*(?:r\$|\d{1,2}\/|\d{4}-))/iu;
const prices =
  /^[\s,]*(?:(?:por|de|para|com|no|valor|novo|e)\s+)*r\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?)(?=$|[\s,])/iu;
const dates =
  /^[\s,]*(?:(?:e|com|a|nova|pr[oó]xima|renova[çc][aã]o|vence|renova|para|dia|em|no|vencimento|de)\s+)*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})(?=$|[\s,])/iu;

function addressableTitle(title: string): boolean {
  return (
    /^[\p{L}\d][\p{L}\p{M}\d .'’&+()-]{0,119}$/u.test(title) &&
    !/\b(?:ou|para|por|renova[çc][aã]o|vencimento|reais|assinatura|tamb[eé]m)\b/iu.test(title)
  );
}

const months = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

function planningRequest(text: string): string | null {
  if (text.length > 350 || /[\r\n;]/u.test(text)) return text;
  const create =
    /^(?:coloca|coloque|adiciona|adicione|inclua|inclui)\s+(?:a |o )?(.{1,120}?)\s+nas minhas assinaturas\s*[:,]\s*(r\$\s*[\d.,]+)\s*(?:por m[êe]s|mensais|ao m[êe]s)\s*,\s*(?:pr[oó]xima )?renova[çc][aã]o (?:dia |em )?(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2} de [a-zç]{3,9} de \d{4})[.!]?(?: ainda n[aã]o paguei nada\.)?(?: quero acompanhar no meu planejamento[.!]?)?$/iu.exec(
      text
    );
  if (create && addressableTitle(create[1]!)) {
    let due = create[3]!;
    const fullDate = /^(\d+) de (\S+) de (\d+)$/iu.exec(due);
    if (fullDate) {
      const month = months.indexOf(fullDate[2]!.toLowerCase().replace('marco', 'março')) + 1;
      if (!month) return null;
      due = [fullDate[1], month, fullDate[3]].join('/');
    }
    return 'Cadastre a assinatura ' + create[1] + ' por ' + create[2] + ' em ' + due;
  }
  const detail =
    /^qual (?:o )?valor mensal e qual (?:a )?pr[oó]xima renova[çc][aã]o (?:aparecem|constam) em assinaturas para (?:a |o )?([^?!]{1,120})\?(?: consult[ae] meu planejamento (?:pra|para) conferir[.!]?)?$/iu.exec(
      text
    );
  if (detail && addressableTitle(detail[1]!)) return 'Quando vence a assinatura ' + detail[1] + '?';
  const monthlyCost =
    /^quanto (?:eu )?pago (?:por m[êe]s )?(?:na|pela) (?:minha )?assinatura (?:da |do |de )?(.{1,120}?)(?: e quando (?:ela )?renova)?\?$/iu.exec(
      text
    );
  if (monthlyCost && addressableTitle(monthlyCost[1]!))
    return 'Quando vence a assinatura ' + monthlyCost[1] + '?';
  const remove =
    /^(?:remova|remove|tira|tire) do meu planejamento (?:s[oó] |apenas )?a assinatura (.{1,120}?)(?:, se ela estiver cadastrada)?[.!]?(?: n[aã]o cancele nada no fornecedor[.!]?)?$/iu.exec(
      text
    );
  if (remove && addressableTitle(remove[1]!)) return 'Remova a assinatura ' + remove[1];
  return text;
}

function parseIntent(input: string): Intent | null {
  const raw = input
    .trim()
    .replace(/^astra[,!]?\s+/iu, '')
    .replace(/,?\s+por favor[.!?]?$/iu, '')
    .trim();
  if (!/\bassinaturas?\b/iu.test(raw)) return null;
  // A question about how renewal notices work should never create a plan or reminder.
  if (
    raw.length <= 350 &&
    /^(?:para o astra me avisar|o astra (?:me )?avisa|voc[êe] (?:me )?avisa|se eu cadastrar|preciso (?:pedir|criar|agendar) um lembrete|basta (?:eu )?cadastrar)\b/iu.test(
      raw
    ) &&
    /\b(?:renova[çc][aã]o|vence|vencer)\b/iu.test(raw) &&
    /\b(?:lembrete|automaticamente|avisa)\b/iu.test(raw) &&
    /\?(?:\s*s[oó] (?:quero entender como funciona|me explica)[.!]?)?$/iu.test(raw)
  )
    return { action: 'explainRenewalReminder' };
  const text = planningRequest(raw);
  if (text === null) return clarify;
  // A completed payment, reminder request, or question about the Astra access plan
  // belongs to its existing route.
  if (
    /^(?:me\s+lembr|lembr[ea]|paguei|gastei|quanto\s+gastei)/iu.test(text) ||
    /\b(?:assinatura|acesso|plano)\s+(?:do\s+)?astra\b/iu.test(text)
  )
    return null;
  const list =
    /^(?:(?:(?:me\s+)?(?:liste|listar|lista|mostr[ea]|ver)|quando\s+(?:vencem|renovam)|quais\s+(?:são|sao))\s+)?(?:(?:as\s+)?minhas\s+|as\s+)?assinaturas(?:\s+(?:p[aá]gina\s+)?(\d{1,2}))?[.!?]?$/iu.exec(
      text
    );
  if (list) return { action: 'list', page: Number(list[1] ?? 1) };
  const detail =
    /^(?:quando\s+(?:vence|renova)|qual\s+(?:é\s+)?o\s+valor\s+da|qual\s+(?:é\s+)?a\s+(?:pr[oó]xima\s+)?renova[çc][aã]o\s+da)\s+(?:a\s+)?(?:minha\s+)?assinatura\s+(?:(?:da|do|de)\s+)?([^?!\r\n]{1,120})[?!]?$/iu.exec(
      text
    );
  if (detail) return { action: 'list', title: detail[1]!.trim(), page: 1 };
  const command =
    /^(?:(?:quero|pode)\s+)?(cadastre?|cadastra|cadastrar|crie|cria|criar|adicione|adiciona|adicionar|registre|registra|registrar|anote|anota|anotar|acompanhe|acompanha|atualize|atualiza|atualizar|altere|altera|alterar|mude|muda|mudar|renove|renova|renovar|cancele|cancela|cancelar|remova|remove|remover|exclua|exclui|excluir|apague|apaga)\s+(?:(?:o\s+valor|a\s+(?:pr[oó]xima\s+)?renova[çc][aã]o)\s+da\s+|(?:a\s+|uma\s+)?(?:minha\s+)?)assinatura\b\s*(?:(?:do|da|de)\s+)?(.*)$/iu.exec(
      text
    );
  if (!command) return null;
  if (
    text.length > 350 ||
    /[?;\r\n]/u.test(text) ||
    /\b(?:se|talvez|n[aã]o|nunca|mas|depois|antes|exceto|simule|teste|exemplo|automaticamente)\b/iu.test(
      text
    )
  )
    return clarify;
  const verb = command[1]!;
  const action = /^(?:cancel|remov|exclu|apag)/iu.test(verb)
    ? 'remove'
    : /^(?:atualiz|alter|mud|renov)/iu.test(verb)
      ? 'update'
      : 'create';
  const body = command[2]!.trim().replace(/[.!]$/u, '');
  // Split only on complete value/date fields. The remainder must consist entirely
  // of expected connectors after extracting the values, or we request clarification.
  const field = fieldConnectors.exec(body);
  const title = (field ? body.slice(0, field.index) : body).trim();
  const byId = /^#[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(title);
  if ((!byId && !addressableTitle(title)) || (byId && action === 'create')) return clarify;
  if (action === 'remove') return field ? clarify : { action, title };
  if (!field) return clarify;
  let tail = body.slice(field.index);
  let amount: number | undefined;
  let nextDueDate: string | undefined;
  while (tail) {
    const money = prices.exec(tail);
    if (money && amount === undefined) {
      amount = Number(money[1]!.replaceAll('.', '').replace(',', '.'));
      if (!(amount > 0 && amount <= 9999999999.99)) return clarify;
      tail = tail.slice(money[0].length);
      continue;
    }
    const date = dates.exec(tail);
    if (!date || nextDueDate) return clarify;
    const parts = date[1]!.split('/');
    const iso =
      parts.length === 3
        ? [parts[2], parts[1]!.padStart(2, '0'), parts[0]!.padStart(2, '0')].join('-')
        : date[1]!;
    try {
      if (!/^[1-9]\d{3}-/u.test(iso)) return clarify;
      nextDueDate = validateCustomerFinanceDate(iso);
    } catch {
      return clarify;
    }
    tail = tail.slice(date[0].length);
  }
  if (action === 'create')
    return amount && nextDueDate ? { action, title, amount, nextDueDate } : clarify;
  return { action, title, amount, nextDueDate };
}

function describePlan(plan: CustomerPlan): string {
  const due = plan.nextDueDate?.split('-').reverse().join('/');
  return (
    plan.title +
    ' · ' +
    currency.format(plan.amount) +
    ' · ' +
    (due ? 'renovação em ' + due : 'renovação sem data')
  );
}

function formatResult(result: SubscriptionResult): string {
  switch (result.status) {
    case 'inactive':
      return 'Seu acesso está inativo. A alteração não foi registrada.';
    case 'replay':
      return 'Essa mensagem já foi processada. Consulte “Minhas assinaturas” para ver o registro atual.';
    case 'conflict':
      return 'O conteúdo dessa mensagem mudou. Envie o pedido em uma nova mensagem.';
    case 'limit':
      return 'Você atingiu o limite de 80 planejamentos da sua conta.';
    case 'missing':
      return 'Não encontrei essa assinatura no seu controle. Consulte “Minhas assinaturas” e use o nome completo.';
    case 'ambiguous':
      return (
        'Há várias assinaturas com esse nome. Repita o pedido com o código da assinatura no lugar do nome.\n' +
        result.plans
          .slice(0, pageSize)
          .map((plan) => describePlan(plan) + ' · #' + plan.id)
          .join('\n') +
        (result.plans.length > pageSize
          ? '\nOs demais códigos aparecem em “Minhas assinaturas”.'
          : '')
      );
    case 'exists':
      return (
        'Você já acompanha essa assinatura: ' +
        describePlan(result.plan) +
        '. Para mudar o valor ou a renovação, use “Atualize a assinatura”.'
      );
    case 'created':
      return 'Assinatura adicionada ao seu controle: ' + describePlan(result.plan) + '.';
    case 'updated':
      return 'Assinatura atualizada no seu controle: ' + describePlan(result.plan) + '.';
    case 'removed':
      return (
        'Removi ' +
        result.plan.title +
        ' do seu controle no Astra. Para encerrar a cobrança, solicite o cancelamento ao fornecedor.'
      );
  }
}

export async function tryPersonalSubscriptionReply(
  message: ChannelIncomingMessage,
  userId: string,
  canWrite: () => Promise<boolean>
): Promise<string | null> {
  if (message.attachments?.length || !['whatsapp', 'telegram'].includes(message.platform))
    return null;
  const intent = parseIntent(message.text);
  if (!intent) return null;
  if (
    !userId?.trim() ||
    !message.sender?.platformUserId ||
    message.sender.platformUserId !== message.platformChatId ||
    message.metadata?.isGroup === true ||
    (message.platform === 'telegram' && message.metadata?.chatType !== 'private')
  ) {
    return 'Abra uma conversa privada com o Astra para consultar suas assinaturas.';
  }
  if (intent.action === 'clarify') return HELP;
  if (intent.action === 'explainRenewalReminder')
    return 'Peça um lembrete separado para receber o aviso. A data de renovação fica no seu planejamento de assinaturas. Ao pedir o lembrete, diga o dia, o horário e o nome da assinatura.';
  try {
    const repo = new CustomerPlanningRepository(userId);
    if (intent.action === 'list') {
      const all = await repo.subscriptions();
      const title = intent.title;
      const plans = title
        ? all.filter((plan) =>
            title.startsWith('#')
              ? '#' + plan.id === title
              : subscriptionTitleKey(plan.title) === subscriptionTitleKey(title)
          )
        : all;
      if (!plans.length)
        return title
          ? formatResult({ status: 'missing' })
          : 'Você ainda não tem assinaturas cadastradas no seu controle.';
      const pages = Math.ceil(plans.length / pageSize);
      if (intent.page < 1 || intent.page > pages) return 'Informe uma página de 1 a ' + pages + '.';
      const offset = (intent.page - 1) * pageSize;
      const names = plans.map((plan) => subscriptionTitleKey(plan.title));
      const entries = plans
        .slice(offset, offset + pageSize)
        .map(
          (plan, i) =>
            describePlan(plan) +
            (!addressableTitle(plan.title) ||
            names.indexOf(names[offset + i]!) !== names.lastIndexOf(names[offset + i]!)
              ? ' · #' + plan.id
              : '')
        );
      return (
        entries.join('\n') +
        (intent.page < pages
          ? '\nContinue com “Minhas assinaturas página ' + (intent.page + 1) + '”.'
          : '')
      );
    }
    if (!message.id || !message.channelPluginId)
      return 'Envie o pedido em uma nova mensagem para confirmar a alteração.';
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          message.platform,
          message.channelPluginId,
          message.platformChatId,
          message.id,
        ])
      )
      .digest('hex');
    return formatResult(await repo.changeSubscription(key, intent, canWrite));
  } catch (error) {
    getLog('ChannelPersonalSubscriptions').error('Falha ao acessar assinaturas pessoais', {
      category: error instanceof Error ? error.name : 'unknown',
    });
    return 'Não consegui confirmar o registro agora. Consulte “Minhas assinaturas” antes de repetir o pedido.';
  }
}
