/** Process-local transport health. Only hashes are retained; credentials stay in request scope. */
import { createHash } from 'node:crypto';
import { ignoreError } from '../../utils/ignore-error.js';
import { reportGroqPoolFailure } from './groq-pool-telemetry.js';
import {
  applyGroqRequestBudget,
  getGroqEffectiveRequestTokenLimit,
} from './groq-request-budget.js';
import {
  groqQuotaGroup,
  groqDefaultOutputTokens,
  reserveGroqQuota,
  type GroqAdmissionLease,
  type GroqAdmissionResult,
} from './groq-admission.js';

interface ModelHealth {
  inFlight: number;
  cooldownUntil: number;
  failures: number;
  used: number;
  touched: number;
}
const models = new Map<string, ModelHealth>();
const disabledKeys = new Map<string, number>();
let sequence = 0;
const AUTH_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

export function isOfficialProviderBase(value: string, expected: string): boolean {
  try {
    const url = new URL(value);
    const target = new URL(expected);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.origin === target.origin &&
      url.pathname.replace(/\/$/, '') === target.pathname
    );
  } catch {
    return false;
  }
}

/** The operator pool is never mixed with a tenant's own key, custom URL or auth override. */
export function groqPoolKeys(
  input: {
    providerId: string;
    baseUrl: string;
    endpoint?: string;
    authorization: string;
  },
  env: Readonly<Record<string, string | undefined>> = process.env
): string[] | null {
  const primary = env.GROQ_API_KEY?.trim();
  if (
    input.providerId !== 'groq' ||
    !primary ||
    /[\s\u0000-\u001f\u007f]/u.test(primary) ||
    input.authorization !== `Bearer ${primary}` ||
    !isOfficialProviderBase(input.baseUrl, 'https://api.groq.com/openai/v1') ||
    (input.endpoint !== undefined && input.endpoint !== '/chat/completions')
  )
    return null;
  const keys = [
    ...new Set([
      primary,
      ...Array.from({ length: 9 }, (_, i) => env['GROQ_API_KEY_' + (i + 2)]?.trim()).filter(
        (key): key is string =>
          typeof key === 'string' && key.length > 0 && !/[\s\u0000-\u001f\u007f]/u.test(key)
      ),
    ]),
  ];
  return keys;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function health(keyId: string, model: string): ModelHealth {
  let id = keyId + ':' + hash(model);
  let value = models.get(id);
  if (!value) {
    // Bound old, inactive model entries without evicting outstanding leases or cooldowns.
    if (models.size >= 5_000) {
      const now = Date.now();
      for (const [name, entry] of models) {
        if (!entry.inFlight && entry.cooldownUntil <= now && entry.touched < now - 60_000)
          models.delete(name);
      }
      if (models.size >= 5_000) {
        // Overflow shares conservative health; never forget an outstanding cooldown.
        id = keyId + ':overflow';
        const overflow = models.get(id);
        if (overflow) return overflow;
      }
    }
    value = { inFlight: 0, cooldownUntil: 0, failures: 0, used: 0, touched: Date.now() };
    models.set(id, value);
  }
  value.touched = Date.now();
  return value;
}

/** Groq reset headers use durations such as 7.66s or 2m59.56s. */
function duration(value: string | null): number | undefined {
  if (!value) return;
  const input = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(input)) return Number(input) * 1_000;
  const parts = [...input.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];
  if (!parts.length || parts.map((part) => part[0]).join('') !== input) return;
  const scale: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const result = parts.reduce((sum, part) => sum + Number(part[1]) * scale[part[2]!]!, 0);
  return Number.isFinite(result) ? result : undefined;
}
function resetDelay(headers: Headers): number {
  let delay = 0;
  for (const resource of ['requests', 'tokens']) {
    const remaining = headers.get('x-ratelimit-remaining-' + resource);
    if (remaining !== null && Number(remaining) === 0) {
      delay = Math.max(delay, duration(headers.get('x-ratelimit-reset-' + resource)) ?? 0);
    }
  }
  return delay;
}
export function groqRetryDelayMs(headers: Headers, errorText: string, now = Date.now()): number {
  const after = headers.get('retry-after');
  let delay = duration(after);
  if (delay === undefined && after) {
    const at = Date.parse(after);
    if (Number.isFinite(at)) delay = Math.max(0, at - now);
  }
  if (delay === undefined) {
    const hint =
      /(?:try again in|retry after)\s*([\d.]+)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|m|hours?|h)\b/i.exec(
        errorText
      );
    if (hint) {
      const unit = hint[2]!.toLowerCase();
      const scale =
        unit === 'ms' || unit.startsWith('millisecond')
          ? 1
          : unit === 'm' || unit.startsWith('minute')
            ? 60_000
            : unit === 'h' || unit.startsWith('hour')
              ? 3_600_000
              : 1_000;
      delay = Number(hint[1]) * scale;
    }
  }
  return Math.min(MAX_COOLDOWN_MS, Math.max(100, delay ?? 1_000, resetDelay(headers)) + 100);
}

