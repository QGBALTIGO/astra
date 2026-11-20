import { inferExpenseCategory } from '../services/expense-category.js';
import { isFinanceReadOnlyRequest } from '../channels/finance-intent.js';
import {
  financialWriteRefusal,
  isOnlyRequestedFinanceMetadataUpdate,
} from '../channels/financial-write-clarification.js';
import { channelFinanceCreateIdentity } from '../channels/finance-create-identity.js';
import { isBulkFinanceDeletionRequest } from '../channels/finance-bulk-intent.js';
import { isChannelEmailRequest } from '../channels/email-intent.js';
import { financeSelectionScope, rememberFinanceRead } from '../channels/finance-read-context.js';
import { customerAccountBinding } from '../channels/customer-channel-access.js';
import {
  financeBulkSelectionRepo,
  type FinanceSelectionFilter,
} from '../db/repositories/finance-bulk-selection.js';
/** User-scoped tools for the same income/expense ledger used by the customer portal. */
import { getExecContext } from '@ownpilot/core/agent';
import type { ToolDefinition } from '@ownpilot/core/tools';
import {
  CustomerFinanceError,
  CustomerFinanceRepository,
  validateCustomerFinanceDate,
  type CustomerCategory,
  type CustomerTransactionInput,
  type CustomerTransactionQuery,
} from '../db/repositories/customer-finance.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { customerLocalDay } from '../services/customer-date.js';

const fields = {
  description: { type: 'string', description: 'Descrição informada pelo usuário.' },
  category: {
    type: 'string',
    description:
      'Nome da categoria somente quando indicado pela pessoa. Omita quando não houver categoria explícita: o servidor classifica pelo item. Não confunda o estabelecimento com o item comprado.',
  },
  amount: { type: 'number', description: 'Valor positivo em reais, até duas casas decimais.' },
  type: {
    type: 'string',
    enum: ['income', 'expense'],
    description: 'income = entrada; expense = saída.',
  },
  status: {
    type: 'string',
    enum: ['settled', 'pending'],
    description: 'settled = já recebido/pago; pending = a receber/pagar.',
  },
  date: {
    type: 'string',
    description: 'Dia local YYYY-MM-DD: recebimento/pagamento ou vencimento. Sem hora.',
  },
} as const;

export const CUSTOMER_FINANCE_TOOLS: ToolDefinition[] = [
  {
    name: 'record_transaction',
    category: 'Finance',
    brief: 'Registrar entrada, saída ou pendência no painel',
    description:
      'Registra no mesmo financeiro do painel. "Tenho para receber" é income/pending, não despesa nem dinheiro já recebido. Não cria notificações. Não duplique: para corrigir registro use update_transaction. Nunca invente valor, data de vencimento ou recebimento.',
    parameters: {
      type: 'object',
      properties: fields,
      required: ['description', 'amount', 'type', 'status', 'date'],
    },
  },
  {
    name: 'list_transactions',
    category: 'Finance',
    brief: 'Buscar entradas, saídas e pendências financeiras',
    description:
      'Consulta entradas, saídas e pendências do usuário. Use antes de corrigir/excluir; não invente IDs. IDs retornados são internos: não exiba nem peça ao usuário. createdLocal é a data e hora de criação no fuso do cliente; copie esse horário diretamente. createdAt é o instante original em UTC. Diferencie os lançamentos por descrição, valor, data e hora de criação. Pergunte apenas se continuar ambíguo.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        type: fields.type,
        status: fields.status,
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        page: { type: 'integer', description: 'Página inteira a partir de 1.' },
      },
    },
  },
  {
    name: 'update_transaction',
    category: 'Finance',
    brief: 'Corrigir um lançamento existente sem duplicar',
    description:
      'Corrige pelo ID interno consultado: valor, descrição, categoria, data, entrada/saída e pendente/realizado. Para trocar despesa por entrada atualize type=income, não exclua e recrie. Não confirma recebimento quando o valor ainda está previsto. Na resposta use descrição, valor e data; nunca exiba ou peça o ID.',
    parameters: {
      type: 'object',
      properties: { transaction_id: { type: 'string' }, ...fields },
      required: ['transaction_id'],
    },
  },
  {
    name: 'delete_transaction',
    category: 'Finance',
    brief: 'Excluir lançamento solicitado pelo usuário',
    description:
      'Exclusão lógica, individual e restrita ao usuário, usando ID interno consultado. Não use para simplesmente corrigir o tipo. Na confirmação use descrição, valor e data; nunca exiba ou peça o ID.',
    parameters: {
      type: 'object',
      properties: { transaction_id: { type: 'string' } },
      required: ['transaction_id'],
    },
  },
  {
    name: 'financial_summary',
    category: 'Finance',
    brief: 'Consultar saldo e totais reais, separando previsões',
    description:
      'Resumo do período: entradas recebidas, saídas pagas, saldo e pendências em campos separados. Categorias Outros também entram no cálculo. Nunca trate pendências como caixa realizado.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['from', 'to'],
    },
  },
];

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new CustomerFinanceError(`Informe ${name}.`);
  return value.trim();
}
function transactionType(value: unknown): CustomerTransactionInput['type'] {
  if (value !== 'income' && value !== 'expense')
    throw new CustomerFinanceError('Informe entrada ou saída.');
  return value;
}
function transactionStatus(value: unknown): CustomerTransactionInput['status'] {
  if (value !== 'pending' && value !== 'settled')
    throw new CustomerFinanceError('Informe pendente ou realizado.');
  return value;
}

