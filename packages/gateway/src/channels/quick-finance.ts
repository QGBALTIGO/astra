import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import {
  CustomerFinanceRepository,
  CustomerFinanceError,
} from '../db/repositories/customer-finance.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { customerLocalDay, validCalendarDay } from '../services/customer-date.js';
import { formatAstraMessage, formatTransactionConfirmation } from './response-presentation.js';
import { isConversationalOnlyChannelRequest } from './tool-selection.js';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
type Plan = {
  intro?: string;
  op: 'list' | 'update';
  search: string;
  amount: number | null;
  on: string | null;
  at: string | null;
  category: string | null;
  latest: boolean;
};
const instructions =
  'Extraia um filtro de DESPESAS do pedido, sem executar ações. Somente JSON compacto com op (list/update), search (descrição literal ou ""), amount (valor usado para identificar, em reais, ou null), on (dia YYYY-MM-DD ou null), at (hora local HH:mm ou null), category (nova categoria literal ou null), latest (true só se pediu o último gasto). Hoje consta no contexto. NÃO invente filtros. Update só para mudar categoria explicitamente. Inclua intro com uma frase curta de até dez palavras que reaja ao assunto, com personalidade discreta, sem números nem confirmar ações. Nunca crie nem exclua. Se pedir outra ação ou houver mais de uma ação, responda null.';

export function explicitFinancePlan(request: string, today: string): Plan | null {
  const input = fold(request);
  if (/\b(?:nao|nunca|se|talvez|exemplo|ficticio|e depois|tambem)\b/.test(input)) return null;
  if (/^(?:qual foi |qual e |qual )?(?:o )?meu ultimo gasto[?.!]?$/u.test(input))
    return {
      op: 'list',
      search: '',
      amount: null,
      on: null,
      at: null,
      category: null,
      latest: true,
    };
  const target =
    /\bpara\s+(alimenta[cç][aã]o|transporte|sa[uú]de|outros|compras|lazer|assinaturas|educa[cç][aã]o|moradia)\b/iu.exec(
      request
    )?.[1] ?? null;
  const op = /\b(?:mude|altere|corrija|troque)\b/.test(input) ? 'update' : 'list';
  if (op === 'update' && (!target || !/categoria/.test(input))) return null;
  const subject =
    /\b(?:gastos?|despesas?|lan[cç]amentos?)\s+(?:com (?:a )?descri[cç][aã]o\s+)?["“]?([\p{L}\p{M}][\p{L}\p{M} '-]{0,100}?)(?:["”]|\s+de\s+r\$)/iu
      .exec(request)?.[1]
      ?.trim();
  if (!subject) return null;
  const amounts = [...request.matchAll(/r\$\s*(\d[\d.,]*)/giu)].map((m) => m[1]!);
  const amount = amounts[0];
  if (
    !amount ||
    new Set(amounts).size !== 1 ||
    !/^(?:\d+(?:[,.]\d{1,2})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?)$/.test(amount)
  )
    return null;
  const value = Number(
    amount.includes(',')
      ? amount.replace(/\./g, '').replace(',', '.')
      : /^\d{1,3}(?:\.\d{3})+$/.test(amount)
        ? amount.replace(/\./g, '')
        : amount
  );
  const date = /\b(\d{2})\/(\d{2})\/(\d{4})\b/.exec(request);
  const on = /\bhoje\b/.test(input) ? today : date ? [date[3], date[2], date[1]].join('-') : null;
  if (on && !validCalendarDay(on)) return null;
  const at = /\b((?:[01]\d|2[0-3]):[0-5]\d)(?::\d{2})?\b/.exec(request)?.[1] ?? null;
  return {
    op,
    search: subject,
    amount: value,
    on,
    at,
    category: op === 'update' ? target : null,
    latest: false,
  };
}

export function parseQuickFinancePlan(raw: string, request: string): Plan | null {
  let p: Plan;
  try {
    p = JSON.parse(raw.replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, ''));
  } catch {
    return null;
  }
  if (
    !p ||
    !['list', 'update'].includes(p.op) ||
    typeof p.search !== 'string' ||
    p.search.length > 120 ||
    typeof p.latest !== 'boolean'
  )
    return null;
  const input = fold(request);
  if (p.search && !input.includes(fold(p.search))) return null;
  if (
    p.amount !== null &&
    (typeof p.amount !== 'number' || !Number.isFinite(p.amount) || p.amount <= 0)
  )
    return null;
  if (p.on !== null && (typeof p.on !== 'string' || !validCalendarDay(p.on))) return null;
  if (p.at !== null && (typeof p.at !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(p.at)))
    return null;
  if (
    p.op === 'update' &&
    (typeof p.category !== 'string' || !p.category || !input.includes(fold(p.category)))
  )
    return null;
  if (p.op === 'list' && p.category !== null) return null;
  p.latest = p.latest && /\bultim[oa]\b/.test(input);
  return p;
}

