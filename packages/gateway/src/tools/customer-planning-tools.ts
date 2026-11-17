import type { ToolDefinition } from '@ownpilot/core/tools';
import { getExecContext } from '@ownpilot/core/agent';
import { createHash } from 'node:crypto';
import { z, ZodError } from 'zod';
import {
  CustomerPlanningRepository,
  type CustomerGoalChange,
  type CustomerPlan,
} from '../db/repositories/customer-planning.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { channelUsersRepo } from '../db/repositories/channels/users.js';
import { isChannelUserAccessActive } from '../channels/channel-access-service.js';
import {
  customerMoneyCents,
  validateCustomerFinanceDate,
} from '../db/repositories/customer-finance.js';
import { formatAstraMessage } from '../channels/response-presentation.js';

const goalFields = {
  title: { type: 'string', description: 'Nome da meta financeira informado pela pessoa.' },
  amount: {
    type: 'number',
    description:
      'Valor total da meta em reais, positivo, até duas casas decimais. Pergunte se não foi informado.',
  },
  progress: {
    type: 'number',
    description:
      'Total já guardado em reais, NÃO percentual nem aporte adicional. Para somar um aporte, consulte primeiro o total atual.',
  },
  nextDueDate: {
    type: 'string',
    description: 'Prazo opcional YYYY-MM-DD, somente se informado.',
  },
  notes: { type: 'string', description: 'Observação opcional, até 500 caracteres.' },
} as const;