function categoryWasNamed(categories: CustomerCategory[], explicit: unknown): boolean {
  const context = getExecContext();
  const request = context?.channelPluginId ? context.channelRequestText : undefined;
  if (!request) return true;
  const fold = (value: string) =>
    value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const name = fold(text(explicit, 'a categoria'));
  const matched = categories.find((c) => fold(c.name) === name || c.legacyKey === name);
  return [name, matched ? fold(matched.name) : '']
    .filter(Boolean)
    .some((term) => fold(request).includes(term));
}
function selectCategory(
  categories: CustomerCategory[],
  type: CustomerTransactionInput['type'],
  description: string,
  explicit: unknown
): CustomerCategory {
  const active = categories.filter((category) => category.type === type && !category.archived);
  const fold = (value: string) =>
    value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  if (explicit !== undefined) {
    const name = fold(text(explicit, 'a categoria'));
    const matched =
      active.find((c) => fold(c.name) === name) ?? active.find((c) => c.legacyKey === name);
    // A model-generated category is not a user override. Preserve explicit
    // portal/API categories and categories actually named in the chat request.
    const named = categoryWasNamed(active, explicit);
    if (named) {
      if (!matched)
        throw new CustomerFinanceError(
          'Não encontrei essa categoria ativa para esse tipo de lançamento.'
        );
      return matched;
    }
  }
  const inferred = type === 'expense' ? inferExpenseCategory(description) : 'other';
  const category =
    active.find((c) => c.legacyKey === inferred) ??
    active.find(
      (c) =>
        c.legacyKey === 'other' || c.name === (type === 'expense' ? 'Outros' : 'Outras entradas')
    ) ??
    active[0];
  if (!category) throw new CustomerFinanceError('Categoria compatível não encontrada.');
  return category;
}

async function validateSettlementDate(
  date: string,
  status: CustomerTransactionInput['status'],
  userId: string
): Promise<void> {
  validateCustomerFinanceDate(date);
  if (status !== 'settled') return;
  const account = await customerAccountsRepo.getByDataUserId(userId);
  const timestamp = getExecContext()?.channelMessageTimestamp;
  const at =
    typeof timestamp === 'number' && Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
  const today = customerLocalDay(at, account?.timeZone ?? 'America/Campo_Grande');
  if (date > today)
    throw new CustomerFinanceError(
      'Essa data ainda não chegou. Valores previstos devem ficar pendentes; confirme a data real do recebimento ou pagamento antes de registrar como realizado.'
    );
}

function privateToolMessage() {
  const ctx = getExecContext();
  const platform = /^channel\.(whatsapp|telegram)(?:[.-]|$)/u.exec(
    ctx?.channelPluginId ?? ''
  )?.[1] as 'whatsapp' | 'telegram' | undefined;
  if (
    !platform ||
    !ctx?.channelIsPrivate ||
    !ctx.channelPluginId ||
    !ctx.platformChatId ||
    !ctx.channelMessageId ||
    !ctx.channelMessageTimestamp
  )
    return null;
  return {
    id: ctx.channelMessageId,
    channelPluginId: ctx.channelPluginId,
    platformChatId: ctx.platformChatId,
    platform,
    sender: { platform, platformUserId: ctx.platformChatId, displayName: '' },
    timestamp: new Date(ctx.channelMessageTimestamp),
    metadata: { chatType: 'private' },
  };
}
async function rememberToolRead(userId: string, filter: FinanceSelectionFilter) {
  const message = privateToolMessage();
  if (!message) return;
  const account = await customerAccountsRepo.getByDataUserId(userId);
  const scope = financeSelectionScope(message, userId);
  // A model's preparatory lookup cannot erase an outstanding bulk review and
  // then use its IDs to perform unconfirmed individual deletions.
  try {
    if (
      scope &&
      (await financeBulkSelectionRepo.hasPreview(scope, customerAccountBinding(account)))
    )
      return;
  } catch {
    return;
  }
  await rememberFinanceRead(message, userId, filter, account);
}

