import { inferExpenseCategory } from '../services/expense-category.js';
/** Explicit income/pending transactions and queries without an LLM call. */
import { createHash } from 'node:crypto';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import {
  CustomerFinanceRepository,
  validateCustomerFinanceDate,
  type CustomerTransactionType,
} from '../db/repositories/customer-finance.js';
import { getLog } from '../services/log.js';
import { formatAstraMessage, formatTransactionConfirmation } from './response-presentation.js';

const log = getLog('CustomerFinanceChannel');
type Message = Pick<
  ChannelIncomingMessage,
  'text' | 'id' | 'channelPluginId' | 'platformChatId' | 'timestamp'
>;
export interface ChannelFinanceRecord {
  type: CustomerTransactionType;
  status: 'settled' | 'pending';
  amountCents: number;
  description: string;
  categoryKey: string;
  dateText?: string;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function categoryFor(description: string, type: CustomerTransactionType): string {
  const text = normalize(description);
  if (type === 'income') {
    if (/\b(?:salario|salarios|salario mensal)\b/.test(text)) return 'salary';
    if (/\b(?:freela|freelance|servico|servicos|consultoria)\b/.test(text)) return 'services';
    if (/\b(?:venda|vendas)\b/.test(text)) return 'sales';
    if (/\b(?:rendimento|rendimentos|dividendos|investimento)\b/.test(text)) return 'investments';
    return 'other';
  }
  return inferExpenseCategory(description);
}

function explicitCents(raw: string): number | null {
  if (!/^(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[,.]\d{1,2})?)$/.test(raw)) return null;
  const grouped = /^\d{1,3}(?:\.\d{3})+/.test(raw);
  const normalized = (grouped ? raw.replace(/\./g, '') : raw).replace(',', '.');
  const [integer, fraction = ''] = normalized.split('.');
  const cents = Number(BigInt(integer!) * 100n + BigInt(fraction.padEnd(2, '0')));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 999_999_999_999 ? cents : null;
}

export function parseChannelFinanceRecord(input: string): ChannelFinanceRecord | null {
  let text = input.trim();
  const normalized = normalize(text);
  if (
    text.length > 300 ||
    /[?;\r\n]/.test(text) ||
    /\b(?:nao|nunca|jamais|talvez|acho|se|caso|estorno|reembolso|dolares?|euros?|transferencia|parcelas?|parcelado|parcelada)\b/.test(
      normalized
    )
  )
    return null;
  let dateText: string | undefined;
  const dateSuffix =
    /\s+(?:(?:em|no\s+dia|dia)\s+)?(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|hoje|amanh[ãa])[.!]?$/iu.exec(
      text
    );
  if (dateSuffix) {
    dateText = dateSuffix[1];
    text = text.slice(0, dateSuffix.index).trim();
  }
  const match =
    /^(?:astra[,!:]?\s+)?(?:(?:anot[ae]|registr[ae])\s+(?:que\s+)?)?(?:eu\s+)?(recebi|ganhei|acabei\s+de\s+(?:receber|ganhar|gastar|pagar)|vou\s+receber|tenho\s+a\s+receber|vou\s+pagar|tenho\s+a\s+pagar|tenho|gastei|paguei)\s+(?:r\$\s*)?(\d[\d.,]*)\s*(?:(?:real|reais)\b\s*)?(?:(a\s+receber|a\s+pagar)\b\s*)?(?:(?:de|do|da|dos|das|em|no|na|nos|nas|com|por|pelo|pela|pelos|pelas)\s+([\p{L}\p{M}\s'-]+)|([\p{L}\p{M}\s'-]+))?[.!]?$/iu.exec(
      text
    );
  if (!match) return null;
  // Without a description, a bare count may refer to items rather than money.
  if (!match[4] && !/(?:r\$|(?:real|reais)\b)/i.test(text)) return null;
  const action = normalize(match[1]!);
  const state = normalize(match[3] ?? '');
  if (action === 'tenho' && !state) return null;
  const pending = /^(?:vou|tenho)/.test(action);
  const type: CustomerTransactionType =
    /\b(?:recebi|ganhei|ganhar|receber)\b/.test(action) || /receber/.test(state)
      ? 'income'
      : 'expense';
  // In spoken shorthand the payer can follow an explicit monetary amount.
  // Keep ambiguous counts and expense wording on the AI interpretation path.
  if (
    match[5] &&
    (type !== 'income' ||
      !/(?:r\$|(?:real|reais)\b)/i.test(text) ||
      /^(?:de|do|da|dos|das|em|no|na|nos|nas|com|por|pelo|pela|pelos|pelas)(?:\s|$)/iu.test(
        match[5]
      ))
  )
    return null;
  // Completed expense statements without an explicit day keep the established
  // expense parser and provider-id key. This module extends its date support.
  if (type === 'expense' && !pending && !dateText) return null;
  if (!pending && state) return null;
  if (
    pending &&
    state &&
    ((/pagar/.test(action) && /receber/.test(state)) ||
      (/receber/.test(action) && /pagar/.test(state)))
  )
    return null;
  // A completed monetary statement does not need a merchant or income source.
  // Keep a neutral label when the user did not provide one; never infer a payer.
  const providedDescription = match[4] ?? match[5];
  const description = providedDescription
    ? providedDescription.replace(/\s+/g, ' ').trim()
    : pending
      ? type === 'income'
        ? 'Valor a receber'
        : 'Valor a pagar'
      : type === 'income'
        ? 'Recebimento'
        : 'Despesa';
  const detail = normalize(description);
  if (
    description.length < 2 ||
    description.length > 160 ||
    /\b(?:e|ou|mas|porem|porque|ontem|anteontem|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|mes|semana|ano|dia|apague|exclua|cancele|corrija|depois|antes|cerca|aproximadamente)\b/.test(
      detail
    )
  )
    return null;
  const amountCents = explicitCents(match[2]!);
  if (!amountCents) return null;
  return {
    type,
    status: pending ? 'pending' : 'settled',
    amountCents,
    description,
    categoryKey: categoryFor(description, type),
    ...(dateText ? { dateText } : {}),
  };
}

function calendarDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join('-');
}

function resolveDay(text: string | undefined, today: string): string {
  if (!text || normalize(text) === 'hoje') return today;
  if (normalize(text) === 'amanha')
    return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const brazil = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  return validateCustomerFinanceDate(brazil ? `${brazil[3]}-${brazil[2]}-${brazil[1]}` : text);
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount);
}

function formatDay(date: string): string {
  return validateCustomerFinanceDate(date).split('-').reverse().join('/');
}

export async function tryCustomerFinancialChannelReply(
  message: Message,
  dataUserId: string
): Promise<string | null> {
  const normalized = normalize(message.text);
  const record = parseChannelFinanceRecord(message.text);
  const settlement =
    /^(?:astra[,!:]?\s+)?(?:marque|marcar|confirme|confirmar)\s+(?:como\s+)?(paga|pago|recebida|recebido)\s+(?:a\s+)?pend[eê]ncia\s+([\p{L}\p{M}\s'-]+)[.!]?$/iu.exec(
      message.text.trim()
    );
  const query =
    /^(?:(?:quanto\s+(?:recebi|entrou))(?:\s+(hoje|neste\s+mes|este\s+mes|no\s+mes\s+passado))?|(?:resumo\s+financeiro|minhas\s+pendencias|quanto\s+tenho\s+a\s+(?:pagar|receber)|o\s+que\s+tenho\s+a\s+(?:pagar|receber))(?:\s+(hoje|neste\s+mes|este\s+mes|no\s+mes\s+passado))?)[?.!]?$/u.exec(
      normalized
    );
  if (!record && !settlement && !query) return null;
  if (
    !dataUserId?.trim() ||
    !message.id ||
    !message.channelPluginId ||
    !message.platformChatId ||
    !(message.timestamp instanceof Date) ||
    !Number.isFinite(message.timestamp.getTime())
  ) {
    return 'Não consegui confirmar sua identidade ou a data. Nenhum lançamento foi alterado.';
  }
  const sourceKey = createHash('sha256')
    .update(
      JSON.stringify([dataUserId, message.channelPluginId, message.platformChatId, message.id])
    )
    .digest('hex');
  try {
    const account = await customerAccountsRepo.getByDataUserId(dataUserId);
    const today = calendarDay(message.timestamp, account?.timeZone ?? 'America/Campo_Grande');
    const repo = new CustomerFinanceRepository(dataUserId);
    if (settlement) {
      const outcome = await repo.settleFromChannel({
        type: /^recebid/i.test(settlement[1]!) ? 'income' : 'expense',
        description: settlement[2]!.trim(),
        date: today,
        sourceKey,
      });
      if (outcome.outcome === 'missing')
        return 'Não encontrei essa pendência. Confira a descrição no painel; nenhum lançamento foi criado.';
      if (outcome.outcome === 'ambiguous')
        return 'Há mais de uma pendência com essa descrição. Escolha o lançamento no painel para confirmar, sem duplicar os registros.';
      const saved = outcome.transaction;
      return formatTransactionConfirmation(
        {
          type: saved.type,
          status: saved.status,
          amount: saved.amount,
          currency: saved.currency,
          description: saved.description,
          category: saved.categoryName,
          date: saved.date,
        },
        outcome.outcome === 'duplicate' ? 'existing' : 'updated'
      );
    }
    if (query) {
      let from = `${today.slice(0, 7)}-01`;
      let to = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0))
        .toISOString()
        .slice(0, 10);
      if (/\bhoje\b/.test(normalized)) from = to = today;
      else if (/mes passado/.test(normalized)) {
        to = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        from = `${to.slice(0, 7)}-01`;
      }
      const summary = await repo.summary(from, to);
      const period = `${formatDay(summary.period.from)} a ${formatDay(summary.period.to)}`;
      if (/pendencias|a pagar|a receber/.test(normalized)) {
        return formatAstraMessage(
          '⏳ Pendências',
          [
            { label: 'Período', value: period },
            { label: 'A receber', value: formatAmount(summary.pendingIncome) },
            { label: 'A pagar', value: formatAmount(summary.pendingExpenses) },
          ],
          'Esses valores ainda não entram no resultado realizado. Para confirmar um item, diga: "Marque como paga a pendência Internet" ou "Marque como recebida a pendência Salário".'
        );
      }
      if (/quanto (?:recebi|entrou)/.test(normalized))
        return formatAstraMessage(
          '📊 Entradas recebidas',
          [
            { label: 'Período', value: period },
            { label: 'Total recebido', value: formatAmount(summary.income) },
          ],
          'As entradas pendentes não foram somadas.'
        );
      return formatAstraMessage('📊 Resumo financeiro', [
        { label: 'Período', value: period },
        { label: 'Entradas recebidas', value: formatAmount(summary.income) },
        { label: 'Despesas pagas', value: formatAmount(summary.expenses) },
        { label: 'Resultado realizado', value: formatAmount(summary.result) },
        { label: 'A receber', value: formatAmount(summary.pendingIncome) },
        { label: 'A pagar', value: formatAmount(summary.pendingExpenses) },
      ]);
    }
    if (!record) return null;
    if (record.status === 'pending' && !record.dateText)
      return 'Qual é a data dessa pendência? Por exemplo: "Tenho 120 reais a pagar de Internet amanhã". Ainda não registrei o valor.';
    const date = resolveDay(record.dateText, today);
    if (record.status === 'settled' && date > today)
      return 'Essa data ainda não chegou. Confirme se é uma pendência a pagar ou a receber; nenhum lançamento foi criado.';
    const { transaction, created } = await repo.createFromChannel(
      {
        description: record.description,
        amount: record.amountCents / 100,
        type: record.type,
        status: record.status,
        categoryKey: record.categoryKey,
        date,
      },
      sourceKey
    );
    return formatTransactionConfirmation(
      {
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        description: transaction.description,
        category: transaction.categoryName,
        date: transaction.date,
      },
      created ? 'created' : 'existing'
    );
  } catch (error) {
    log.warn('Operação financeira do canal não concluída', {
      category: error instanceof Error ? error.name : 'unknown',
    });
    return 'Não consegui confirmar essa operação financeira agora. Confira o painel antes de tentar novamente; nenhum novo valor foi confirmado.';
  }
}
