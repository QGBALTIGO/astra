/**
 * Owner-scoped financing tool definitions for natural-language requests that
 * do not match the deterministic WhatsApp fast path.
 */
import { createHash } from 'node:crypto';
import { getExecContext } from '@ownpilot/core/agent';
import type { ToolDefinition } from '@ownpilot/core/tools';
import {
  FinanceObligationsRepository,
  financeNameKey,
} from '../db/repositories/finance-obligations.js';
import {
  classifyFinancingPaymentAuthority,
  parseFinancingIntent,
} from '../channels/financing-intent.js';

export const FINANCING_TOOLS: ToolDefinition[] = [
  {
    name: 'create_financing',
    category: 'Finance',
    brief: 'Registrar dívida ou financiamento com valor total e valor já pago',
    description:
      'Cria um financiamento separado das despesas somente quando a mensagem atual do usuário informa nome, valor total e valor já pago. alreadyPaid é saldo histórico, nunca nova despesa. Uma correção de categoria ou um pagamento não autoriza criar financiamento nem inventar valores. Se faltarem dados, pergunte.',
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
      'Registra somente um novo pagamento confirmado na mensagem atual, com nome e valor exatos. Consulte financing_balance antes. Um total acumulado já pago ou uma correção de lançamento não é novo pagamento: peça esclarecimento. Salva dívida e despesa numa única transação; nunca registre a mesma quantia também como despesa separada.',
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

type FinancingValidationReason =
  | 'payment_confirmation_required'
  | 'historical_payment_requires_clarification'
  | 'financing_details_required'
  | 'request_mismatch'
  | 'financing_not_found'
  | 'payment_exceeds_balance'
  | 'payment_replay_conflict';

function refusal(reason: FinancingValidationReason, message: string) {
  return {
    success: false,
    result: {
      kind: 'financing_request_validation',
      reason,
      mutation: 'not_attempted',
      message,
    },
    error: message,
  };
}

function hasCurrentChannelRequest(context: ReturnType<typeof getExecContext>): boolean {
  return !!(
    context?.channelMessageId &&
    context.channelPluginId &&
    context.platformChatId &&
    context.channelRequestText?.trim() &&
    context.channelIsPrivate !== false &&
    !context.channelConversationOnly
  );
}

export async function executeFinancingTool(
  toolName: string,
  args: Record<string, unknown>,
  userId = ''
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
        const context = getExecContext();
        const request = hasCurrentChannelRequest(context)
          ? parseFinancingIntent(context!.channelRequestText!)
          : null;
        if (request?.kind !== 'create') {
          return refusal(
            'financing_details_required',
            'Para cadastrar o financiamento, informe o nome, o valor total e quanto já foi pago na mesma mensagem. Exemplo: "O valor do carro é 72 mil, já paguei 28 mil". Nenhum financiamento foi criado.'
          );
        }
        if (
          financeNameKey(name) !== financeNameKey(request.name) ||
          total !== request.principalCents ||
          paid !== request.openingCents
        ) {
          return refusal(
            'request_mismatch',
            'Os dados do financiamento não correspondem à sua mensagem. Confirme o nome, o valor total e o valor já pago; nenhum financiamento foi criado.'
          );
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
        if (amount === null || !hasCurrentChannelRequest(context)) {
          return refusal(
            'payment_confirmation_required',
            'Para registrar um pagamento novo, envie o valor pago e o nome do financiamento na conversa privada. Nenhum novo pagamento foi registrado.'
          );
        }
        const authority = classifyFinancingPaymentAuthority(context!.channelRequestText!);
        if (['historical', 'ambiguous', 'correction'].includes(authority.kind)) {
          return refusal(
            'historical_payment_requires_clarification',
            'Esse valor é o total que você já pagou do financiamento ou um pagamento novo? Confirme também o nome do financiamento. Nenhum novo pagamento foi registrado.'
          );
        }
        const parsed = parseFinancingIntent(context!.channelRequestText!);
        const payment =
          authority.kind === 'new_payment' ? authority : parsed?.kind === 'payment' ? parsed : null;
        if (!payment) {
          return refusal(
            'payment_confirmation_required',
            'Confirme um pagamento novo com valor e nome, por exemplo: "Paguei mais 500 do carro hoje". Nenhum novo pagamento foi registrado.'
          );
        }
        if (
          financeNameKey(name) !== financeNameKey(payment.name) ||
          amount !== payment.amountCents
        ) {
          return refusal(
            'request_mismatch',
            'O valor ou o financiamento não corresponde à sua mensagem. Confira esses dados; nenhum novo pagamento foi registrado.'
          );
        }
        const sourceKey = createHash('sha256')
          .update(
            [
              userId,
              context!.channelPluginId,
              context!.platformChatId,
              context!.channelMessageId,
            ].join('|')
          )
          .digest('hex');
        const result = await repo.recordPayment(
          name,
          amount,
          sourceKey,
          new Date(context!.channelMessageTimestamp ?? Date.now())
        );
        if (result.status === 'recorded' || result.status === 'duplicate') {
          return { success: true, result };
        }
        if (result.status === 'conflict') {
          return refusal(
            'payment_replay_conflict',
            'Esta mensagem já foi usada em outro pagamento. Confira o lançamento original antes de informar um novo pagamento.'
          );
        }
        if (result.status === 'missing') {
          return refusal(
            'financing_not_found',
            'Não encontrei esse financiamento. Informe o nome já cadastrado. Para cadastrar uma dívida nova, informe o nome, o valor total e quanto já foi pago.'
          );
        }
        return refusal(
          'payment_exceeds_balance',
          'O pagamento ultrapassa o saldo restante. Consulte o saldo e confirme o valor antes de registrar um pagamento novo.'
        );
      }
      default:
        return { success: false, error: 'Operação de financiamento desconhecida.' };
    }
  } catch {
    return {
      success: false,
      error:
        'Não foi possível confirmar a gravação do financiamento. Consulte o saldo e os lançamentos antes de tentar registrar o pagamento novamente.',
    };
  }
}
