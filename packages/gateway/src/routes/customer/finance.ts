/** Customer finance APIs. Identity is supplied only by customer-session middleware. */
import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';
import {
  CustomerFinanceError,
  CustomerFinanceRepository,
  customerMoneyCents,
  validateCustomerFinanceDate,
} from '../../db/repositories/customer-finance.js';
import { apiResponse, apiError } from '../helpers.js';
import { getLog } from '../../services/log.js';

const log = getLog('CustomerFinanceRoutes');
type CustomerFinanceEnv = { Variables: { customer: CustomerSessionContext } };
const transactionSchema = z
  .object({
    description: z.string().trim().min(1).max(160),
    amount: z
      .number()
      .finite()
      .positive()
      .refine((value) => {
        try {
          customerMoneyCents(value);
          return true;
        } catch {
          return false;
        }
      }, 'Informe um valor com no máximo duas casas decimais.'),
    type: z.enum(['income', 'expense']),
    status: z.enum(['settled', 'pending']),
    categoryId: z.string().min(1).max(160),
    date: z.string().refine((value) => {
      try {
        validateCustomerFinanceDate(value);
        return true;
      } catch {
        return false;
      }
    }, 'Data inválida.'),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
const transactionPatch = transactionSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Informe uma alteração.');
const categorySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(['income', 'expense']),
    color: z.string().regex(/^#[a-f\d]{6}$/i),
  })
  .strict();
const categoryPatch = categorySchema
  .omit({ type: true })
  .partial()
  .extend({ archived: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Informe uma alteração.');
const listQuery = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    type: z.enum(['all', 'income', 'expense']).optional(),
    status: z.enum(['all', 'settled', 'pending']).optional(),
    categoryId: z.string().min(1).max(160).optional(),
    search: z.string().max(160).optional(),
    page: z.coerce.number().int().min(1).max(100_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

async function body(request: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new CustomerFinanceError('O corpo da solicitação deve ser um JSON válido.');
  }
}

export function currentCustomerFinancePeriod(
  timeZone: string,
  now = new Date()
): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')!.value;
  const month = parts.find((part) => part.type === 'month')!.value;
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return {
    from: `${year}-${month}-01`,
    to: `${year}-${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

export const customerFinanceRoutes = new Hono<CustomerFinanceEnv>();

customerFinanceRoutes.use('*', async (c, next) => {
  const customer = c.get('customer');
  if (!customer?.dataUserId?.trim())
    return apiError(
      c,
      { code: 'UNAUTHORIZED', message: 'Entre na sua conta para continuar.' },
      401
    );
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && customer.access.canWrite !== true) {
    return apiError(
      c,
      {
        code: 'FORBIDDEN',
        message: 'Seu acesso está disponível para consulta. Renove para alterar os registros.',
      },
      403
    );
  }
  return next();
});

customerFinanceRoutes.onError((error, c) => {
  if (error instanceof CustomerFinanceError) {
    return apiError(
      c,
      {
        code:
          error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'CONFLICT' : 'INVALID_INPUT',
        message: error.message,
      },
      error.status
    );
  }
  if (error instanceof ZodError) {
    return apiError(
      c,
      { code: 'INVALID_INPUT', message: 'Confira os campos e filtros informados.' },
      400
    );
  }
  if ('code' in error && error.code === '23505') {
    return apiError(
      c,
      {
        code: 'CONFLICT',
        message: 'Já existe um registro com esses dados. Atualize a página e tente novamente.',
      },
      409
    );
  }
  log.error('Falha na operação financeira do cliente', { category: error.name });
  return apiError(
    c,
    {
      code: 'INTERNAL_ERROR',
      message: 'Não foi possível concluir a operação financeira. Tente novamente.',
    },
    500
  );
});

customerFinanceRoutes.get('/summary', async (c) => {
  const query = z
    .object({ from: z.string().optional(), to: z.string().optional() })
    .strict()
    .parse(c.req.query());
  const customer = c.get('customer');
  const period = currentCustomerFinancePeriod(customer.timeZone);
  const summary = await new CustomerFinanceRepository(customer.dataUserId).summary(
    query.from ?? period.from,
    query.to ?? period.to
  );
  return apiResponse(c, summary);
});

customerFinanceRoutes.get('/transactions', async (c) => {
  const query = listQuery.parse(c.req.query());
  const result = await new CustomerFinanceRepository(c.get('customer').dataUserId).listTransactions(
    query
  );
  return apiResponse(c, result);
});

customerFinanceRoutes.get('/transactions/:id', async (c) => {
  const transaction = await new CustomerFinanceRepository(
    c.get('customer').dataUserId
  ).getTransaction(c.req.param('id'));
  if (!transaction) throw new CustomerFinanceError('Lançamento não encontrado.', 404);
  return apiResponse(c, { transaction });
});

customerFinanceRoutes.post('/transactions', async (c) => {
  const input = transactionSchema.parse(await body(c.req));
  const transaction = await new CustomerFinanceRepository(
    c.get('customer').dataUserId
  ).createTransaction(input, c.req.header('Idempotency-Key'));
  return apiResponse(c, { transaction }, 201);
});

customerFinanceRoutes.patch('/transactions/:id', async (c) => {
  const input = transactionPatch.parse(await body(c.req));
  const transaction = await new CustomerFinanceRepository(
    c.get('customer').dataUserId
  ).updateTransaction(c.req.param('id'), input);
  if (!transaction) throw new CustomerFinanceError('Lançamento não encontrado.', 404);
  return apiResponse(c, { transaction });
});

customerFinanceRoutes.delete('/transactions/:id', async (c) => {
  const deleted = await new CustomerFinanceRepository(
    c.get('customer').dataUserId
  ).deleteTransaction(c.req.param('id'));
  if (!deleted) throw new CustomerFinanceError('Lançamento não encontrado.', 404);
  return apiResponse(c, { deleted: true });
});

customerFinanceRoutes.get('/categories', async (c) => {
  const categories = await new CustomerFinanceRepository(
    c.get('customer').dataUserId
  ).listCategories();
  return apiResponse(c, { categories });
});

customerFinanceRoutes.post('/categories', async (c) => {
  const input = categorySchema.parse(await body(c.req));
  const category = await new CustomerFinanceRepository(c.get('customer').dataUserId).createCategory(
    input,
    c.req.header('Idempotency-Key')
  );
  return apiResponse(c, { category }, 201);
});

customerFinanceRoutes.patch('/categories/:id', async (c) => {
  const input = categoryPatch.parse(await body(c.req));
  const category = await new CustomerFinanceRepository(c.get('customer').dataUserId).updateCategory(
    c.req.param('id'),
    input
  );
  if (!category) throw new CustomerFinanceError('Categoria não encontrada.', 404);
  return apiResponse(c, { category });
});

customerFinanceRoutes.delete('/categories/:id', async (c) => {
  const raw = await c.req.text();
  let input: unknown = {};
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      throw new CustomerFinanceError('Informe uma solicitação JSON válida.');
    }
  }
  const { transferToId } = z
    .object({ transferToId: z.string().min(1).max(160).optional() })
    .strict()
    .parse(input);
  const query = z
    .object({ transferToId: z.string().min(1).max(160).optional() })
    .strict()
    .parse(c.req.query());
  if (transferToId && query.transferToId && transferToId !== query.transferToId)
    throw new CustomerFinanceError('Informe apenas uma categoria de destino.');
  const result = await new CustomerFinanceRepository(c.get('customer').dataUserId).deleteCategory(
    c.req.param('id'),
    transferToId ?? query.transferToId
  );
  if (!result) throw new CustomerFinanceError('Categoria não encontrada.', 404);
  return apiResponse(c, result);
});
