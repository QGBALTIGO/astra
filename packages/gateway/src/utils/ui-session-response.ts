import type { Context } from 'hono';
import { apiError, ERROR_CODES } from '../routes/helpers.js';
import { validateSession } from '../services/ui-session.js';
import { UiSessionBusyError } from '../services/ui-session-error.js';

export function uiAuthBusyResponse(c: Context, error = new UiSessionBusyError()): Response {
  c.header('Retry-After', String(error.retryAfter));
  c.header('Cache-Control', 'no-store');
  return apiError(c, { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: error.message }, 503);
}

/** Preserve the cookie and distinguish temporary load from failed authentication. */
export async function runUiAuthOperation<T>(
  c: Context,
  operation: () => Promise<T>
): Promise<T | Response> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof UiSessionBusyError)) throw error;
    return uiAuthBusyResponse(c, error);
  }
}

export function validateUiSessionForRequest(
  c: Context,
  token: string
): Promise<boolean | Response> {
  return runUiAuthOperation(c, () => validateSession(token));
}
