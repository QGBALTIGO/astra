/** Manual subscription validation and Pix reconciliation. Mount only on the owner API. */
import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { referralAdminConsole } from './referrals-admin-console.js';
import { z } from 'zod';
import { apiError, apiResponse } from './helpers.js';
import {
  customerReferralsRepo,
  referralTokenHash,
  ReferralError,
} from '../db/repositories/customer-referrals.js';
import { validateUiSessionForRequest } from '../utils/ui-session-response.js';
import { getUiSessionAuth } from '../utils/ui-session-cookie.js';
import { requireCustomerRequestOrigin } from '../middleware/customer-session.js';

declare module 'hono' {
  interface ContextVariableMap {
    referralConsoleNonce?: string;
  }
}

/** Reapply only the authenticated console policy after the outer security middleware. */
export function finalizeReferralConsoleHeaders(c: Context): void {
  const nonce = c.get('referralConsoleNonce');
  if (!nonce) return;
  c.header('Cache-Control', 'no-store');
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
  );
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
}

export const referralsAdminRoutes = new Hono();
referralsAdminRoutes.use('*', requireCustomerRequestOrigin);
referralsAdminRoutes.use('*', async (c, next) => {
  const auth = getUiSessionAuth(c);
  const authenticated = auth.token ? await validateUiSessionForRequest(c, auth.token) : false;
  if (authenticated instanceof Response) return authenticated;
  if (!authenticated)
    return apiError(
      c,
      { code: 'UNAUTHORIZED', message: 'Entre na conta de administração para revisar indicações.' },
      401
    );
  // Customer cookies and implicit/passwordless owner access never authorize money decisions.
  return next();
});
referralsAdminRoutes.get('/console', (c) => {
  const nonce = randomBytes(18).toString('base64');
  c.set('referralConsoleNonce', nonce);
  finalizeReferralConsoleHeaders(c);
  return c.html(referralAdminConsole(nonce));
});
const statuses = z.enum(['registered', 'approved', 'requested', 'paid', 'rejected']);
referralsAdminRoutes.get('/', async (c) => {
  const status = c.req.query('status');
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .safeParse(c.req.query('page') ?? '1');
  if ((status && !statuses.safeParse(status).success) || !page.success)
    return apiError(c, { code: 'INVALID_INPUT', message: 'Situação ou página inválida.' }, 400);
  try {
    const selected = status as z.infer<typeof statuses> | undefined;
    const [records, total] = await Promise.all([
      customerReferralsRepo.operatorList(selected, page.data),
      customerReferralsRepo.operatorCount(selected),
    ]);
    return apiResponse(c, { records, total, page: page.data, pageSize: 50 });
  } catch {
    return apiError(
      c,
      { code: 'REFERRAL_UNAVAILABLE', message: 'Não foi possível carregar as indicações.' },
      503
    );
  }
});
const actionSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'paid']),
    reference: z.string().trim().max(160).default(''),
    note: z.string().trim().min(5).max(500),
  })
  .strict();
referralsAdminRoutes.post('/:id/review', async (c) => {
  const input = actionSchema.safeParse(await c.req.json().catch(() => null));
  const id = c.req.param('id');
  if (
    !input.success ||
    !z.string().uuid().safeParse(id).success ||
    (input.data.action !== 'reject' && input.data.reference.length < 5)
  )
    return apiError(
      c,
      {
        code: 'INVALID_INPUT',
        message: 'Informe a ação, a justificativa e a referência da assinatura ou do Pix.',
      },
      400
    );
  try {
    const actor = `owner-session:${referralTokenHash(getUiSessionAuth(c).token!).slice(0, 20)}`;
    return apiResponse(c, {
      record: await customerReferralsRepo.operatorAction(
        id,
        input.data.action,
        input.data.reference,
        input.data.note,
        actor
      ),
    });
  } catch (error) {
    if (error instanceof ReferralError)
      return apiError(
        c,
        { code: 'REFERRAL_CONFLICT', message: error.message },
        error.status as 404 | 409 | 503
      );
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
      return apiError(
        c,
        {
          code: 'REFERRAL_DUPLICATE',
          message: 'A referência já foi utilizada em outra indicação.',
        },
        409
      );
    return apiError(
      c,
      {
        code: 'REFERRAL_UNAVAILABLE',
        message: 'Não foi possível registrar a decisão. Consulte a indicação antes de repetir.',
      },
      503
    );
  }
});
