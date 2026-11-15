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

customerAuthRoutes.get('/start', (c) => {
  const ref = c.req.query('ref');
  if (ref !== undefined && ref !== 'julio')
    return apiError(c, { code: 'INVALID_INPUT', message: 'Indicação inválida.' }, 400);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  try {
    return c.redirect(getCustomerAuthService().getWhatsAppStartUrl(ref), 302);
  } catch {
    c.header('Retry-After', '30');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    return c.html(
      '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Astra — Vamos conversar</title><main><h1>Vamos conversar em instantes 💙</h1><p>O WhatsApp do Astra está reconectando. Seu teste começa quando você enviar sua primeira mensagem.</p><p>Tente novamente em alguns instantes.</p><a href="https://astraacessor.pro/">Voltar ao Astra</a></main></html>',
      503
    );
  }
});

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
