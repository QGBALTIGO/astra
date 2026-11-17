import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { apiError, apiResponse } from '../helpers.js';
import { customerReferralsRepo, ReferralError } from '../../db/repositories/customer-referrals.js';
import { getRequestOrigin } from '../../utils/trusted-proxy.js';

const COOKIE = 'astra_referral_visit';
const COOKIE_PATH = '/api/v1/customer/referrals';
const codePattern = /^AST-[A-F0-9]{16}$/;
function failure(c: Context, error: unknown) {
  if (error instanceof ReferralError)
    return apiError(
      c,
      { code: 'REFERRAL_CONFLICT', message: error.message },
      error.status as 400 | 404 | 409 | 503
    );
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
    return apiError(
      c,
      {
        code: 'REFERRAL_DUPLICATE',
        message: 'Esta assinatura ou confirmação de pagamento já foi utilizada.',
      },
      409
    );
  return apiError(
    c,
    {
      code: 'REFERRAL_UNAVAILABLE',
      message: 'Não foi possível consultar as indicações. Tente novamente.',
    },
    503
  );
}
/** Must be mounted before the customer-session guard. Only public invitation redirects live here. */
export const publicCustomerReferralRoutes = new Hono();
publicCustomerReferralRoutes.get('/referrals/invite/:code', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  const code = c.req.param('code');
  if (!codePattern.test(code))
    return apiError(c, { code: 'NOT_FOUND', message: 'Convite não encontrado.' }, 404);
  try {
    const token = await customerReferralsRepo.visit(code, getCookie(c, COOKIE));
    if (!token) return apiError(c, { code: 'NOT_FOUND', message: 'Convite não encontrado.' }, 404);
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: COOKIE_PATH,
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect('/cliente/entrar?convite=1', 302);
  } catch (error) {
    return failure(c, error);
  }
});

/** Mounted behind the existing dedicated customer-session and same-origin guards. */
export const customerReferralRoutes = new Hono();
customerReferralRoutes.use('*', async (c, next) => {
  const customer = c.get('customer');
  if (!customer?.accountId)
    return apiError(c, { code: 'UNAUTHORIZED', message: 'Entre no Astra para continuar.' }, 401);
  const account = c.req.header('X-Astra-Account');
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if ((account && account !== customer.accountId) || (writing && !account))
    return apiError(
      c,
      { code: 'CONFLICT', message: 'Sua sessão mudou. Atualize o painel antes de continuar.' },
      409
    );
  c.header('Cache-Control', 'private, no-store');
  return next();
});

customerReferralRoutes.get('/', async (c) => {
  try {
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .safeParse(c.req.query('page') ?? '1');
    if (!page.success)
      return apiError(c, { code: 'INVALID_INPUT', message: 'Página inválida.' }, 400);
    const filter = z
      .enum(['all', 'progress', 'rewarded', 'ineligible'])
      .safeParse(c.req.query('filter') ?? 'all');
    if (!filter.success)
      return apiError(c, { code: 'INVALID_INPUT', message: 'Filtro inválido.' }, 400);
    const dashboard = await customerReferralsRepo.dashboard(
      c.get('customer').accountId,
      page.data,
      filter.data
    );
    return apiResponse(c, {
      ...dashboard,
      link: `${getRequestOrigin(c.req)}/api/v1/customer/referrals/invite/${dashboard.code}`,
    });
  } catch (error) {
    return failure(c, error);
  }
});
customerReferralRoutes.post('/claim', async (c) => {
  const token = getCookie(c, COOKIE);
  if (!token) return apiResponse(c, { claimed: false });
  try {
    const claimed = await customerReferralsRepo.claim(token, c.get('customer').accountId);
    deleteCookie(c, COOKIE, { httpOnly: true, secure: true, sameSite: 'Lax', path: COOKIE_PATH });
    return apiResponse(c, { claimed });
  } catch (error) {
    return failure(c, error);
  }
});
const payoutSchema = z
  .object({
    pixKey: z
      .string()
      .trim()
      .min(3)
      .max(140)
      .regex(/^[^\p{Cc}\p{Cf}<>]+$/u),
  })
  .strict();
customerReferralRoutes.post('/:id/payout', async (c) => {
  if (!c.get('customer').access.canWrite)
    return apiError(
      c,
      { code: 'ACCESS_DENIED', message: 'Renove seu acesso para solicitar o pagamento.' },
      403
    );
  const input = payoutSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success || !z.string().uuid().safeParse(c.req.param('id')).success)
    return apiError(
      c,
      { code: 'INVALID_INPUT', message: 'Confira a indicação e sua chave Pix.' },
      400
    );
  try {
    return apiResponse(c, {
      record: await customerReferralsRepo.requestPayout(
        c.get('customer').accountId,
        c.req.param('id'),
        input.data.pixKey
      ),
    });
  } catch (error) {
    return failure(c, error);
  }
});
