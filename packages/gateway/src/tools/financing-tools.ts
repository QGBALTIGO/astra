/**
 * Owner-scoped financing tool definitions for natural-language requests that
 * do not match the deterministic WhatsApp fast path.
 */
import { createHash } from 'node:crypto';
import { getExecContext } from '@ownpilot/core/agent';
import type { ToolDefinition } from '@ownpilot/core/tools';
import { FinanceObligationsRepository } from '../db/repositories/finance-obligations.js';

export const FINANCING_TOOLS: ToolDefinition[] = [
  {
    name: 'create_financing',
    category: 'Finance',
    brief: 'Registrar dívida ou financiamento com valor total e valor já pago',
    description:
      'Cria um financiamento separado das despesas. alreadyPaid é um saldo histórico, não é uma nova despesa. Nunca invente o valor total ou quanto já foi pago.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome curto do financiamento, ex.: carro' },
        total: { type: 'number', description: 'Valor total em reais' },
        alreadyPaid: { type: 'number', description: 'Valor acumulado já pago em reais' },
      },
      required: ['name', 'total', 'alreadyPaid'],
    },
  },
  {
    name: 'financing_balance',
    category: 'Finance',
    brief: 'Consultar quanto foi pago e quanto falta pagar do financiamento',
    description: 'Consulta saldo real do financiamento individual do usuário.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Nome do financiamento' } },
      required: ['name'],
    },
  },
  {
    name: 'record_financing_payment',
    category: 'Finance',
    brief: 'Registrar um pagamento confirmado e abater do financiamento',
    description:
      'Só registre se o usuário informou um pagamento já realizado, nunca previsão nem promessa de pagamento. Salva o pagamento na dívida e nas despesas numa única transação.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome do financiamento' },
        amount: { type: 'number', description: 'Valor que foi efetivamente pago, em reais' },
      },
      required: ['name', 'amount'],
    },
  },
];

function amountToCents(value: unknown, allowZero = false): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 9_000_000_000_000) return null;
  if (!allowZero && cents === 0) return null;
  return Math.abs(value * 100 - cents) < 1e-6 ? cents : null;
}

export async function executeFinancingTool(
  toolName: string,
  args: Record<string, unknown>,
  userId = 'default'
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name || !userId) {
    return { success: false, error: 'Informe o nome do financiamento.' };
  }
  try {
    const repo = new FinanceObligationsRepository(userId);
    switch (toolName) {
      case 'create_financing': {
        const total = amountToCents(args.total);
        const paid = amountToCents(args.alreadyPaid, true);
        if (total === null || paid === null || paid > total) {
          return { success: false, error: 'Informe valores válidos para total e já pago.' };
        }
        const result = await repo.createOrFind(name, total, paid);
        return { success: true, result };
      }
      case 'financing_balance': {
        const balance = await repo.find(name);
        return balance
          ? { success: true, result: balance }
          : { success: false, error: 'Financiamento não encontrado.' };
      }
      case 'record_financing_payment': {
        const amount = amountToCents(args.amount);
        const context = getExecContext();
        if (
          amount === null ||
          !context?.channelMessageId ||
          !context.channelPluginId ||
          !context.platformChatId
        ) {
          return {
            success: false,
            error: 'Pagamento exige valor válido e confirmação pelo canal autenticado.',
          };
        }
        const sourceKey = createHash('sha256')
          .update(
            [userId, context.channelPluginId, context.platformChatId, context.channelMessageId].join(
              '|'
            )
          )
          .digest('hex');
        const result = await repo.recordPayment(name, amount, sourceKey);
        return result.status === 'recorded' || result.status === 'duplicate'
          ? { success: true, result }
          : {
              success: false,
              error:
                result.status === 'missing'
                  ? 'Financiamento não encontrado.'
                  : 'O pagamento ultrapassa o saldo restante.',
            };
      }
      default:
        return { success: false, error: 'Operação de financiamento desconhecida.' };
    }
  } catch {
    return {
      success: false,
      error: 'Não foi possível confirmar a gravação do financiamento. Tente novamente.',
    };
  }
}
