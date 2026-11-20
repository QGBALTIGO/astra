import { inferExpenseCategory } from '../services/expense-category.js';
import { isFinanceReadOnlyRequest } from './finance-intent.js';
import {
  financeMetadataCorrectionField,
  financialWriteClarification,
  financingClarificationReply,
} from './financial-write-clarification.js';
import { classifyFinancingPaymentAuthority } from './financing-intent.js';
/**
 * Deterministic financing operations for WhatsApp/Telegram. Bypasses LLM
 * rate limits and invalid direct core.* tool calls on unambiguous requests.
 * Never treats an opening balance as a new expense or silently pays each month.
 */
import { createHash } from 'node:crypto';
import { runInExecContext } from '@ownpilot/core/agent';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { FinanceObligationsRepository } from '../db/repositories/finance-obligations.js';
import { ExpensesRepository, type ExpenseCategory } from '../db/repositories/expenses.js';
import { getLog } from '../services/log.js';
import { tryCustomerFinancialChannelReply } from './customer-finance-routing.js';
import {
  expenseConfirmationKey,
  expenseDuplicateGuard,
  type PendingExpenseDraft,
} from './expense-duplicate-guard.js';
import { formatAstraMessage, formatTransactionConfirmation } from './response-presentation.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { customerLocalDay } from '../services/customer-date.js';

import {
  parseBrlCents,
  parseFinancingIntent,
  normalizeFinancingText as normalize,
} from './financing-intent.js';
export { parseBrlCents, parseFinancingIntent } from './financing-intent.js';

const log = getLog('ChannelFinancing');

export interface ParsedChannelExpense {
  amountCents: number;
  description: string;
  category: ExpenseCategory;
}

/**
 * Deliberately narrow: only an explicit, completed, single BRL expense.
 * Questions, dates, uncertainty, corrections and compound instructions stay
 * with the assistant instead of causing an automatic financial write.
 */
