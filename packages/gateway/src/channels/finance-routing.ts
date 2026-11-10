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
import { expenseCategoryLabelPtBr } from '../tools/expense-presentation.js';
import { getLog } from '../services/log.js';
import { tryCustomerFinancialChannelReply } from './customer-finance-routing.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { customerLocalDay } from '../services/customer-date.js';

const log = getLog('ChannelFinancing');

type ParsedIntent =
  | { kind: 'create'; name: string; principalCents: number; openingCents: number }
  | { kind: 'query'; name: string }
  | { kind: 'payment'; name: string; amountCents: number };

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

/** Parse explicit Brazilian currency: 72 mil, 72.000, 930, 470,50. */
export function parseBrlCents(raw: string, multiplier?: string): number | null {
  // WhatsApp sentences often put a comma immediately after the amount.
  const compact = raw.replace(/\s/g, '').replace(/[.,]+$/g, '');
  let normalized: string;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(compact)) {
    normalized = compact.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+(?:,\d{1,2})?$/.test(compact)) {
    normalized = compact.replace(',', '.');
  } else if (/^\d+\.\d{1,2}$/.test(compact)) {
    normalized = compact;
  } else {
    return null;
  }
  const number = Number(normalized);
  const value = number * (multiplier && /^(?:mil|k)$/.test(multiplier) ? 1000 : 1);
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 9_000_000_000_000 ? cents : null;
}

function safeName(name: string): string | null {
  const clean = name.replace(/\s+/g, ' ').trim();
  return /^[a-z0-9][a-z0-9 -]{1,59}$/.test(clean) ? clean : null;
}

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
    /^(?:astra[,!:]?\s+)?(?:(?:anot[ae]|registr[ae])\s+(?:que\s+)?)?(?:eu\s+)?(?:gastei|paguei|acabei\s+de\s+(?:gastar|pagar))\s+(?:r\$\s*)?(\d[\d.,]*)\s*(?:reais?\s+)?(?:no|na|nos|nas|em|com|pelo|pela|pelos|pelas)\s+([\p{L}\p{M}\s'-]+)[.!]?$/iu
  );
  if (!match) return null;
  // The legacy financing parser tolerates trailing sentence punctuation.
  // A new automatic expense must instead have an entirely valid amount token.
  if (!/^(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[,.]\d{1,2})?)$/.test(match[1] ?? '')) {
    return null;
  }
  const amountCents = parseBrlCents(match[1] ?? '');
  const description = (match[2] ?? '').replace(/\s+/g, ' ').trim();
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

  let category: ExpenseCategory = 'other';
  if (
    /\b(?:almoco|jantar|cafe|lanche|padaria|restaurante|mercado|supermercado|ifood|pizza|comida|refeicao|alimentacao)\b/u.test(
      detail
    )
  ) {
    category = 'food';
  } else if (
    /\b(?:uber|taxi|gasolina|combustivel|onibus|metro|transporte|estacionamento|pedagio)\b/u.test(
      detail
    )
  ) {
    category = 'transport';
  } else if (/\b(?:farmacia|remedio|medicamento|consulta|dentista|exame|saude)\b/u.test(detail)) {
    category = 'health';
  } else if (/\b(?:netflix|spotify|assinatura)\b/u.test(detail)) {
    category = 'subscription';
  } else if (/\b(?:internet|energia|luz|agua|telefone)\b/u.test(detail)) {
    category = 'utilities';
  }
  return { amountCents, description, category };
}

/** Record a fully specified expense even when every LLM provider is busy. */
export async function tryExpenseRecordChannelReply(
  message: Pick<
    ChannelIncomingMessage,
    'text' | 'id' | 'channelPluginId' | 'platformChatId' | 'timestamp'
  >,
  userId: string
): Promise<string | null> {
  const customerFinanceReply = await tryCustomerFinancialChannelReply(message, userId);
  if (customerFinanceReply !== null) return customerFinanceReply;
  const intent = parseChannelExpense(message.text);
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
    const { expense, created } = await repo.createFromChannel(
      {
        date,
        amount: intent.amountCents / 100,
        currency: 'BRL',
        category: intent.category,
        description: intent.description,
        source: 'channel',
      },
      sourceKey
    );
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
    const amount = currency(Math.round(expense.amount * 100));
    const category = expense.categoryName ?? expenseCategoryLabelPtBr(expense.category);
    if (expense.transactionType === 'income' || expense.status === 'pending') {
      const state =
        expense.status === 'pending'
          ? expense.transactionType === 'income'
            ? 'a receber'
            : 'a pagar'
          : 'recebido';
      return `Esse lançamento já estava registrado: ${amount} em ${category}: ${expense.description}. Situação atual: ${state}.`;
    }
    return created
      ? `Registrei ${amount} em ${category}: ${expense.description}.`
      : `Esse gasto já estava registrado: ${amount} em ${category}: ${expense.description}.`;
  } catch (error) {
    log.warn('Channel expense persistence failed', { error });
    return 'Não consegui confirmar o registro desse gasto agora. Consulte seus gastos antes de reenviar.';
  }
}

