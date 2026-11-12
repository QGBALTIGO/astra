/** User-scoped tools for the same income/expense ledger used by the customer portal. */
import { createHash } from 'node:crypto';
import { getExecContext } from '@ownpilot/core/agent';
import type { ToolDefinition } from '@ownpilot/core/tools';
import {
  CustomerFinanceError,
  CustomerFinanceRepository,
  validateCustomerFinanceDate,
  type CustomerTransactionInput,
  type CustomerTransactionQuery,
} from '../db/repositories/customer-finance.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { customerLocalDay } from '../services/customer-date.js';

const fields = {
  description: { type: 'string', description: 'Descrição informada pelo usuário.' },
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
      'Consulta entradas, saídas e pendências do usuário. Use antes de corrigir/excluir; não invente IDs. IDs retornados são internos: não exiba nem peça ao usuário. Se houver vários resultados compatíveis, diferencie por descrição, valor e data e pergunte qual.',
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
      'Corrige pelo ID interno consultado: valor, descrição, data, entrada/saída e pendente/realizado. Para trocar despesa por entrada atualize type=income, não exclua e recrie. Não confirma recebimento quando o valor ainda está previsto. Na resposta use descrição, valor e data; nunca exiba ou peça o ID.',
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

export async function executeCustomerFinanceTool(
  toolName: string,
  args: Record<string, unknown>,
  userId?: string
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  if (!userId) return { success: false, error: 'Usuário autenticado obrigatório.' };
  const repo = new CustomerFinanceRepository(userId);
  try {
    if (toolName === 'list_transactions') {
      const query: CustomerTransactionQuery = { pageSize: 20 };
      if (args.search !== undefined) query.search = text(args.search, 'a busca');
      if (args.type !== undefined) query.type = transactionType(args.type);
      if (args.status !== undefined) query.status = transactionStatus(args.status);
      if (args.from !== undefined) query.from = text(args.from, 'o início');
      if (args.to !== undefined) query.to = text(args.to, 'o fim');
      if (args.page !== undefined) {
        if (typeof args.page !== 'number') throw new CustomerFinanceError('Página inválida.');
        query.page = args.page;
      }
      return { success: true, result: await repo.listTransactions(query) };
    }
    if (toolName === 'financial_summary') {
      return {
        success: true,
        result: await repo.summary(text(args.from, 'o início'), text(args.to, 'o fim')),
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
      const categories = await repo.listCategories();
      const category =
        categories.find(
          (c) =>
            c.type === type &&
            !c.archived &&
            c.name === (type === 'income' ? 'Outras entradas' : 'Outros')
        ) ?? categories.find((c) => c.type === type && !c.archived);
      if (!category) throw new CustomerFinanceError('Categoria compatível não encontrada.');
      // One requested financial item per native call. Replays with changed fields
      // conflict instead of creating a second row; distinct descriptions allow
      // explicitly itemised messages. Corrections must address the saved ID.
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            userId,
            ctx.channelPluginId,
            ctx.platformChatId,
            ctx.channelMessageId,
            description.normalize('NFC').toLocaleLowerCase('pt-BR'),
          ])
        )
        .digest('hex');
      const transaction = await repo.createTransaction(
        { description, amount: args.amount, type, status, date, categoryId: category.id },
        key
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
      if (args.type !== undefined) {
        patch.type = transactionType(args.type);
        if (patch.type !== current.type) {
          const categories = await repo.listCategories();
          const category =
            categories.find(
              (c) =>
                c.type === patch.type &&
                !c.archived &&
                c.name === (patch.type === 'income' ? 'Outras entradas' : 'Outros')
            ) ?? categories.find((c) => c.type === patch.type && !c.archived);
          if (!category) throw new CustomerFinanceError('Categoria compatível não encontrada.');
          patch.categoryId = category.id;
        }
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
      const id = text(args.transaction_id, 'o ID do lançamento');
      if (!(await repo.deleteTransaction(id)))
        throw new CustomerFinanceError('Lançamento não encontrado.', 404);
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
