import { Hono } from 'hono';
import { z } from 'zod';
import { apiResponse, apiError, ERROR_CODES } from '../helpers.js';
import { getCustomerAuthService } from '../../services/customer-auth.js';
import { getClientIp } from '../../utils/client-ip.js';
import {
  clearCustomerSessionCookie,
  customerErrorResponse,
  getCustomerSessionToken,
  requireCustomerRequestOrigin,
  requireCustomerSession,
  setCustomerSessionCookie,
} from '../../middleware/customer-session.js';

export const customerAuthRoutes = new Hono();
customerAuthRoutes.use('*', requireCustomerRequestOrigin);
const phoneSchema = z.object({ phoneNumber: z.string().min(1).max(64) }).strict();
const codeSchema = z
  .object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) })
  .strict();

customerAuthRoutes.post('/request-code', async (c) => {
  const parsed = phoneSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      c,
      { code: ERROR_CODES.INVALID_INPUT, message: 'Informe um telefone válido.' },
      400
    );
  try {
    return apiResponse(
      c,
      await getCustomerAuthService().requestCode(parsed.data.phoneNumber, getClientIp(c.req))
    );
  } catch (error) {
    return customerErrorResponse(c, error);
  }
});

customerAuthRoutes.post('/verify-code', async (c) => {
  const parsed = codeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      c,
      { code: ERROR_CODES.UNAUTHORIZED, message: 'Código inválido, vencido ou já utilizado.' },
      401
    );
  try {
    const result = await getCustomerAuthService().verifyCode(
      parsed.data.challengeId,
      parsed.data.code,
      c.req.header('User-Agent') ?? ''
    );
    setCustomerSessionCookie(c, result.token, result.expiresAt);
    return apiResponse(c, { customer: result.customer });
  } catch (error) {
    return customerErrorResponse(c, error);
  }
});

customerAuthRoutes.get('/session', requireCustomerSession, (c) =>
  apiResponse(c, { customer: c.get('customer') })
);
customerAuthRoutes.post('/logout', async (c) => {
  try {
    const token = getCustomerSessionToken(c);
    if (token) await getCustomerAuthService().logout(token);
    clearCustomerSessionCookie(c);
    return apiResponse(c, { loggedOut: true });
  } catch (error) {
    return customerErrorResponse(c, error);
  }
});
