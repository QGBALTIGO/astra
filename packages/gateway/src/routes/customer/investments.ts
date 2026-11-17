import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { apiError, apiResponse } from '../helpers.js';
import { getLog } from '../../services/log.js';
import {
  CustomerInvestmentError,
  CustomerInvestmentsRepository,
  MAX_INVESTMENT_BOOK_BYTES,
} from '../../db/repositories/customer-investments.js';
import { createBrAPIHandler } from '../../services/investments/brapi.js';

const log = getLog('CustomerInvestments');
const handleMarket = createBrAPIHandler();
const writeSchema = z
  .object({
    state: z.unknown(),
    expectedStorageVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const customerInvestmentRoutes = new Hono();

customerInvestmentRoutes.use('*', async (c, next) => {
  const customer = c.get('customer');
  if (!customer?.dataUserId?.trim() || customer.dataUserId === 'default')
    return apiError(c, { code: 'UNAUTHORIZED', message: 'Entre no Astra para continuar.' }, 401);
  const account = c.req.header('X-Astra-Account'),
    writing = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if ((account && account !== customer.accountId) || (writing && !account))
    return apiError(
      c,
      { code: 'CONFLICT', message: 'Sua sessão mudou. Atualize o painel antes de continuar.' },
      409
    );
  if (writing && !customer.access.canWrite)
    return apiError(
      c,
      {
        code: 'ACCESS_EXPIRED',
        message:
          'Renove o acesso para alterar sua carteira. Seus investimentos continuam disponíveis para consulta.',
      },
      403
    );
  c.header('Cache-Control', 'private, no-store');
  return next();
});
customerInvestmentRoutes.onError((error, c) => {
  if (error instanceof CustomerInvestmentError)
    return apiError(
      c,
      {
        code:
          error.status === 409
            ? 'CONFLICT'
            : error.status === 413
              ? 'PAYLOAD_TOO_LARGE'
              : error.status === 401
                ? 'UNAUTHORIZED'
                : 'INVALID_INPUT',
        message: error.message,
      },
      error.status
    );
  log.error('Falha nos investimentos pessoais', {
    category: error instanceof Error ? error.name : 'unknown',
  });
  return apiError(
    c,
    {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Não foi possível concluir agora. Seus registros anteriores foram preservados.',
    },
    503
  );
});
customerInvestmentRoutes.get('/book', async (c) =>
  apiResponse(c, await new CustomerInvestmentsRepository(c.get('customer').dataUserId).get())
);
customerInvestmentRoutes.put(
  '/book',
  bodyLimit({
    maxSize: MAX_INVESTMENT_BOOK_BYTES + 1024,
    onError: (c) =>
      apiError(
        c,
        { code: 'PAYLOAD_TOO_LARGE', message: 'O livro deve ter no máximo 10 MiB.' },
        413
      ),
  }),
  async (c) => {
    const parsed = writeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return apiError(
        c,
        { code: 'INVALID_INPUT', message: 'Confira o livro e a versão de armazenamento.' },
        400
      );
    return apiResponse(
      c,
      await new CustomerInvestmentsRepository(c.get('customer').dataUserId).save(
        parsed.data.state,
        parsed.data.expectedStorageVersion
      )
    );
  }
);
customerInvestmentRoutes.all('/market/*', async (c) => {
  const url = new URL(c.req.url);
  url.pathname =
    '/api/market/' + c.req.path.slice(c.req.path.lastIndexOf('/market/') + '/market/'.length);
  return handleMarket(new Request(url, { method: c.req.method, signal: c.req.raw.signal }), {
    BRAPI_TOKEN: process.env.BRAPI_TOKEN,
    BRAPI_MAX_SYMBOLS: process.env.BRAPI_MAX_SYMBOLS,
    BRAPI_PLAN_NAME: process.env.BRAPI_PLAN_NAME,
  });
});