export function parseChannelExpense(input: string): ParsedChannelExpense | null {
  if (financialWriteClarification(input)) return null;
  const text = input.trim();
  const normalized = normalize(text);
  if (
    text.length > 300 ||
    /[?;\r\n]/u.test(text) ||
    /\b(?:nao|nunca|jamais|nem|talvez|acho|se|caso|amanha|ontem|anteontem|segunda|terca|quarta|quinta|sexta|sabado|domingo|semana|mes|ano|passado|passada|proximo|proxima|parcela|parcelas|parcelado|parcelada|estorno|estornado|reembolso|devolvido)\b/u.test(
      normalized
    )
  ) {
    return null;
  }

  const match = text.match(
    /^(?:astra[,!:]?\s+)?(?:(?:anot[ae]|registr[ae])\s+(?:que\s+)?)?(?:eu\s+)?(?:gastei|paguei|acabei\s+de\s+(?:gastar|pagar))\s+(?:r\$\s*)?(\d[\d.,]*)\s*(?:(real|reais|centavos?)\b\s*)?(?:(?:no|na|nos|nas|em|com|pelo|pela|pelos|pelas|de)\s+([\p{L}\p{M}\s'-]+))?[.!]?$/iu
  );
  if (!match) return null;
  // Without a description, require the sender to identify the value as money.
  if (!match[3] && !match[2] && !/r\$/i.test(text)) return null;
  // The legacy financing parser tolerates trailing sentence punctuation.
  // A new automatic expense must instead have an entirely valid amount token.
  if (!/^(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[,.]\d{1,2})?)$/.test(match[1] ?? '')) {
    return null;
  }
  const token = match[1]!;
  const inCents = /^centavo/i.test(match[2] ?? '');
  if (inCents && !/^(?:\d+|0[,.]\d{1,2})$/.test(token)) return null;
  const amountCents = inCents && /^\d+$/.test(token) ? Number(token) : parseBrlCents(token);
  const description = (match[3] ?? 'Despesa').replace(/\s+/g, ' ').trim();
  const detail = normalize(description);
  if (
    !amountCents ||
    amountCents > 999_999_999_999 ||
    description.length < 2 ||
    description.length > 160 ||
    /\b(?:e|mas|ou|porem|porque|depois|antes|agora|hoje|dia|registre|registra|anote|anota|apague|apaga|corrija|corrige|cancele|cancela|exclua|excluir|total|saldo|previsao|estimativa|dolares?|euros?)\b/u.test(
      detail
    )
  ) {
    return null;
  }

  const category = inferExpenseCategory(description);
  // "Paguei 470 de gasolina" is a clear expense, but "paguei 470 de
  // entrada" may modify a financing balance. Only handle "de" when the
  // merchant/purpose already maps to a known expense category.
  if (/\d[\d.,]*\s*(?:(?:reais?|centavos?)\s+)?de\s+/u.test(normalized) && category === 'other') {
    return null;
  }
  return { amountCents, description, category };
}

/** Record a fully specified expense even when every LLM provider is busy. */
/** Carry only the expense intent across domains, never the previous amount or item. */
export function expenseContinuationText(
  message: Pick<ChannelIncomingMessage, 'text'> &
    Partial<Pick<ChannelIncomingMessage, 'platform' | 'platformChatId' | 'sender' | 'metadata'>>
): string {
  const original = message.text.trim().replace(/^astra[,!:]?\s+/iu, '');
  if (
    !/^e\s+(?:mais|tamb[eé]m)\s+r\$\s*\d/iu.test(original) ||
    /[?;\r\n]|\b(?:n[aã]o|nunca|talvez|se|exemplo|simule|cancele|corrija|altere|assinatura|mensais|renova[cç][aã]o|vencimento|amanh[aã]|ontem|hoje|dia|total|quanto)\b/iu.test(
      original
    )
  )
    return message.text;
  const privateChat =
    message.platform === 'whatsapp'
      ? message.metadata?.isGroup !== true && !message.platformChatId?.endsWith('@g.us')
      : message.platform === 'telegram' &&
        (message.metadata?.chatType === 'private' ||
          (!!message.platformChatId && message.platformChatId === message.sender?.platformUserId));
  if (!privateChat || !Array.isArray(message.metadata?.astraRecentReceipts)) return message.text;
  const financial = message.metadata.astraRecentReceipts
    .map((row: unknown) =>
      row && typeof row === 'object' && 'action' in row && typeof row.action === 'string'
        ? row.action
        : ''
    )
    .find((action: string) => /^(?:Despesa|Entrada|Valor a (?:pagar|receber))\b/iu.test(action));
  if (!/^Despesa (?:j[aá] )?(?:registrada|atualizada)$/iu.test(financial ?? ''))
    return message.text;
  const candidate = original.replace(/^e\s+(?:mais|tamb[eé]m)\s+/iu, 'Gastei ');
  return parseChannelExpense(candidate) ? candidate : message.text;
}

export async function tryExpenseRecordChannelReply(
  message: Pick<
    ChannelIncomingMessage,
    'text' | 'id' | 'channelPluginId' | 'platformChatId' | 'timestamp'
  > &
    Partial<Pick<ChannelIncomingMessage, 'platform' | 'metadata' | 'sender'>>,
  userId: string
): Promise<string | null> {
  if (isFinanceReadOnlyRequest(message.text))
    return tryCustomerFinancialChannelReply(message, userId);
  const clarification = financialWriteClarification(message.text);
  if (clarification)
    return clarification.reason === 'financing_payment_requires_link' ||
      clarification.reason === 'financial_metadata_correction_requires_update'
      ? null
      : clarification.message;
  const pendingKey = expenseConfirmationKey(userId, message);
  const undo =
    /^(?:apague|remova|exclua) (?:apenas |somente )?o gasto de hoje de r\$\s*(\d{1,8}(?:,\d{2})?) com (?:a descrição )?["“]([^"”\r\n]{2,160})["”][.!]?$/iu.exec(
      message.text.trim()
    );
  if (
    undo &&
    !(
      (message.platform === 'whatsapp' &&
        message.metadata?.isGroup !== true &&
        !message.platformChatId.endsWith('@g.us')) ||
      (message.platform === 'telegram' &&
        (message.metadata?.chatType === 'private' ||
          message.platformChatId === message.sender?.platformUserId))
    )
  )
    return 'Abra a conversa privada com o Astra para conferir o seu gasto.';
  if (
    undo &&
    userId.trim() &&
    message.id &&
    message.platformChatId &&
    message.channelPluginId &&
    message.timestamp instanceof Date &&
    Number.isFinite(message.timestamp.getTime())
  ) {
    const amount = Number(undo[1]!.replace(',', '.'));
    if (!(amount > 0)) return 'Qual foi o valor positivo desse gasto?';
    try {
      const account = userId.startsWith('whatsapp:')
        ? await customerAccountsRepo.getByDataUserId(userId)
        : null;
      const day = customerLocalDay(
        message.timestamp,
        account?.timeZone ?? process.env.TZ ?? 'America/Campo_Grande'
      );
      const result = await new ExpensesRepository(userId).removeNamedChannelExpense(
        undo[2]!,
        amount,
        day,
        message.timestamp
      );
      if (result === 'removed')
        return (
          'Removi do seu controle o gasto de R$ ' +
          amount.toFixed(2).replace('.', ',') +
          ' com ' +
          undo[2] +
          '.'
        );
      if (result === 'missing')
        return 'Não encontrei um gasto registrado por aqui hoje com esse valor e essa descrição.';
      if (result === 'ambiguous')
        return 'Encontrei mais de um gasto igual. Abra o painel e escolha o lançamento que quer remover.';
      return 'Esse gasto está vinculado a um financiamento. Você pode conferir o vínculo no painel.';
    } catch {
      return 'Não consegui conferir esse gasto agora. Consulte o lançamento no painel antes de tentar novamente.';
    }
  }
  const answer = expenseDuplicateGuard.consume(pendingKey, message.text);
  if (answer?.kind === 'stale') {
    return 'A confirmação anterior já foi encerrada. Para registrar outro gasto, envie o valor e a descrição.';
  }
  if (answer?.kind === 'same') {
    return 'Entendi, era o mesmo gasto. Mantive apenas o lançamento original, sem criar outro.';
  }
  const expenseText = expenseContinuationText(message);
  const customerFinanceReply = answer
    ? null
    : await tryCustomerFinancialChannelReply(
        expenseText === message.text ? message : { ...message, text: expenseText },
        userId
      );
  if (customerFinanceReply !== null) return customerFinanceReply;
  const intent =
    answer?.kind === 'other'
      ? {
          amountCents: Math.round(answer.draft.amount * 100),
          category: answer.draft.category,
          description: answer.draft.description,
        }
      : parseChannelExpense(expenseText);
  if (!intent) return null;
  if (
    !userId?.trim() ||
    !message.id ||
    !message.channelPluginId ||
    !message.platformChatId ||
    !(message.timestamp instanceof Date) ||
    Number.isNaN(message.timestamp.getTime())
  ) {
    return 'Não consegui confirmar sua identidade ou a data desse gasto. O registro não foi iniciado.';
  }

  const sourceKey = createHash('sha256')
    .update(JSON.stringify([userId, message.channelPluginId, message.platformChatId, message.id]))
    .digest('hex');
  // Keep the existing expense tool's local-calendar convention, using the
  // incoming event time rather than the time a queued message gets processed.
  const at = message.timestamp;
  try {
    const account = userId.startsWith('whatsapp:')
      ? await customerAccountsRepo.getByDataUserId(userId)
      : null;
    const date = userId.startsWith('whatsapp:')
      ? customerLocalDay(at, account?.timeZone ?? 'America/Campo_Grande')
      : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    const repo = new ExpensesRepository(userId);
    const draft: PendingExpenseDraft =
      answer?.kind === 'other'
        ? answer.draft
        : {
            date,
            amount: intent.amountCents / 100,
            currency: 'BRL',
            category: intent.category,
            description: intent.description,
            source: 'channel',
          };

    if (!answer) {
      // Same amount alone is not a duplicate: match purpose, local day,
      // category, saved channel source and recent creation time as well.
      const candidates = await repo.list({
        dateFrom: date,
        dateTo: date,
        minAmount: draft.amount,
        maxAmount: draft.amount,
        limit: 30,
      });
      const normalizedDescription = draft.description
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
        .trim();
      const nowMs = Date.now();
      const possiblySame = candidates.some((candidate) => {
        const createdAt = candidate.createdAt.getTime();
        const description = candidate.description
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLocaleLowerCase('pt-BR')
          .trim();
        return (
          candidate.source === 'channel' &&
          candidate.amount === draft.amount &&
          candidate.category === draft.category &&
          description === normalizedDescription &&
          Number.isFinite(createdAt) &&
          nowMs >= createdAt &&
          nowMs - createdAt < 10 * 60_000
        );
      });
      if (possiblySame) {
        expenseDuplicateGuard.remember(pendingKey, draft);
        const displayValue = new Intl.NumberFormat('pt-BR', {
          style: 'currency',
          currency: 'BRL',
        }).format(draft.amount);
        return (
          'Encontrei um gasto parecido de ' +
          displayValue +
          ' (' +
          draft.description +
          ') que você registrou recentemente. ' +
          'É o mesmo gasto ou outro? Responda "Mesmo" ou "Outro". Não criei outro lançamento.'
        );
      }
    }
    const { expense, created } = await repo.createFromChannel(draft, sourceKey);
    if (created) {
      // A failed UI notification must not turn a committed expense into a
      // misleading failure that prompts the user to register it again.
      try {
        const { wsGateway } = await import('../ws/server.js');
        wsGateway.broadcast('data:changed', {
          entity: 'expense',
          action: 'created',
          id: expense.id,
        });
      } catch (error) {
        log.warn('Expense saved but UI notification failed', { error });
      }
    }
    // A replay may have been corrected in the portal. Present the persisted
    // value, date, category and state instead of repeating the parsed request.
    return formatTransactionConfirmation(
      {
        type: expense.transactionType ?? 'expense',
        status: expense.status,
        amount: expense.amount,
        currency: expense.currency,
        description: expense.description,
        category: expense.categoryName ?? expense.category,
        date: expense.date,
      },
      created ? 'created' : 'existing'
    );
  } catch (error) {
    log.warn('Channel expense persistence failed', { error });
    return 'Não consegui confirmar o registro desse gasto agora. Consulte seus gastos antes de reenviar.';
  }
}

function currency(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export async function tryFinancingChannelReply(
  message: Pick<ChannelIncomingMessage, 'text' | 'id' | 'channelPluginId' | 'platformChatId'> &
    Partial<Pick<ChannelIncomingMessage, 'timestamp'>>,
  userId: string
): Promise<string | null> {
  if (financeMetadataCorrectionField(message.text)) return null;
  const clarification = financingClarificationReply(message.text);
  if (clarification) return clarification;
  const authority = classifyFinancingPaymentAuthority(message.text);
  const intent =
    authority.kind === 'new_payment'
      ? { kind: 'payment' as const, name: authority.name, amountCents: authority.amountCents }
      : parseFinancingIntent(message.text);
  if (!intent) return null;
  if (intent.kind === 'unconfirmed') {
    return 'Nenhuma alteração foi feita no financiamento. Para consultar, pergunte pelo saldo. Para registrar um pagamento já feito, envie uma mensagem separada com o valor e o nome do financiamento.';
  }
  // The fast path cannot invent an identity if the channel did not resolve it.
  if (!userId || !message.id || !message.channelPluginId || !message.platformChatId) {
    return 'Não consegui confirmar sua identidade para consultar o financiamento.';
  }

  return runInExecContext(
    {
      channelMessageId: message.id,
      channelPluginId: message.channelPluginId,
      platformChatId: message.platformChatId,
    },
    async () => {
      try {
        const repo = new FinanceObligationsRepository(userId);
        if (intent.kind === 'create') {
          const result = await repo.createOrFind(
            intent.name,
            intent.principalCents,
            intent.openingCents
          );
          const balance = result.balance;
          return formatAstraMessage(
            result.created ? '✅ Financiamento registrado' : '✅ Financiamento já registrado',
            [
              { label: 'Financiamento', value: balance.name },
              { label: 'Total', value: currency(balance.principalCents) },
              { label: 'Pago', value: currency(balance.paidCents) },
              { label: 'Falta pagar', value: currency(balance.remainingCents) },
            ],
            'Vou atualizar o saldo quando você confirmar novos pagamentos; não darei baixa automaticamente.'
          );
        }

        if (intent.kind === 'query') {
          const balance = await repo.find(intent.name);
          if (!balance) {
            return (
              'Não encontrei financiamento de ' +
              intent.name +
              '. Informe o valor total e o que já foi pago para cadastrá-lo.'
            );
          }
          return formatAstraMessage('📊 Saldo do financiamento', [
            { label: 'Financiamento', value: balance.name },
            { label: 'Total', value: currency(balance.principalCents) },
            { label: 'Pago', value: currency(balance.paidCents) },
            { label: 'Falta pagar', value: currency(balance.remainingCents) },
          ]);
        }

        const sourceKey = createHash('sha256')
          .update([userId, message.channelPluginId, message.platformChatId, message.id].join('|'))
          .digest('hex');
        const result = await repo.recordPayment(
          intent.name,
          intent.amountCents,
          sourceKey,
          message.timestamp
        );
        if (result.status === 'missing') {
          return (
            'Ainda não encontrei o financiamento de ' +
            intent.name +
            '. Informe o valor total e quanto já pagou antes de dar baixa.'
          );
        }
        if (result.status === 'conflict') {
          return 'Esta mensagem já foi usada para registrar outro pagamento. Para corrigir, confira o pagamento existente; não registrei outro valor.';
        }
        const balance = result.balance;
        if (result.status === 'exceeds') {
          return (
            'O pagamento informado é maior que o saldo restante (' +
            currency(balance.remainingCents) +
            '). Nenhum valor foi alterado.'
          );
        }
        return formatAstraMessage(
          result.status === 'duplicate' ? '✅ Pagamento já registrado' : '✅ Pagamento registrado',
          [
            { label: 'Financiamento', value: balance.name },
            // The transaction commits this exact amount only for a new payment.
            // A replay returns the current balance, not its original payment.
            ...(result.status === 'recorded'
              ? [{ label: 'Valor', value: currency(result.payment.amountCents) }]
              : []),
            { label: 'Pago', value: currency(balance.paidCents) },
            { label: 'Falta pagar', value: currency(balance.remainingCents) },
          ],
          result.status === 'duplicate' ? 'Não dupliquei a despesa.' : undefined
        );
      } catch (error) {
        log.warn('Financing persistence failed', { error });
        return 'Não consegui salvar ou consultar o financiamento agora. Nenhum novo pagamento foi confirmado.';
      }
    }
  );
}
