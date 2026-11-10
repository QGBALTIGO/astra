// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerApi, CustomerApiError, CUSTOMER_SESSION_EXPIRED } from './api';
import type { TransactionInput } from './types';

const fetchMock = vi.fn<typeof fetch>();
const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200 });
const failure = (status: number, message = 'Não foi possível confirmar.', retryAfter?: number) =>
  new Response(JSON.stringify({ success: false, error: { code: 'REQUEST_FAILED', message } }), {
    status,
    headers: retryAfter ? { 'Retry-After': String(retryAfter) } : undefined,
  });
const transaction: TransactionInput = {
  description: 'Almoço',
  amount: 36.39,
  type: 'expense',
  status: 'settled',
  categoryId: 'cat-food',
  date: '2026-11-10',
  notes: null,
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  localStorage.setItem('ownpilot_api_key', 'admin-must-never-be-sent');
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('isolated customer API', () => {
  it('uses only its cookie and endpoint, never owner credentials', async () => {
    fetchMock.mockResolvedValueOnce(ok({ customer: { accountId: 'customer-a' } }));
    await customerApi.session();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/customer/auth/session',
      expect.objectContaining({
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('admin-must-never-be-sent');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/Authorization|X-API-Key/i);
  });
  it('sends JSON content type on DELETE and an empty JSON body for logout', async () => {
    fetchMock.mockImplementation(async () => ok({ deleted: true }));
    await customerApi.deleteTransaction('transaction /1');
    await customerApi.logout();
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/v1/customer/finance/transactions/transaction%20%2F1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{}' });
  });
  it('preserves idempotency keys and decimal values on retry', async () => {
    fetchMock.mockImplementation(async () => ok({ transaction: { id: 'same' } }));
    await customerApi.createTransaction(transaction, 'same-attempt-key');
    await customerApi.createTransaction(transaction, 'same-attempt-key');
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).toMatchObject({ 'Idempotency-Key': 'same-attempt-key' });
      expect(JSON.parse(String(options?.body)).amount).toBe(36.39);
    }
  });
  it('encodes filters and omits optional all values', async () => {
    fetchMock.mockResolvedValue(ok({ transactions: [] }));
    await customerApi.transactions({
      from: '2026-11-01',
      to: '2026-11-30',
      search: 'café & almoço',
      type: undefined,
      page: 2,
      pageSize: 20,
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://astra.test');
    expect(url.searchParams.get('search')).toBe('café & almoço');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.has('type')).toBe(false);
  });
  it('propagates abort signals and does not convert cancellation to a network error', async () => {
    const controller = new AbortController();
    const abort = new DOMException('cancelled', 'AbortError');
    fetchMock.mockRejectedValue(abort);
    await expect(customerApi.session(controller.signal)).rejects.toBe(abort);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
  it('reports network and malformed gateway failures without fake data', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(customerApi.session()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    fetchMock.mockResolvedValueOnce(new Response('<html>gateway error</html>', { status: 503 }));
    await expect(customerApi.session()).rejects.toBeInstanceOf(CustomerApiError);
  });
  it('uses Retry-After for OTP rate limits', async () => {
    fetchMock.mockResolvedValueOnce(failure(429, 'Aguarde antes de solicitar.', 60));
    await expect(customerApi.requestCode('+5567999991234')).rejects.toMatchObject({
      status: 429,
      retryAfter: 60,
    });
  });
  it('does not log a current account out for an invalid login or phone-change code', async () => {
    const listener = vi.fn();
    window.addEventListener(CUSTOMER_SESSION_EXPIRED, listener);
    try {
      fetchMock.mockImplementation(async () => failure(401));
      await expect(customerApi.verifyCode('login', '123456')).rejects.toMatchObject({
        status: 401,
      });
      await expect(customerApi.confirmOldPhone('old', '123456')).rejects.toMatchObject({
        status: 401,
      });
      await expect(customerApi.confirmNewPhone('new', '123456')).rejects.toMatchObject({
        status: 401,
      });
      expect(listener).not.toHaveBeenCalled();
      await expect(customerApi.profile()).rejects.toMatchObject({ status: 401 });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CUSTOMER_SESSION_EXPIRED, listener);
    }
  });
});

describe('private WhatsApp avatar bytes', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])(
    'loads %s with the customer cookie and without identity in the URL',
    async (contentType) => {
      const controller = new AbortController();
      fetchMock.mockResolvedValueOnce(
        new Response(new Blob(['synthetic-image'], { type: contentType }), {
          headers: { 'Content-Type': contentType },
        })
      );

      const image = await customerApi.avatar(controller.signal);

      expect(image?.type).toBe(contentType);
      expect(image?.size).toBeGreaterThan(0);
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/customer/profile/avatar', {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'image/jpeg, image/png, image/webp' },
      });
      expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(
        /admin-must-never-be-sent|Authorization|X-API-Key|phoneNumber|accountId/i
      );
    }
  );

  it('returns no image for a private or missing photo', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await customerApi.avatar()).toBeNull();
  });

  it.each(['text/html', 'application/json', 'image/svg+xml'])(
    'does not turn a %s response into an avatar URL',
    async (contentType) => {
      fetchMock.mockResolvedValueOnce(
        new Response('unexpected body', { headers: { 'Content-Type': contentType } })
      );
      await expect(customerApi.avatar()).rejects.toMatchObject({ code: 'AVATAR_UNAVAILABLE' });
    }
  );

  it('invalidates an expired session but ignores a cancelled old identity response', async () => {
    const listener = vi.fn();
    window.addEventListener(CUSTOMER_SESSION_EXPIRED, listener);
    try {
      fetchMock.mockImplementation(async () => failure(401));
      const controller = new AbortController();
      controller.abort();
      await expect(customerApi.avatar(controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(listener).not.toHaveBeenCalled();

      await expect(customerApi.avatar()).rejects.toMatchObject({ status: 401 });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CUSTOMER_SESSION_EXPIRED, listener);
    }
  });
});
