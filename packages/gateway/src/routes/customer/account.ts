import { Hono } from 'hono';
import { z } from 'zod';
import { apiResponse, apiError, ERROR_CODES } from '../helpers.js';
import { getCustomerAuthService } from '../../services/customer-auth.js';
import { getCustomerAvatarService } from '../../services/customer-avatar.js';
import { getClientIp } from '../../utils/client-ip.js';
import {
  clearCustomerSessionCookie,
  customerErrorResponse,
  setCustomerSessionCookie,
} from '../../middleware/customer-session.js';

export const customerAccountRoutes = new Hono();
function validTimeZone(value: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
const profileSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u)
      .optional(),
    timeZone: z.string().max(100).refine(validTimeZone).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    hideAmounts: z.boolean().optional(),
  })
  .strict();
const phoneSchema = z.object({ phoneNumber: z.string().min(1).max(64) }).strict();
const codeSchema = z
  .object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) })
  .strict();

customerAccountRoutes.get('/profile/avatar', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Cookie', { append: true });
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('X-Content-Type-Options', 'nosniff');
  // Identity comes only from the dedicated customer session. Query IDs are ignored.
  const avatar = await getCustomerAvatarService().getAvatar(c.get('customer')).catch(() => null);
  if (!avatar) return c.body(null, 204);
  c.header('Content-Type', avatar.contentType);
  c.header('Content-Length', String(avatar.bytes.byteLength));
  return c.body(new Uint8Array(avatar.bytes), 200);
});

customerAccountRoutes.get('/profile', (c) => apiResponse(c, { profile: c.get('customer') }));
customerAccountRoutes.patch('/profile', async (c) => {
  const parsed = profileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      c,
      { code: ERROR_CODES.INVALID_INPUT, message: 'Confira nome, fuso horário e preferências.' },
      400
    );
  try {
    return apiResponse(c, {
      profile: await getCustomerAuthService().updateProfile(
        c.get('customer').accountId,
        parsed.data
      ),
    });
  } catch (error) {
    return customerErrorResponse(c, error);
  }
});
customerAccountRoutes.get('/sessions', async (c) => {
  try {
    return apiResponse(c, {
      sessions: await getCustomerAuthService().listSessions(
        c.get('customer').accountId,
        c.get('customerSessionId')
      ),
    });
  } catch (error) {
    return customerErrorResponse(c, error);
  }
});
customerAccountRoutes.delete('/sessions/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const revoked = await getCustomerAuthService().revokeSession(c.get('customer').accountId, id);
    if (!revoked)
      return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'Sessão não encontrada.' }, 404);
    const current = id === c.get('customerSessionId');
    if (current) clearCustomerSessionCookie(c);
    return apiResponse(c, { revoked, current });
  } catch (error) {
    return customerErrorResponse(c, error);
  }
});
customerAccountRoutes.post('/sessions/revoke-others', async (c) => {
  try {
    return apiResponse(c, {
      revoked: await getCustomerAuthService().revokeOthers(
        c.get('customer').accountId,
        c.get('customerSessionId')
      ),
    });
  } catch (error) {
    return customerErrorResponse(c, error);
  }
});

customerAccountRoutes.post('/profile/phone-change/request', async (c) => {
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
      await getCustomerAuthService().requestPhoneChange(
        c.get('customer').accountId,
        c.get('customerSessionId'),
        parsed.data.phoneNumber,
        getClientIp(c.req)
      )
    );
  } catch (error) {
    return customerErrorResponse(c, error);
  }
});
customerAccountRoutes.post('/profile/phone-change/confirm-old', async (c) => {
  const parsed = codeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      c,
      { code: ERROR_CODES.UNAUTHORIZED, message: 'Código inválido, vencido ou já utilizado.' },
      401
    );
  try {
    return apiResponse(
      c,
      await getCustomerAuthService().confirmOldPhone(
        c.get('customer').accountId,
        c.get('customerSessionId'),
        parsed.data.challengeId,
        parsed.data.code,
        getClientIp(c.req)
      )
    );
  } catch (error) {
    return customerErrorResponse(c, error);
  }
});
customerAccountRoutes.post('/profile/phone-change/confirm-new', async (c) => {
  const parsed = codeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      c,
      { code: ERROR_CODES.UNAUTHORIZED, message: 'Código inválido, vencido ou já utilizado.' },
      401
    );
  try {
    const result = await getCustomerAuthService().confirmNewPhone(
      c.get('customer').accountId,
      c.get('customerSessionId'),
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