export function parseFinancingIntent(input: string): ParsedIntent | null {
  const text = normalize(input);

  // "O valor do carro é 72 mil, já foi pago 930, vai registrando..."
  // Requires BOTH the total and opening amount; never guesses missing data.
  const setup = text.match(
    /\bvalor\s+(?:total\s+)?(?:do|da)\s+([a-z0-9 -]{2,60}?)\s+(?:e|de|foi)\s+(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?\s*[,;]?\s*(?:ja\s+(?:foi\s+)?pago|ja\s+paguei|ja\s+pagamos|ja\s+(?:foi\s+)?quitado)\s*(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?/u
  );
  if (setup) {
    const name = safeName(setup[1] ?? '');
    const principalCents = parseBrlCents(setup[2] ?? '', setup[3]);
    const openingCents = parseBrlCents(setup[4] ?? '', setup[5]);
    if (name && principalCents && openingCents !== null && openingCents <= principalCents) {
      return { kind: 'create', name, principalCents, openingCents };
    }
    // A recognizable but invalid debt request must not be misread as a payment.
    return null;
  }

  // "Quanto falta pagar do carro?" / "Saldo do carro?"
  const query = text.match(
    /\b(?:quanto\s+(?:falta|resta)\s+(?:pagar\s+)?(?:do|da)|saldo\s+(?:restante\s+)?(?:do|da)|quanto\s+(?:ja\s+)?paguei\s+(?:do|da))\s+([a-z0-9 -]{2,60}?)(?:[?!.]|$)/u
  );
  if (query) {
    const name = safeName(query[1] ?? '');
    if (name) return { kind: 'query', name };
  }

  // Only unambiguous, completed payments. A scheduled/expected installment
  // or "vou pagar" must never be automatically deducted.
  const paid = text.match(
    /\b(?:paguei|abati|dei\s+baixa\s+em)\s+(?:mais\s+)?(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?\s*(?:reais?)?\s+(?:do|da)\s+([a-z0-9 -]{2,60}?)(?:[.!?,;]|$)/u
  );
  if (paid) {
    const amountCents = parseBrlCents(paid[1] ?? '', paid[2]);
    const name = safeName(paid[3] ?? '');
    if (name && amountCents) return { kind: 'payment', name, amountCents };
  }
  return null;
}

function currency(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export async function tryFinancingChannelReply(
  message: Pick<ChannelIncomingMessage, 'text' | 'id' | 'channelPluginId' | 'platformChatId'>,
  userId: string
): Promise<string | null> {
  const intent = parseFinancingIntent(message.text);
  if (!intent) return null;
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
          const lead = result.created
            ? 'Financiamento de ' + balance.name + ' registrado.'
            : 'O financiamento de ' + balance.name + ' já estava cadastrado.';
          return (
            lead +
            '\nTotal: ' +
            currency(balance.principalCents) +
            '\nPago: ' +
            currency(balance.paidCents) +
            '\nFalta: ' +
            currency(balance.remainingCents) +
            '\nVou atualizar o saldo quando você confirmar novos pagamentos; não darei baixa automaticamente.'
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
          return (
            'Financiamento de ' +
            balance.name +
            ':\nTotal: ' +
            currency(balance.principalCents) +
            '\nPago: ' +
            currency(balance.paidCents) +
            '\nFalta: ' +
            currency(balance.remainingCents) +
            '.'
          );
        }

        const sourceKey = createHash('sha256')
          .update([userId, message.channelPluginId, message.platformChatId, message.id].join('|'))
          .digest('hex');
        const result = await repo.recordPayment(intent.name, intent.amountCents, sourceKey);
        if (result.status === 'missing') {
          return (
            'Ainda não encontrei o financiamento de ' +
            intent.name +
            '. Informe o valor total e quanto já pagou antes de dar baixa.'
          );
        }
        const balance = result.balance;
        if (result.status === 'exceeds') {
          return (
            'O pagamento informado é maior que o saldo restante (' +
            currency(balance.remainingCents) +
            '). Nenhum valor foi alterado.'
          );
        }
        return (
          (result.status === 'duplicate'
            ? 'Esse pagamento já havia sido registrado. Não dupliquei a despesa.'
            : 'Pagamento de ' + currency(intent.amountCents) + ' registrado com sucesso.') +
          '\nPago: ' +
          currency(balance.paidCents) +
          '\nFalta: ' +
          currency(balance.remainingCents) +
          '.'
        );
      } catch (error) {
        log.warn('Financing persistence failed', { error });
        return 'Não consegui salvar ou consultar o financiamento agora. Nenhum novo pagamento foi confirmado.';
      }
    }
  );
}
