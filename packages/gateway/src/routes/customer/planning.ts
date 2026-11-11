/** Authenticated customer plans. Never trust a user ID from request JSON. */
import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
import { customerMoneyCents, validateCustomerFinanceDate } from '../../db/repositories/customer-finance.js';
import { CustomerPlanningRepository } from '../../db/repositories/customer-planning.js';
import { apiError, apiResponse } from '../helpers.js';
import { getLog } from '../../services/log.js';

const log = getLog('CustomerPlanning');
type Env = { Variables: { customer: CustomerSessionContext } };
export const customerPlanningRoutes = new Hono<Env>();

const money = z.number().finite().min(0).refine(
  (value) => Number.isSafeInteger(Math.round(value * 100)) &&
    Math.round(value * 100) / 100 === value && value <= 9_999_999_999.99,
  'Informe valores em reais com até duas casas decimais.'
);
const inputSchema = z
  .object({
    kind: z.enum(['goal', 'budget', 'installment', 'subscription']),
    title: z.string().trim().min(1).max(120),
    amount: money.positive(),
    progress: money.optional(),
    categoryId: z.string().trim().max(160).nullable().optional(),
    installmentsTotal: z.number().int().min(1).max(360).nullable().optional(),
    installmentsPaid: z.number().int().min(0).max(360).nullable().optional(),
    nextDueDate: z.string().refine((value) => {
      try {
        validateCustomerFinanceDate(value);
        return true;
      } catch {
        return false;
      }
    }, 'Data inválida.').nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'budget' && !value.categoryId) {
      ctx.addIssue({ code: 'custom', message: 'Escolha uma categoria.', path: ['categoryId'] });
    }
    if (value.kind === 'goal' && (value.progress ?? 0) > value.amount) {
      ctx.addIssue({ code: 'custom', message: 'O valor guardado ultrapassa a meta.', path: ['progress'] });
    }
    if (value.kind === 'installment' && (
      value.installmentsTotal == null || value.installmentsPaid == null ||
      value.installmentsPaid > value.installmentsTotal
    )) {
      ctx.addIssue({ code: 'custom', message: 'Confira o total e as parcelas pagas.', path: ['installmentsPaid'] });
    }
    if (value.kind !== 'installment' &&
      (value.installmentsTotal != null || value.installmentsPaid != null)) {
      ctx.addIssue({ code: 'custom', message: 'Parcelas só valem para financiamentos.' });
    }
    if (value.kind !== 'goal' && (value.progress ?? 0) !== 0) {
      ctx.addIssue({ code: 'custom', message: 'Apenas metas possuem saldo guardado.' });
    }
  });

customerPlanningRoutes.use('*', async (c, next) => {
  const customer = c.get('customer');
  if (!customer?.dataUserId?.trim()) {
    return apiError(c, { code: 'UNAUTHORIZED', message: 'Entre no Astra para continuar.' }, 401);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && customer.access.canWrite !== true) {
    return apiError(c, {
      code: 'FORBIDDEN',
      message: 'Seu acesso permite consultas. Renove para editar seus planejamentos.',
    }, 403);
  }
  return next();
});

customerPlanningRoutes.onError((error, c) => {
  if (error instanceof ZodError) {
    return apiError(c, {
      code: 'INVALID_INPUT',
      message: 'Confira nome, valores, datas, categoria e parcelas do planejamento.',
    }, 400);
  }
  if (error instanceof Error &&
      /inválid|limite|valor|parcelas|categoria|planejamento|data/i.test(error.message) &&
      !('code' in error)) {
    return apiError(c, { code: 'INVALID_INPUT', message: error.message }, 400);
  }
  log.error('Falha ao consultar planejamento pessoal', {
    category: error instanceof Error ? error.name : 'unknown',
  });
  return apiError(c, {
    code: 'INTERNAL_ERROR',
    message: 'Não foi possível salvar o planejamento. Tente novamente.',
  }, 500);
});

customerPlanningRoutes.get('/', async (c) =>
  apiResponse(c, {
    plans: await new CustomerPlanningRepository(c.get('customer').dataUserId).list(),
  })
);

customerPlanningRoutes.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return apiError(c, {
    code: 'INVALID_INPUT', message: 'Informe um planejamento válido.',
  }, 400); }
  const input = inputSchema.parse(body);
  customerMoneyCents(input.amount);
  const plan = await new CustomerPlanningRepository(c.get('customer').dataUserId).create(input);
  return apiResponse(c, { plan }, 201);
});

customerPlanningRoutes.patch('/:id', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return apiError(c, {
    code: 'INVALID_INPUT', message: 'Informe um planejamento válido.',
  }, 400); }
  const input = inputSchema.parse(body);
  const plan = await new CustomerPlanningRepository(c.get('customer').dataUserId)
    .update(c.req.param('id'), input);
  if (!plan) return apiError(c, { code: 'NOT_FOUND', message: 'Planejamento não encontrado.' }, 404);
  return apiResponse(c, { plan });
});

customerPlanningRoutes.delete('/:id', async (c) => {
  const deleted = await new CustomerPlanningRepository(c.get('customer').dataUserId)
    .delete(c.req.param('id'));
  if (!deleted) return apiError(c, { code: 'NOT_FOUND', message: 'Planejamento não encontrado.' }, 404);
  return apiResponse(c, { deleted });
});
