import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { apiError, ERROR_CODES } from '../routes/helpers.js';
import { getRequestOrigin } from '../utils/trusted-proxy.js';
import { CustomerAuthError, getCustomerAuthService } from '../services/customer-auth.js';
import type { CustomerSessionContext } from '../services/customer-identity.js';

export type { CustomerSessionContext } from '../services/customer-identity.js';
export const CUSTOMER_SESSION_COOKIE = 'astra_customer_session';
export const CUSTOMER_SESSION_PATH = '/api/v1/customer';

declare module 'hono' {
  interface ContextVariableMap {
    customer: CustomerSessionContext;
    customerSessionId: string;
  }
}

export function getCustomerSessionToken(c: Context): string | undefined {
  return getCookie(c, CUSTOMER_SESSION_COOKIE);
}
export function setCustomerSessionCookie(c: Context, token: string, expiresAt: Date): void {
  setCookie(c, CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: CUSTOMER_SESSION_PATH,
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}
export function clearCustomerSessionCookie(c: Context): void {
  deleteCookie(c, CUSTOMER_SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: CUSTOMER_SESSION_PATH,
  });
}

/** Includes login/OTP mutations: customer cookies never authorize an owner API. */
function customerRequestOriginError(c: Context): Response | null {
  c.header('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method.toUpperCase())) {
    const origin = c.req.header('Origin');
    const sameOrigin = origin === getRequestOrigin(c.req);
    const allowedOrigins = new Set(
      (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value && value !== '*')
    );
    const explicitlyAllowed = Boolean(origin && allowedOrigins.has(origin));
    const fetchSite = c.req.header('Sec-Fetch-Site');
    if (
      !origin ||
      (!sameOrigin && !explicitlyAllowed) ||
      (fetchSite === 'cross-site' && !explicitlyAllowed)
    ) {
      return apiError(
        c,
        { code: ERROR_CODES.ACCESS_DENIED, message: 'Origem da solicitação inválida.' },
        403
      );
    }
    if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return apiError(
        c,
        { code: ERROR_CODES.INVALID_INPUT, message: 'Envie a solicitação em JSON.' },
        400
      );
    }
  }
  return null;
}
export const requireCustomerRequestOrigin = createMiddleware(async (c, next) => {
  const error = customerRequestOriginError(c);
  if (error) return error;
  return next();
});

export const requireCustomerSession = createMiddleware(async (c, next) => {
  // This guard also covers routes mounted by other portal modules.
  const originError = customerRequestOriginError(c);
  if (originError) return originError;
  const token = getCustomerSessionToken(c);
  const authenticated = token ? await getCustomerAuthService().authenticate(token) : null;
  if (!authenticated) {
    clearCustomerSessionCookie(c);
    return apiError(
      c,
      { code: ERROR_CODES.UNAUTHORIZED, message: 'Entre no Astra para continuar.' },
      401
    );
  }
  c.set('customer', authenticated.customer);
  c.set('customerSessionId', authenticated.sessionId);
  // Do not set sessionAuthenticated or userId: those belong to owner/API auth.
  return next();
});

export function customerErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof CustomerAuthError) {
    if (error.retryAfter) c.header('Retry-After', String(error.retryAfter));
    const code =
      error.status === 429
        ? ERROR_CODES.RATE_LIMITED
        : error.status === 401
          ? ERROR_CODES.UNAUTHORIZED
          : error.status === 403
            ? ERROR_CODES.ACCESS_DENIED
            : error.status === 503
              ? ERROR_CODES.SERVICE_UNAVAILABLE
              : ERROR_CODES.INVALID_INPUT;
    return apiError(c, { code, message: error.message }, error.status);
  }
  return apiError(
    c,
    {
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      message: 'Não foi possível concluir agora. Tente novamente em instantes.',
    },
    503
  );
}
