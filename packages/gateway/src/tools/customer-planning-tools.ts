import type { ToolDefinition } from '@ownpilot/core/tools';
import { CustomerPlanningRepository } from '../db/repositories/customer-planning.js';

export const CUSTOMER_PLANNING_TOOLS: ToolDefinition[] = [
  {
    name: 'list_customer_subscriptions',
    category: 'Finance',
    brief: 'Consultar valor e renovação das assinaturas do próprio cliente',
    description:
      'Consulta o planejamento de assinaturas do cliente, o mesmo do painel. Use para conferir preço, nome e próxima renovação, inclusive após trocar de assunto. Não use list_transactions: pagamentos realizados são diferentes de assinaturas. search filtra o nome; omita para listar ou resolver uma referência do contexto. Se houver vários nomes possíveis, pergunte qual. Não invente assinaturas nem confunda a renovação cadastrada com cobrança confirmada ou cancelamento no fornecedor. Não altera dados.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Parte do nome da assinatura, até 120 caracteres.' },
        page: { type: 'integer', description: 'Página inteira a partir de 1, com 20 resultados.' },
      },
    },
  },
];

const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export async function executeCustomerPlanningTool(
  name: string,
  args: Record<string, unknown>,
  userId?: string
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  if (!userId?.trim()) return { success: false, error: 'Usuário autenticado obrigatório.' };
  if (name !== 'list_customer_subscriptions')
    return { success: false, error: 'Consulta de assinaturas indisponível.' };
  if (
    args.search !== undefined &&
    (typeof args.search !== 'string' || !args.search.trim() || args.search.length > 120)
  )
    return { success: false, error: 'Informe uma parte do nome da assinatura.' };
  const page = args.page ?? 1;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 100)
    return { success: false, error: 'Informe uma página inteira entre 1 e 100.' };
  try {
    const search = typeof args.search === 'string' ? fold(args.search) : '';
    const all = await new CustomerPlanningRepository(userId).subscriptions();
    const matches = search ? all.filter((plan) => fold(plan.title).includes(search)) : all;
    const start = (page - 1) * 20;
    return {
      success: true,
      result: {
        subscriptions: matches.slice(start, start + 20).map((plan) => ({
          title: plan.title,
          amount: plan.amount,
          currency: 'BRL',
          nextDueDate: plan.nextDueDate,
        })),
        total: matches.length,
        page,
        hasMore: start + 20 < matches.length,
        note: 'Planejamento cadastrado no Astra; não confirma cobrança, pagamento ou cancelamento no fornecedor.',
      },
    };
  } catch {
    return {
      success: false,
      error: 'Não consegui consultar suas assinaturas agora. Pode tentar novamente em instantes?',
    };
  }
}