function abortError(): DOMException {
  return new DOMException('Groq request cancelled or timed out', 'AbortError');
}
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    ignoreError(promise, 'groq.pool.cancelled-read');
    throw abortError();
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
function redact(text: string, keys: readonly string[]): string {
  return keys.reduce((value, key) => value.split(key).join('[redacted]'), text);
}

export interface GroqPoolResponse {
  response: Response;
  errorText?: string;
  /** Effective provider cooldown, including quota reset headers and safety margin. */
  retryAfterMs?: number;
  /** Keep the deadline and in-flight lease through JSON consumption or the entire stream. */
  finish: () => void;
  signal: AbortSignal;
}

/** Each distinct credential is attempted at most once. No tools execute at this layer.
 * maxRetries applies to unpooled tenant transport; operator failover never repeats a key.
 */
export async function fetchGroqPool(input: {
  keys: readonly string[];
  model: string;
  url: string;
  options: RequestInit;
  timeoutMs: number;
  controller: AbortController;
  beforeFetch?: () => Promise<void>;
}): Promise<GroqPoolResponse> {
  const { controller, keys, model } = input;
  const began = Date.now();
  controller.signal.throwIfAborted();
  let body = input.options.body;
  // A default output reservation must also be an actual provider-side output cap.
  if (typeof body === 'string') {
    try {
      const payload: unknown = JSON.parse(body);
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const requestBody = payload as Record<string, unknown>;
        if (
          Array.isArray(requestBody.messages) &&
          requestBody.max_tokens === undefined &&
          requestBody.max_completion_tokens === undefined
        )
          body = JSON.stringify({ ...requestBody, max_tokens: groqDefaultOutputTokens() });
      }
    } catch {
      // The original invalid body is still rejected normally; never log its contents.
    }
  }
  // Fit the output allowance to both the operator's request cap and a complete
  // organization minute, including admission's safety margin. This changes no
  // messages or tools and never uses already-spent quota to shrink the answer.
  const requestTokenLimit = getGroqEffectiveRequestTokenLimit();
  const budgeted = applyGroqRequestBudget(body, requestTokenLimit);
  const options = { ...input.options, body: budgeted.body };
  const { request } = budgeted;
  // The final guard rejects contexts without useful output room before using
  // any credential. Only an output ceiling may be reduced; input stays intact.
  if (
    requestTokenLimit !== undefined &&
    request.requestTokensApprox + request.maxOutputTokens > requestTokenLimit
  ) {
    const errorText =
      'request_too_large: groq_local_admission; estimated input plus reserved output exceeds configured request budget';
    reportGroqPoolFailure({
      model,
      keys,
      request,
      status: 413,
      attempt: 0,
      cooldownMs: 0,
      elapsedMs: Date.now() - began,
      errorText,
      requestTokenLimit,
    });
    return {
      response: new Response(
        JSON.stringify({ error: { code: 'request_too_large', message: errorText } }),
        { status: 413 }
      ),
      errorText,
      finish: () => undefined,
      signal: controller.signal,
    };
  }
  const timeout = Number.isFinite(input.timeoutMs)
    ? Math.max(1, Math.min(300_000, input.timeoutMs))
    : 120_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const attempted = new Set<string>();
  const skipped = new Set<string>();
  let lease: ModelHealth | undefined;
  let quotaLease: GroqAdmissionLease | undefined;
  let blocked: Extract<GroqAdmissionResult, { admitted: false }> | undefined;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    controller.signal.removeEventListener('abort', finish);
    clearTimeout(timer);
    if (lease) {
      lease.inFlight--;
      lease = undefined;
    }
    quotaLease?.release();
    quotaLease = undefined;
  };
  controller.signal.addEventListener('abort', finish, { once: true });
  const release = () => {
    if (lease) {
      lease.inFlight--;
      lease = undefined;
    }
    quotaLease?.release();
    quotaLease = undefined;
  };
  let last: { response: Response; errorText: string; retryAfterMs?: number } | undefined;
  let networkFailed = false;
  try {
    if (input.beforeFetch) await withAbort(input.beforeFetch(), controller.signal);
    for (const [key, until] of disabledKeys) if (until <= Date.now()) disabledKeys.delete(key);
    for (let attempt = 0; attempt < keys.length; attempt++) {
      if (controller.signal.aborted) throw abortError();
      const now = Date.now();
      const available = keys
        .map((key) => {
          const id = hash(key);
          return { key, id, state: health(id, model), group: groqQuotaGroup(keys, key) };
        })
        .filter(
          (entry) =>
            !attempted.has(entry.id) &&
            !skipped.has(entry.group) &&
            (disabledKeys.get(entry.id) ?? 0) <= now &&
            entry.state.cooldownUntil <= now
        )
        .sort((a, b) => a.state.inFlight - b.state.inFlight || a.state.used - b.state.used);
      const selected = available[0];
      if (!selected) break;
      const admission = reserveGroqQuota({
        group: selected.group,
        model,
        inputTokens: request.requestTokensApprox,
        outputTokens: request.maxOutputTokens,
      });
      if (!admission.admitted) {
        skipped.add(selected.group);
        if (!blocked || admission.retryAfterMs < blocked.retryAfterMs) blocked = admission;
        continue;
      }
      quotaLease = admission.lease;
      attempted.add(selected.id);
      lease = selected.state;
      lease.inFlight++;
      lease.used = ++sequence;
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${selected.key}`);
      if (budgeted.body !== input.options.body) headers.delete('Content-Length');
      let response: Response;
      try {
        response = await withAbort(
          fetch(input.url, {
            ...options,
            headers,
            signal: controller.signal,
            redirect: 'error',
          }).then((value) => {
            if (controller.signal.aborted) {
              ignoreError(value.body?.cancel(), 'groq.pool.cancel-late-response');
              throw abortError();
            }
            return value;
          }),
          controller.signal
        );
      } catch {
        if (controller.signal.aborted) throw abortError();
        networkFailed = true;
        lease.failures++;
        lease.cooldownUntil = Math.max(
          lease.cooldownUntil,
          Date.now() + Math.min(30_000, 250 * 2 ** Math.min(lease.failures - 1, 7))
        );
        reportGroqPoolFailure({
          model,
          keys,
          request,
          status: 'network_error',
          attempt: attempted.size,
          cooldownMs: lease.cooldownUntil - Date.now(),
          elapsedMs: Date.now() - began,
        });
        release();
        continue;
      }
      quotaLease.observe(response.headers);
      if (response.ok) {
        lease.failures = 0;
        const exhausted = resetDelay(response.headers);
        if (exhausted)
          lease.cooldownUntil = Math.max(lease.cooldownUntil, Date.now() + exhausted + 100);
        const state = lease;
        return {
          response: deadlineBody(response, controller.signal, () => {
            state.failures++;
            state.cooldownUntil = Math.max(
              state.cooldownUntil,
              Date.now() + Math.min(30_000, 250 * 2 ** Math.min(state.failures - 1, 7))
            );
            reportGroqPoolFailure({
              model,
              keys,
              request,
              status: 'body_error',
              attempt: attempted.size,
              cooldownMs: state.cooldownUntil - Date.now(),
              elapsedMs: Date.now() - began,
            });
          }),
          finish,
          signal: controller.signal,
        };
      }
      const providerErrorText = redact(
        await withAbort(response.text(), controller.signal).catch((error) => {
          if (controller.signal.aborted) throw error;
          return '';
        }),
        keys
      );
      const retryDelay =
        response.status === 429 ? groqRetryDelayMs(response.headers, providerErrorText) : 0;
      // Keep a canonical hint for body-only consumers. The adapter also receives
      // the effective cooldown so a shorter Retry-After cannot hide reset headers.
      const errorText = retryDelay
        ? `Please try again in ${Math.max(1, Math.ceil(retryDelay / 1_000))}s. ${providerErrorText}`
        : providerErrorText;
      last = { response, errorText, ...(retryDelay ? { retryAfterMs: retryDelay } : {}) };
      const retry =
        response.status === 429 ||
        response.status === 401 ||
        response.status === 403 ||
        response.status >= 500;
      if (response.status === 429) {
        quotaLease.coolDown(retryDelay);
        lease.cooldownUntil = Math.max(lease.cooldownUntil, Date.now() + retryDelay);
      } else if (response.status === 401 || response.status === 403) {
        disabledKeys.set(selected.id, Date.now() + AUTH_COOLDOWN_MS);
      } else if (response.status >= 500) {
        lease.failures++;
        lease.cooldownUntil = Math.max(
          lease.cooldownUntil,
          Date.now() + Math.min(30_000, 250 * 2 ** Math.min(lease.failures - 1, 7))
        );
      }
      reportGroqPoolFailure({
        model,
        keys,
        request,
        status: response.status,
        attempt: attempted.size,
        cooldownMs: Math.max(lease.cooldownUntil, disabledKeys.get(selected.id) ?? 0) - Date.now(),
        elapsedMs: Date.now() - began,
        headers: response.headers,
        errorText,
      });
      release();
      if (!retry) break;
    }
    if (last) {
      finish();
      return { ...last, finish, signal: controller.signal };
    }
    if (networkFailed) throw new Error('Groq transport failed');
    if (blocked) {
      const retryAfterSeconds = Math.max(1, Math.ceil(blocked.retryAfterMs / 1_000));
      const tooLarge = blocked.reason === 'request_too_large';
      const errorText = tooLarge
        ? 'request_too_large: groq_local_admission; estimated input plus reserved output exceeds organization budget'
        : `Groq local admission ${blocked.reason}. Please try again in ${retryAfterSeconds}s`;
      reportGroqPoolFailure({
        model,
        keys,
        request,
        status: tooLarge ? 413 : 429,
        attempt: attempted.size,
        cooldownMs: blocked.retryAfterMs,
        elapsedMs: Date.now() - began,
        errorText,
        admissionReason: blocked.reason,
      });
      finish();
      return {
        response: new Response(
          JSON.stringify({
            error: {
              code: tooLarge ? 'request_too_large' : 'groq_local_admission',
              message: errorText,
            },
          }),
          {
            status: tooLarge ? 413 : 429,
            headers: { 'Retry-After': String(retryAfterSeconds) },
          }
        ),
        errorText,
        finish,
        signal: controller.signal,
      };
    }
    const next = Math.min(
      ...keys.map((key) =>
        Math.max(disabledKeys.get(hash(key)) ?? 0, health(hash(key), model).cooldownUntil)
      )
    );
    const retryAfterSeconds = Math.max(1, Math.ceil((next - Date.now()) / 1_000));
    const errorText = `Groq keys temporarily unavailable. Please try again in ${retryAfterSeconds}s`;
    reportGroqPoolFailure({
      model,
      keys,
      request,
      status: 'pool_cooldown',
      attempt: attempted.size,
      cooldownMs: next - Date.now(),
      elapsedMs: Date.now() - began,
    });
    finish();
    return {
      response: new Response(JSON.stringify({ error: { message: errorText } }), {
        status: 429,
        headers: { 'Retry-After': String(retryAfterSeconds) },
      }),
      errorText,
      finish,
      signal: controller.signal,
    };
  } catch (error) {
    finish();
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      reportGroqPoolFailure({
        model,
        keys,
        request,
        status: timedOut ? 'timeout' : 'cancelled',
        attempt: attempted.size,
        cooldownMs: 0,
        elapsedMs: Date.now() - began,
      });
      throw abortError();
    }
    throw new Error(networkFailed ? 'Groq network error' : 'Groq transport failed');
  }
}

function deadlineBody(response: Response, signal: AbortSignal, onFailure: () => void): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await withAbort(reader.read(), signal);
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        if (!signal.aborted) onFailure();
        controller.error(error);
        ignoreError(reader.cancel(), 'groq.pool.cancel-failed-body');
      }
    },
    cancel(reason) {
      ignoreError(reader.cancel(reason), 'groq.pool.cancel-body');
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Consume pooled JSON/SSE under the same deadline, even for a stalled custom stream. */
export function groqPoolRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return withAbort(promise, signal);
}