/** One small AI extraction, one scoped ledger query, and a fact-backed receipt. */
export async function tryQuickFinanceReply(
  message: ChannelIncomingMessage,
  userId: string,
  canWrite: () => Promise<boolean>
): Promise<string | null> {
  const input = fold(message.text);
  if (
    message.attachments?.length ||
    message.text.length > 650 ||
    isConversationalOnlyChannelRequest(message.text) ||
    !/\b(?:gastos?|despesas?|lancamentos?|financeiro|transacoes)\b/.test(input) ||
    !/\b(?:liste|listar|mostre|consulte|consultar|qual|quais|quanto|mude|altere|corrija|troque|categoria)\b/.test(
      input
    ) ||
    /\b(?:apague|exclua|remova|registre|crie|pague|cancele|nao (?:mude|altere|corrija)|sem (?:alterar|corrigir).*(?:mude|altere))\b/.test(
      input
    )
  )
    return null;
  const account = await customerAccountsRepo.getByDataUserId(userId);
  const timeZone = account?.timeZone ?? 'America/Sao_Paulo';
  const today = customerLocalDay(message.timestamp, timeZone);
  const explicit = explicitFinancePlan(message.text, today);
  let raw: string | null = null;
  if (!explicit)
    try {
      const { writeShortChannelReply } = await import('./short-channel-reply.js');
      raw = await writeShortChannelReply(
        message.channelPluginId,
        instructions,
        JSON.stringify({ hoje: today, pedido: message.text }),
        230,
        Date.now() + 7500
      );
    } catch {
      return null;
    }
  const plan = explicit ?? (raw ? parseQuickFinancePlan(raw, message.text) : null);
  if (!plan) return null;
  const { safePersonalComment } = await import('./confirmed-reply-personality.js');
  const comment = explicit
    ? import('./short-channel-reply.js')
        .then(({ writeShortChannelReply }) =>
          writeShortChannelReply(
            message.channelPluginId,
            'Você é o Astra. Reaja ao assunto numa frase natural de até oito palavras. Não repita números nem afirme operações. Sem perguntas, conselhos ou termos técnicos. Responda apenas a frase.',
            JSON.stringify({
              assunto: plan.search || 'consulta do último gasto',
              pedido: message.text,
            }),
            26,
            Date.now() + 2600
          )
        )
        .catch(() => null)
    : Promise.resolve(plan.intro ?? null);
  const present = async (body: string) => {
    const text = await comment;
    const intro = typeof text === 'string' ? safePersonalComment(text) : null;
    return intro ? intro + '\n\n' + body : body;
  };
  const compact = input.replace(/\s/g, '');
  if (
    plan.amount !== null &&
    !compact.includes(String(plan.amount)) &&
    !compact.includes(String(plan.amount).replace('.', ','))
  )
    return null;
  if (plan.at && !input.includes(plan.at) && !input.includes(plan.at.replace(':', 'h')))
    return null;
  // "Hoje" and explicit dates are grounded independently of the model.
  if (plan.on && !/\bhoje\b|\d{1,2}[/-]\d{1,2}|\d{4}-\d{2}-\d{2}/.test(input)) return null;
  if (/\bhoje\b/.test(input) && plan.on !== today) return null;
  if (
    plan.on &&
    !/\bhoje\b/.test(input) &&
    !input.includes(plan.on) &&
    !input.includes(plan.on.split('-').reverse().join('/'))
  )
    return null;
  if (
    plan.op === 'update' &&
    (!/\b(?:mude|altere|corrija|troque)\b/.test(input) || !/categoria/.test(input))
  )
    return null;
  const repo = new CustomerFinanceRepository(userId);
  const result = await repo.listTransactions({
    type: 'expense',
    search: plan.search || undefined,
    from: plan.on ?? undefined,
    to: plan.on ?? undefined,
    pageSize: 20,
    sort: plan.latest ? 'created' : undefined,
  });
  if (result.total > 20 && !plan.latest) return null;
  const clock = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  let items = result.transactions.filter(
    (t) =>
      (plan.amount === null || Math.round(t.amount * 100) === Math.round(plan.amount * 100)) &&
      (!plan.at || clock.format(new Date(t.createdAt)) === plan.at)
  );
  if (plan.latest) items = items.slice(0, 1);
  if (!items.length)
    return formatAstraMessage(
      '🔎 Nenhum gasto encontrado',
      [],
      'Pode conferir a descrição, o valor e o dia para eu procurar de novo?'
    );
  if (plan.op === 'update') {
    if (items.length !== 1 || (!plan.search && !plan.latest))
      return formatAstraMessage(
        '🔎 Qual destes gastos?',
        items.slice(0, 5).map((t) => ({
          label: t.description,
          value:
            'R$ ' +
            t.amount.toFixed(2).replace('.', ',') +
            ' · ' +
            clock.format(new Date(t.createdAt)),
        })),
        'Me diga o horário do lançamento que quer corrigir.'
      );
    const categories = await repo.listCategories();
    const category = categories.find(
      (c) => c.type === 'expense' && !c.archived && fold(c.name) === fold(plan.category!)
    );
    if (!category) return 'Me diga o nome da categoria como aparece no seu painel para eu ajustar.';
    if (!(await canWrite())) return null;
    try {
      const saved = await repo.updateTransaction(
        items[0]!.id,
        { categoryId: category.id },
        items[0]!.updatedAt
      );
      if (!saved)
        return 'Esse lançamento mudou enquanto eu conferia. Consulte o gasto novamente antes de corrigir.';
      return present(
        formatTransactionConfirmation({ ...saved, category: saved.categoryName }, 'updated')
      );
    } catch (error) {
      if (error instanceof CustomerFinanceError)
        return 'Esse lançamento mudou enquanto eu conferia. Consulte o gasto novamente antes de corrigir.';
      throw error;
    }
  }
  return present(
    items
      .slice(0, 5)
      .map((t) =>
        formatAstraMessage('🔎 ' + (plan.latest ? 'Seu último gasto' : t.description), [
          {
            label: 'Valor',
            value: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
              t.amount
            ),
          },
          { label: 'Descrição', value: t.description },
          { label: 'Categoria', value: t.categoryName },
          { label: 'Data', value: t.date.split('-').reverse().join('/') },
          { label: 'Registrado às', value: clock.format(new Date(t.createdAt)) },
        ])
      )
      .join('\n\n')
  );
}