async function rejectUnknownReadFilters(
  userId: string,
  args: Record<string, unknown>,
  keys: string[]
) {
  if (Object.keys(args).every((key) => keys.includes(key))) return;
  const message = privateToolMessage();
  const scope = message && financeSelectionScope(message, userId);
  if (scope && message) {
    const account = await customerAccountsRepo.getByDataUserId(userId);
    await financeBulkSelectionRepo.invalidateRead(
      scope,
      message.id,
      message.timestamp,
      customerAccountBinding(account)
    );
  }
  throw new CustomerFinanceError(
    'Não consegui aplicar todos os filtros dessa consulta. Nenhuma seleção foi autorizada para exclusão; refaça a consulta com tipo, período ou descrição.'
  );
}

export async function executeCustomerFinanceTool(
  toolName: string,
  args: Record<string, unknown>,
  userId?: string
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  if (!userId) return { success: false, error: 'Usuário autenticado obrigatório.' };
  const currentRequest = getExecContext()?.channelRequestText ?? '';
  if (
    ['record_transaction', 'update_transaction', 'delete_transaction'].includes(toolName) &&
    !(
      toolName === 'update_transaction' &&
      isOnlyRequestedFinanceMetadataUpdate(currentRequest, args, 'transaction_id')
    )
  ) {
    const refusal = financialWriteRefusal(currentRequest);
    if (refusal) return refusal;
  }
  if (isChannelEmailRequest(getExecContext()?.channelRequestText ?? ''))
    return {
      success: false,
      error: 'Seu pedido atual é sobre e-mails. Consulte a integração de e-mail para responder.',
    };
  if (
    toolName === 'delete_transaction' &&
    isBulkFinanceDeletionRequest(getExecContext()?.channelRequestText ?? '')
  )
    return {
      success: false,
      error:
        'A exclusão em lote precisa da revisão e confirmação na conversa. Nenhum item foi excluído por esta chamada.',
    };
  if (
    ['record_transaction', 'update_transaction', 'delete_transaction'].includes(toolName) &&
    isFinanceReadOnlyRequest(getExecContext()?.channelRequestText ?? '')
  )
    return {
      success: false,
      error:
        'Este pedido é apenas uma consulta. Use list_transactions ou financial_summary; não registre, altere ou exclua lançamentos.',
    };
  const repo = new CustomerFinanceRepository(userId);
  try {
    if (toolName === 'list_transactions') {
      await rejectUnknownReadFilters(userId, args, [
        'search',
        'type',
        'status',
        'from',
        'to',
        'page',
      ]);
      const query: CustomerTransactionQuery = { pageSize: 20 };
      if (args.search !== undefined) query.search = text(args.search, 'a busca');
      if (args.type !== undefined) query.type = transactionType(args.type);
      if (args.status !== undefined) query.status = transactionStatus(args.status);
      if (query.status === 'pending') query.sort = 'due';
      if (args.from !== undefined) query.from = text(args.from, 'o início');
      if (args.to !== undefined) query.to = text(args.to, 'o fim');
      if (args.page !== undefined) {
        if (typeof args.page !== 'number') throw new CustomerFinanceError('Página inválida.');
        query.page = args.page;
      }
      const result = await repo.listTransactions(query);
      await rememberToolRead(userId, {
        currency: 'BRL',
        ...(query.type && query.type !== 'all' ? { type: query.type } : {}),
        ...(query.status && query.status !== 'all' ? { status: query.status } : {}),
        from: query.from,
        to: query.to,
        search: query.search,
      });
      if (!result.transactions.length) return { success: true, result };
      const account = await customerAccountsRepo.getByDataUserId(userId);
      const timeZone = account?.timeZone ?? 'America/Campo_Grande';
      const clock = new Intl.DateTimeFormat('pt-BR', {
        timeZone,
        dateStyle: 'short',
        timeStyle: 'medium',
      });
      const transactions = result.transactions.map((item) => ({
        ...item,
        createdLocal: clock.format(new Date(item.createdAt)),
      }));
      return { success: true, result: { ...result, timeZone, transactions } };
    }
    if (toolName === 'financial_summary') {
      await rejectUnknownReadFilters(userId, args, ['from', 'to']);
      const summary = await repo.summary(text(args.from, 'o início'), text(args.to, 'o fim'));
      await rememberToolRead(userId, {
        currency: 'BRL',
        from: text(args.from, 'o início'),
        to: text(args.to, 'o fim'),
      });
      return {
        success: true,
        result: summary,
      };
    }
    if (toolName === 'record_transaction') {
      const ctx = getExecContext();
      if (!ctx?.channelMessageId || !ctx.channelPluginId || !ctx.platformChatId) {
        throw new CustomerFinanceError('Registro exige uma mensagem autenticada no canal.');
      }
      const type = transactionType(args.type);
      const status = transactionStatus(args.status);
      const description = text(args.description, 'a descrição');
      const date = text(args.date, 'a data');
      if (typeof args.amount !== 'number')
        throw new CustomerFinanceError('Informe o valor em reais.');
      await validateSettlementDate(date, status, userId);
      const category = selectCategory(
        await repo.listCategories(),
        type,
        description,
        args.category
      );
      // A retry keeps the original message/item identity even if the model
      // changes the description. The repository fingerprint rejects any changed
      // fields; only an explicit item list can authorize separate item slots.
      const identity = channelFinanceCreateIdentity(
        {
          userId,
          channelPluginId: ctx.channelPluginId,
          platformChatId: ctx.platformChatId,
          channelMessageId: ctx.channelMessageId,
          requestText: ctx.channelRequestText,
        },
        { description, amount: args.amount }
      );
      if (!identity.ok) throw new CustomerFinanceError(identity.message);
      const transaction = await repo.createTransaction(
        { description, amount: args.amount, type, status, date, categoryId: category.id },
        identity.key
      );
      return {
        success: true,
        result: {
          transaction,
          message: 'Lançamento registrado no financeiro. Isso não agenda um lembrete.',
        },
      };
    }
    if (toolName === 'update_transaction') {
      const id = text(args.transaction_id, 'o ID do lançamento');
      const current = await repo.getTransaction(id);
      if (!current) throw new CustomerFinanceError('Lançamento não encontrado.', 404);
      const patch: Partial<CustomerTransactionInput> = {};
      if (args.description !== undefined) patch.description = text(args.description, 'a descrição');
      if (args.date !== undefined) patch.date = text(args.date, 'a data');
      if (args.amount !== undefined) {
        if (typeof args.amount !== 'number') throw new CustomerFinanceError('Valor inválido.');
        patch.amount = args.amount;
      }
      if (args.status !== undefined) patch.status = transactionStatus(args.status);
      if (args.type !== undefined) patch.type = transactionType(args.type);
      if (args.category !== undefined || (patch.type && patch.type !== current.type)) {
        const categories = await repo.listCategories();
        if (
          (patch.type && patch.type !== current.type) ||
          categoryWasNamed(categories, args.category)
        )
          patch.categoryId = selectCategory(
            categories,
            patch.type ?? current.type,
            patch.description ?? current.description ?? '',
            args.category
          ).id;
      }
      if (!Object.keys(patch).length)
        throw new CustomerFinanceError('Informe a correção desejada.');
      await validateSettlementDate(
        patch.date ?? current.date,
        patch.status ?? current.status,
        userId
      );
      const transaction = await repo.updateTransaction(id, patch);
      // The record may have been removed after getTransaction by the portal
      // or another channel request. A null write is not a successful receipt.
      if (!transaction)
        throw new CustomerFinanceError(
          'Lançamento não encontrado. A alteração não foi salva.',
          404
        );
      return {
        success: true,
        result: { transaction, message: 'Lançamento atualizado, sem criar duplicata.' },
      };
    }
    if (toolName === 'delete_transaction') {
      const message = privateToolMessage();
      const scope = message && financeSelectionScope(message, userId);
      if (scope) {
        const account = await customerAccountsRepo.getByDataUserId(userId);
        if (await financeBulkSelectionRepo.hasPreview(scope, customerAccountBinding(account)))
          throw new CustomerFinanceError(
            'Há uma exclusão em lote aguardando confirmação. Confirme ou cancele esse pedido antes de remover um lançamento individual.'
          );
      }
      const id = text(args.transaction_id, 'o ID do lançamento');
      const deletes = getExecContext()?.channelFinanceDeletes;
      if (deletes?.size && !deletes.has(id))
        throw new CustomerFinanceError(
          'A exclusão de vários lançamentos exige revisão e confirmação em lote. Não remova outros itens por chamadas individuais.'
        );
      // Reserve before awaiting: nested/parallel calls cannot race into a
      // second deletion, and a replay of the same ID receives its real result.
      const deletion = deletes?.get(id) ?? repo.deleteTransaction(id);
      deletes?.set(id, deletion);
      if (!(await deletion)) throw new CustomerFinanceError('Lançamento não encontrado.', 404);
      return { success: true, result: { id, deleted: true } };
    }
    return { success: false, error: 'Ferramenta financeira desconhecida.' };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof CustomerFinanceError
          ? error.message
          : 'Não foi possível concluir a operação financeira. Consulte os registros antes de repetir.',
    };
  }
}
