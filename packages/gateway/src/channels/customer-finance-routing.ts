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
  if (
    /\b(?:mercado|supermercado|almoco|jantar|cafe|lanche|restaurante|padaria|alimentacao)\b/.test(
      text
    )
  )
    return 'food';
  if (/\b(?:internet|energia|luz|agua|telefone)\b/.test(text)) return 'utilities';
  if (/\b(?:aluguel|condominio|moradia)\b/.test(text)) return 'housing';
  if (/\b(?:uber|gasolina|combustivel|onibus|transporte)\b/.test(text)) return 'transport';
  if (/\b(?:farmacia|saude|consulta|dentista|remedio)\b/.test(text)) return 'health';
  return 'other';
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
    /^(?:astra[,!:]?\s+)?(?:(?:anot[ae]|registr[ae])\s+(?:que\s+)?)?(?:eu\s+)?(recebi|ganhei|acabei\s+de\s+receber|vou\s+receber|tenho\s+a\s+receber|vou\s+pagar|tenho\s+a\s+pagar|tenho|gastei|paguei)\s+(?:r\$\s*)?(\d[\d.,]*)\s*(?:reais?\s+)?(?:(a\s+receber|a\s+pagar)\s+)?(?:de|do|da|dos|das|em|no|na|com|por)\s+([\p{L}\p{M}\s'-]+)[.!]?$/iu.exec(
      text
    );
  if (!match) return null;
  const action = normalize(match[1]!);
  const state = normalize(match[3] ?? '');
  if (action === 'tenho' && !state) return null;
  const pending = /^(?:vou|tenho)/.test(action);
  const type: CustomerTransactionType =
    /receber/.test(action) || /receber/.test(state) || /^(?:recebi|ganhei)/.test(action)
      ? 'income'
      : 'expense';
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
  const description = match[4]!.replace(/\s+/g, ' ').trim();
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
      return `${outcome.outcome === 'duplicate' ? 'Essa confirmação já foi processada.' : 'Atualizei o mesmo lançamento.'} ${outcome.transaction.description}: ${formatAmount(outcome.transaction.amount)}. Situação: ${outcome.transaction.status === 'pending' ? (outcome.transaction.type === 'income' ? 'a receber' : 'a pagar') : outcome.transaction.type === 'income' ? 'recebido' : 'pago'}.`;
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
      if (/pendencias|a pagar|a receber/.test(normalized)) {
        return `Pendências de ${from} a ${to}:\nA receber: ${formatAmount(summary.pendingIncome)}.\nA pagar: ${formatAmount(summary.pendingExpenses)}.\nEsses valores ainda não entram no resultado realizado. Para confirmar um item, diga: "Marque como paga a pendência Internet" ou "Marque como recebida a pendência Salário".`;
      }
      if (/quanto (?:recebi|entrou)/.test(normalized))
        return `Entradas recebidas de ${from} a ${to}: ${formatAmount(summary.income)}. As entradas pendentes não foram somadas.`;
      return `Resumo financeiro de ${from} a ${to}:\nEntradas recebidas: ${formatAmount(summary.income)}.\nDespesas pagas: ${formatAmount(summary.expenses)}.\nResultado realizado: ${formatAmount(summary.result)}.\nA receber: ${formatAmount(summary.pendingIncome)}.\nA pagar: ${formatAmount(summary.pendingExpenses)}.`;
    }
    if (!record) return null;
    if (record.status === 'pending' && !record.dateText)
      return 'Qual é a data dessa pendência? Por exemplo: "Tenho 120 reais a pagar de Internet em 2026-11-12". Ainda não registrei o valor.';
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
    const status =
      transaction.status === 'pending'
        ? transaction.type === 'income'
          ? 'a receber'
          : 'a pagar'
        : transaction.type === 'income'
          ? 'recebido'
          : 'pago';
    return `${created ? 'Registrei' : 'Esse lançamento já estava registrado:'} ${formatAmount(transaction.amount)} ${status}: ${transaction.description}, em ${transaction.date}.${transaction.status === 'pending' ? ' O valor fica separado dos realizados.' : ''}`;
  } catch (error) {
    log.warn('Operação financeira do canal não concluída', {
      category: error instanceof Error ? error.name : 'unknown',
    });
    return 'Não consegui confirmar essa operação financeira agora. Confira o painel antes de tentar novamente; nenhum novo valor foi confirmado.';
  }
}