export const CUSTOMER_PLANNING_TOOLS: ToolDefinition[] = [
  {
    name: 'list_customer_goals',
    category: 'Finance',
    brief: 'Consultar metas financeiras do painel',
    description:
      'Consulta as metas financeiras da própria pessoa, com valor-alvo e valor guardado em reais, no mesmo painel. Consulte antes de atualizar ou excluir e use apenas IDs retornados. Não confunda com metas pessoais em percentual. Não invente valores. Se houver mais de uma meta possível, pergunte qual.',
    parameters: { type: 'object', properties: { search: { type: 'string' } } },
  },
  {
    name: 'create_customer_goal',
    category: 'Finance',
    brief: 'Salvar meta financeira no painel',
    description:
      'Cria uma meta financeira no mesmo painel. Exige nome e valor-alvo explícitos. Progresso é o total guardado em reais, nunca percentual. Não faz transferência, não registra despesa nem investe dinheiro. Uma criação por mensagem; peça outra mensagem para outra meta.',
    parameters: { type: 'object', properties: goalFields, required: ['title', 'amount'] },
  },
  {
    name: 'update_customer_goal',
    category: 'Finance',
    brief: 'Atualizar meta e valor guardado',
    description:
      'Altera a meta financeira consultada pelo ID. progress substitui o total guardado em reais; não é incremento nem percentual. Para um aporte, consulte o total e calcule o novo valor. Não altera o financeiro nem movimenta dinheiro. Nunca invente um ID ou valor.',
    parameters: {
      type: 'object',
      properties: { goal_id: { type: 'string' }, ...goalFields },
      required: ['goal_id'],
    },
  },
  {
    name: 'delete_customer_goal',
    category: 'Finance',
    brief: 'Excluir a meta financeira solicitada',
    description:
      'Exclui somente a meta consultada e pedida pela pessoa. Não exclui transações nem movimenta dinheiro. Use o ID interno retornado pela consulta e não o exponha ao usuário.',
    parameters: {
      type: 'object',
      properties: { goal_id: { type: 'string' } },
      required: ['goal_id'],
    },
  },
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

const goalMoney = z
  .number()
  .finite()
  .refine((value) => {
    try {
      return customerMoneyCents(value) > 0;
    } catch {
      return false;
    }
  }, 'Informe um valor positivo em reais com até duas casas decimais.');
const goalSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    amount: goalMoney,
    progress: z.union([z.literal(0), goalMoney]).optional(),
    nextDueDate: z
      .string()
      .refine((value) => {
        try {
          validateCustomerFinanceDate(value);
          return true;
        } catch {
          return false;
        }
      }, 'Informe uma data válida no formato YYYY-MM-DD.')
      .nullable()
      .optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
const goalId = z.string().trim().min(1).max(160);
const money = (value: number) =>
  value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const goalLabel = (value: string) => value.replace(/[\r\n*_`<>]/g, ' ').trim();
function goalFacts(plan: CustomerPlan) {
  return {
    id: plan.id,
    title: plan.title,
    amount: plan.amount,
    progress: plan.progress,
    currency: 'BRL',
    nextDueDate: plan.nextDueDate,
  };
}
function goalReply(title: string, plan: CustomerPlan) {
  return formatAstraMessage(
    title,
    [
      { label: 'Meta', value: goalLabel(plan.title) },
      { label: 'Objetivo', value: money(plan.amount) },
      { label: 'Guardado', value: money(plan.progress) },
    ],
    'Os valores são os mesmos da seção Metas no painel. Nenhum dinheiro foi movimentado.'
  );
}

async function executeGoal(name: string, args: Record<string, unknown>, userId: string) {
  try {
    if (userId === 'default')
      return { success: false, error: 'Entre na sua conta para acessar suas metas.' };
    const account = await customerAccountsRepo.getByDataUserId(userId);
    if (!account || account.dataUserId !== userId)
      return { success: false, error: 'Vincule sua conversa à sua conta para acessar suas metas.' };
    const repo = new CustomerPlanningRepository(userId);
    if (name === 'list_customer_goals') {
      const { search } = z
        .object({ search: z.string().trim().min(1).max(120).optional() })
        .strict()
        .parse(args);
      const goals = (await repo.goals()).filter(
        (plan) => !search || fold(plan.title).includes(fold(search))
      );
      const reply = goals.length
        ? formatAstraMessage(
            '🎯 Suas metas financeiras',
            goals.map((plan) => ({
              label: goalLabel(plan.title),
              value: `${money(plan.progress)} guardados de ${money(plan.amount)}`,
            }))
          )
        : 'Não encontrei metas financeiras com esses dados no painel.';
      return {
        success: true,
        result: { kind: 'customer_goal', goals: goals.map(goalFacts), reply },
      };
    }
    const ctx = getExecContext();
    if (!ctx?.channelPluginId || !ctx.platformChatId || !ctx.channelMessageId)
      return { success: false, error: 'Envie o pedido de meta pela sua conversa autenticada.' };
    let change: CustomerGoalChange;
    if (name === 'create_customer_goal') change = { action: 'create', ...goalSchema.parse(args) };
    else if (name === 'update_customer_goal') {
      const { goal_id, ...fields } = goalSchema
        .partial()
        .extend({ goal_id: goalId })
        .strict()
        .parse(args);
      if (!Object.keys(fields).length)
        return { success: false, error: 'Informe o que deseja alterar na meta.' };
      change = { action: 'update', id: goal_id, ...fields };
    } else {
      const { goal_id } = z.object({ goal_id: goalId }).strict().parse(args);
      change = { action: 'remove', id: goal_id };
    }
    const requestKey = createHash('sha256')
      .update(
        JSON.stringify([
          userId,
          ctx.channelPluginId,
          ctx.platformChatId,
          ctx.channelMessageId,
          name,
          'id' in change ? change.id : '',
        ])
      )
      .digest('hex');
    const changed = await repo.changeGoal(requestKey, change, async () => {
      const grant = await channelUsersRepo.getById(account.channelUserId);
      return Boolean(grant && isChannelUserAccessActive(grant));
    });
    if (changed.status === 'replay')
      return {
        success: true,
        result: {
          kind: 'customer_goal',
          replayed: true,
          goal: changed.plan ? goalFacts(changed.plan) : null,
          reply: changed.plan
            ? goalReply('ℹ️ Pedido já processado · estado atual', changed.plan)
            : 'Esse pedido de meta já foi processado. A meta não está mais disponível no painel; não criei outro registro.',
        },
      };
    if ('plan' in changed) {
      const title = {
        created: '🎯 Meta salva',
        updated: '🎯 Meta atualizada',
        removed: '🗑️ Meta excluída',
      }[changed.status];
      return {
        success: true,
        result: {
          kind: 'customer_goal',
          goal: goalFacts(changed.plan),
          reply:
            changed.status === 'removed'
              ? `Meta “${goalLabel(changed.plan.title)}” excluída do painel. Nenhum dinheiro foi movimentado.`
              : goalReply(title, changed.plan),
        },
      };
    }
    const errors = {
      missing: 'Não encontrei essa meta na sua conta. Consulte suas metas novamente.',
      conflict:
        'Essa mensagem já teve outro pedido de meta processado. Confira o painel e envie uma nova mensagem para outra alteração.',
      limit: 'Você atingiu o limite de 80 planejamentos. Revise os existentes no painel.',
      inactive: 'Seu acesso permite consultas. Renove para alterar suas metas.',
    };
    return { success: false, error: errors[changed.status] };
  } catch (error) {
    if (error instanceof ZodError)
      return {
        success: false,
        error:
          'Confira o nome, o valor em reais e o prazo da meta. O valor guardado é o total, não um percentual.',
      };
    if (
      error instanceof Error &&
      /^(?:O valor guardado|Valor guardado|Limite de 80)/.test(error.message)
    )
      return { success: false, error: error.message };
    return {
      success: false,
      error:
        'Não consegui confirmar essa operação de meta agora. Confira o painel antes de tentar novamente.',
    };
  }
}

export async function executeCustomerPlanningTool(
  name: string,
  args: Record<string, unknown>,
  userId?: string
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  if (!userId?.trim()) return { success: false, error: 'Usuário autenticado obrigatório.' };
  if (
    [
      'list_customer_goals',
      'create_customer_goal',
      'update_customer_goal',
      'delete_customer_goal',
    ].includes(name)
  )
    return executeGoal(name, args, userId);
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
