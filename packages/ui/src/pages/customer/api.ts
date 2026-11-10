import type {
  AgendaInput,
  AgendaKind,
  Customer,
  CustomerAgendaItem,
  CustomerCategory,
  CustomerChallenge,
  CustomerFinanceSummary,
  CustomerIntegrations,
  CustomerPeriod,
  CustomerSession,
  CustomerTransaction,
  CustomerTransactionFilters,
  CustomerTransactionPage,
  TransactionInput,
} from './types';

export const CUSTOMER_SESSION_EXPIRED = 'astra:customer-session-expired';
const base = `${import.meta.env.VITE_API_BASE || ''}/api/v1/customer`;

export class CustomerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'CustomerApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  params?: object;
  idempotencyKey?: string;
}

function url(path: string, params?: object) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  return base + path + (search.size ? '?' + search.toString() : '');
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url(path, options.params), {
      method: options.method ?? 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: options.signal,
      headers: {
        Accept: 'application/json',
        ...(!options.method || options.method === 'GET'
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new CustomerApiError(
      0,
      'NETWORK_ERROR',
      'Não foi possível conectar ao Astra. Confira sua conexão e tente novamente.'
    );
  }
  let envelope: {
    success?: boolean;
    data?: T;
    error?: { code?: string; message?: string } | string;
  };
  try {
    envelope = await response.json();
  } catch {
    throw new CustomerApiError(
      response.status,
      'INVALID_RESPONSE',
      'O Astra está temporariamente indisponível. Tente novamente.'
    );
  }
  if (response.ok && envelope.success === true && envelope.data !== undefined) return envelope.data;
  const invalidCode =
    path === '/auth/verify-code' || path.startsWith('/profile/phone-change/confirm-');
  if (response.status === 401 && !invalidCode)
    window.dispatchEvent(new Event(CUSTOMER_SESSION_EXPIRED));
  const error = envelope.error;
  throw new CustomerApiError(
    response.status,
    typeof error === 'object' ? (error?.code ?? 'REQUEST_FAILED') : 'REQUEST_FAILED',
    typeof error === 'string'
      ? error
      : (error?.message ?? 'Não foi possível concluir. Tente novamente.'),
    Number(response.headers.get('Retry-After')) || undefined
  );
}

/** Private image bytes; never expose a WhatsApp URL or add a phone number to the URL. */
async function fetchCustomerAvatar(signal?: AbortSignal): Promise<Blob | null> {
  const response = await fetch(url('/profile/avatar'), {
    credentials: 'include',
    cache: 'no-store',
    signal,
    headers: { Accept: 'image/jpeg, image/png, image/webp' },
  });
  // A cancelled request from a previous identity cannot invalidate the new session.
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (response.status === 401) {
    window.dispatchEvent(new Event(CUSTOMER_SESSION_EXPIRED));
    throw new CustomerApiError(401, 'UNAUTHORIZED', 'Entre no Astra para continuar.');
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (
    response.status !== 200 ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(contentType ?? '')
  ) {
    throw new CustomerApiError(
      response.status,
      'AVATAR_UNAVAILABLE',
      'A foto do WhatsApp não está disponível agora.'
    );
  }
  const image = await response.blob();
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return image.size ? image : null;
}

export const customerApi = {
  session: (signal?: AbortSignal) => request<{ customer: Customer }>('/auth/session', { signal }),
  requestCode: (phoneNumber: string) =>
    request<CustomerChallenge>('/auth/request-code', { method: 'POST', body: { phoneNumber } }),
  verifyCode: (challengeId: string, code: string) =>
    request<{ customer: Customer }>('/auth/verify-code', {
      method: 'POST',
      body: { challengeId, code },
    }),
  logout: () => request<{ loggedOut: boolean }>('/auth/logout', { method: 'POST', body: {} }),
  profile: (signal?: AbortSignal) => request<{ profile: Customer }>('/profile', { signal }),
  avatar: fetchCustomerAvatar,
  updateProfile: (
    body: Partial<Pick<Customer, 'displayName' | 'timeZone' | 'theme' | 'hideAmounts'>>
  ) => request<{ profile: Customer }>('/profile', { method: 'PATCH', body }),
  sessions: (signal?: AbortSignal) =>
    request<{ sessions: CustomerSession[] }>('/sessions', { signal }),
  revokeSession: (id: string) =>
    request<{ revoked: boolean; current: boolean }>('/sessions/' + encodeURIComponent(id), {
      method: 'DELETE',
    }),
  revokeOtherSessions: () =>
    request<{ revoked: number }>('/sessions/revoke-others', { method: 'POST', body: {} }),
  requestPhoneChange: (phoneNumber: string) =>
    request<CustomerChallenge>('/profile/phone-change/request', {
      method: 'POST',
      body: { phoneNumber },
    }),
  confirmOldPhone: (challengeId: string, code: string) =>
    request<CustomerChallenge>('/profile/phone-change/confirm-old', {
      method: 'POST',
      body: { challengeId, code },
    }),
  confirmNewPhone: (challengeId: string, code: string) =>
    request<{ customer: Customer }>('/profile/phone-change/confirm-new', {
      method: 'POST',
      body: { challengeId, code },
    }),
  integrations: (signal?: AbortSignal) =>
    request<CustomerIntegrations>('/integrations', { signal }),
  summary: (period: CustomerPeriod, signal?: AbortSignal) =>
    request<CustomerFinanceSummary>('/finance/summary', { params: period, signal }),
  transactions: (filters: CustomerTransactionFilters, signal?: AbortSignal) =>
    request<CustomerTransactionPage>('/finance/transactions', { params: filters, signal }),
  createTransaction: (body: TransactionInput, idempotencyKey: string) =>
    request<{ transaction: CustomerTransaction }>('/finance/transactions', {
      method: 'POST',
      body,
      idempotencyKey,
    }),
  updateTransaction: (id: string, body: TransactionInput) =>
    request<{ transaction: CustomerTransaction }>(
      '/finance/transactions/' + encodeURIComponent(id),
      { method: 'PATCH', body }
    ),
  deleteTransaction: (id: string) =>
    request<{ deleted: boolean }>('/finance/transactions/' + encodeURIComponent(id), {
      method: 'DELETE',
    }),
  categories: (signal?: AbortSignal) =>
    request<{ categories: CustomerCategory[] }>('/finance/categories', { signal }),
  createCategory: (body: Pick<CustomerCategory, 'name' | 'type' | 'color'>) =>
    request<{ category: CustomerCategory }>('/finance/categories', { method: 'POST', body }),
  updateCategory: (
    id: string,
    body: Partial<Pick<CustomerCategory, 'name' | 'color' | 'archived'>>
  ) =>
    request<{ category: CustomerCategory }>('/finance/categories/' + encodeURIComponent(id), {
      method: 'PATCH',
      body,
    }),
  deleteCategory: (id: string, transferToId?: string) =>
    request<{ deleted: boolean; archived: boolean }>(
      '/finance/categories/' + encodeURIComponent(id),
      { method: 'DELETE', params: { transferToId } }
    ),
  agenda: (period: CustomerPeriod, signal?: AbortSignal) =>
    request<{ items: CustomerAgendaItem[] }>('/agenda', { params: period, signal }),
  createAgenda: (body: AgendaInput, idempotencyKey: string) =>
    request<{ item: CustomerAgendaItem }>('/agenda', { method: 'POST', body, idempotencyKey }),
  updateAgenda: (kind: AgendaKind, id: string, body: Omit<AgendaInput, 'kind'>) =>
    request<{ item: CustomerAgendaItem }>(`/agenda/${kind}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    }),
  deleteAgenda: (kind: AgendaKind, id: string) =>
    request<{ deleted: boolean }>(`/agenda/${kind}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  completeTask: (id: string, completed: boolean) =>
    request<{ item: CustomerAgendaItem }>(`/agenda/task/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      body: { completed },
    }),
  completeBill: (id: string, completed: boolean) =>
    request<{ item: CustomerAgendaItem }>(`/agenda/bill/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { completed },
    }),
};

export async function downloadCustomerExport(format: 'json' | 'csv'): Promise<void> {
  const response = await fetch(url('/export', { format }), {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(CUSTOMER_SESSION_EXPIRED));
    throw new CustomerApiError(
      response.status,
      'EXPORT_FAILED',
      'Não foi possível exportar seus dados. Tente novamente.'
    );
  }
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = `astra-dados-${new Date().toISOString().slice(0, 10)}.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
