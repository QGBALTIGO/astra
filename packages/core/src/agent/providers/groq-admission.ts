/**
 * Conservative, process-local admission for the operator's Groq quota.
 * Keys are credentials, not additional quota. Unknown keys share one group;
 * separate organizations must be declared explicitly through GROQ_QUOTA_GROUPS.
 * Keep this process a single writer (or move these reservations to a shared store).
 */
import { createHash } from 'node:crypto';

type Environment = Readonly<Record<string, string | undefined>>;
type Reservation = { at: number; tokens: number; pending: boolean };
type HeaderBudget = { remaining: number; resetsAt: number };
type QuotaState = {
  active: Set<Reservation>;
  reservations: Reservation[];
  cooldownUntil: number;
  tokenHeader?: HeaderBudget;
  requestHeader?: HeaderBudget;
  tokenLimit?: number;
  requestLimit?: number;
  touched: number;
};

const states = new Map<string, QuotaState>();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_STATES = 5_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function setting(env: Environment, name: string, fallback: number, max: number): number {
  const raw = env[name];
  const value = raw && /^\d+$/u.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : fallback;
}

export function groqDefaultOutputTokens(env: Environment = process.env): number {
  return setting(env, 'GROQ_DEFAULT_OUTPUT_TOKENS', 1_024, 131_072);
}

/** Total input and output that can fit one minute with the same admission margin. */
export function groqQuotaRequestTokenLimit(env: Environment = process.env): number {
  const tokensPerMinute = setting(env, 'GROQ_TOKENS_PER_MINUTE', 6_000, 100_000_000);
  const marginPercent = setting(env, 'GROQ_TOKEN_MARGIN_PERCENT', 20, 100);
  return Math.floor(tokensPerMinute / (1 + marginPercent / 100));
}

function duration(value: string | null): number | undefined {
  if (!value) return;
  const input = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(input)) return Number(input) * 1_000;
  const parts = [...input.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/gu)];
  if (!parts.length || parts.map((part) => part[0]).join('') !== input) return;
  const scale: Record<string, number> = { ms: 1, s: 1_000, m: MINUTE, h: 60 * MINUTE, d: DAY };
  const result = parts.reduce((sum, part) => sum + Number(part[1]) * scale[part[2]!]!, 0);
  return Number.isFinite(result) ? result : undefined;
}

function integerHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || !/^\d+$/u.test(raw)) return;
  const number = Number(raw);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** Only configured environment variable names can identify a known organization. */
export function groqQuotaGroup(
  keys: readonly string[],
  selectedKey: string,
  env: Environment = process.env
): string {
  const primary = env.GROQ_API_KEY?.trim();
  const fallback = hash(
    'operator:' + (primary && keys.includes(primary) ? primary : [...keys].sort().join('\0'))
  );
  let groups: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(env.GROQ_QUOTA_GROUPS ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      groups = parsed as Record<string, unknown>;
  } catch {
    // An invalid mapping never turns unknown credentials into independent quotas.
  }
  const known = (name: string): string | undefined => {
    const value = groups[name];
    return typeof value === 'string' && /^[a-z\d:_.\/-]{1,160}$/iu.test(value) ? value : undefined;
  };
  const primaryGroup = primary && keys.includes(primary) ? known('GROQ_API_KEY') : undefined;
  // A labeled backup does not prove that an unlabeled primary belongs elsewhere.
  if (!primaryGroup) return fallback;
  let group: string | undefined;
  // Duplicate keys cannot obtain extra quota by being assigned to more than one group.
  for (let i = 1; i <= 10; i++) {
    const name = i === 1 ? 'GROQ_API_KEY' : `GROQ_API_KEY_${i}`;
    if (env[name]?.trim() === selectedKey) {
      group = known(name);
      break;
    }
  }
  group ??= primaryGroup;
  return group ? hash('organization:' + group) : fallback;
}

function prune(state: QuotaState, now: number): void {
  state.reservations = state.reservations.filter((entry) => entry.at + MINUTE > now);
  if (state.tokenHeader && state.tokenHeader.resetsAt <= now) {
    if (state.tokenLimit !== undefined)
      state.tokenHeader = { remaining: state.tokenLimit, resetsAt: now + MINUTE };
    else delete state.tokenHeader;
  }
  if (state.requestHeader && state.requestHeader.resetsAt <= now) {
    if (state.requestLimit !== undefined)
      state.requestHeader = { remaining: state.requestLimit, resetsAt: now + DAY };
    else delete state.requestHeader;
  }
  state.touched = now;
}

function windowWait(
  state: QuotaState,
  needed: number,
  limit: number,
  tokens: boolean,
  now: number
): number {
  let used = state.reservations.reduce((sum, entry) => sum + (tokens ? entry.tokens : 1), 0);
  if (used + needed <= limit) return 0;
  for (const entry of state.reservations) {
    used -= tokens ? entry.tokens : 1;
    if (used + needed <= limit) return Math.max(100, entry.at + MINUTE - now + 100);
  }
  return MINUTE;
}

export type GroqAdmissionLease = {
  /** Outstanding body/stream work still occupies a concurrency slot. */
  release: () => void;
  /** Provider headers can lower available quota, never refill it mid-window. */
  observe: (headers: Headers) => void;
  /** A provider quota failure applies to every credential in this organization/model. */
  coolDown: (delayMs: number) => void;
};

export type GroqAdmissionResult =
  | { admitted: true; lease: GroqAdmissionLease }
  | {
      admitted: false;
      retryAfterMs: number;
      reason: 'concurrency' | 'quota' | 'cooldown' | 'request_too_large' | 'capacity';
    };

/** No await between checking resources and recording the reservation. */
export function reserveGroqQuota(input: {
  group: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  env?: Environment;
  now?: number;
}): GroqAdmissionResult {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  const maxConcurrent = setting(env, 'GROQ_MAX_CONCURRENT_REQUESTS', 4, 64);
  const requestsPerMinute = setting(env, 'GROQ_REQUESTS_PER_MINUTE', 20, 100_000);
  const tokensPerMinute = setting(env, 'GROQ_TOKENS_PER_MINUTE', 6_000, 100_000_000);
  const marginPercent = setting(env, 'GROQ_TOKEN_MARGIN_PERCENT', 20, 100);
  const outputTokens = input.outputTokens > 0 ? input.outputTokens : groqDefaultOutputTokens(env);
  const tokens = Math.ceil(
    (Math.max(0, input.inputTokens) + outputTokens) * (1 + marginPercent / 100)
  );
  if (!Number.isSafeInteger(tokens) || tokens > tokensPerMinute)
    return { admitted: false, retryAfterMs: MINUTE, reason: 'request_too_large' };
  const id = input.group + ':' + hash(input.model);
  let state = states.get(id);
  if (!state) {
    if (states.size >= MAX_STATES) {
      for (const [key, value] of states) {
        const expires = Math.max(
          value.cooldownUntil,
          value.tokenHeader?.resetsAt ?? 0,
          value.requestHeader?.resetsAt ?? 0
        );
        if (!value.active.size && expires <= now && value.touched < now - MINUTE)
          states.delete(key);
      }
      if (states.size >= MAX_STATES)
        return { admitted: false, retryAfterMs: MINUTE, reason: 'capacity' };
    }
    state = { active: new Set(), reservations: [], cooldownUntil: 0, touched: now };
    states.set(id, state);
  }
  prune(state, now);
  if (state.cooldownUntil > now)
    return { admitted: false, retryAfterMs: state.cooldownUntil - now, reason: 'cooldown' };
  if (state.active.size >= maxConcurrent)
    return { admitted: false, retryAfterMs: 1_000, reason: 'concurrency' };
  const retryAfterMs = Math.max(
    windowWait(state, tokens, tokensPerMinute, true, now),
    windowWait(state, 1, requestsPerMinute, false, now),
    state.tokenHeader && state.tokenHeader.remaining < tokens
      ? state.tokenHeader.resetsAt - now
      : 0,
    state.requestHeader && state.requestHeader.remaining < 1
      ? state.requestHeader.resetsAt - now
      : 0
  );
  if (retryAfterMs > 0) return { admitted: false, retryAfterMs, reason: 'quota' };

  const reservation: Reservation = { at: now, tokens, pending: true };
  const quota = state;
  quota.active.add(reservation);
  quota.reservations.push(reservation);
  if (quota.tokenHeader)
    quota.tokenHeader.remaining = Math.max(0, quota.tokenHeader.remaining - tokens);
  if (quota.requestHeader)
    quota.requestHeader.remaining = Math.max(0, quota.requestHeader.remaining - 1);
  return {
    admitted: true,
    lease: {
      release() {
        // Retain the quota reservation even on an uncertain network result or cancellation.
        // Release only concurrency; retries cannot spend the same tokens a second time.
        quota.active.delete(reservation);
      },
      observe(headers) {
        reservation.pending = false;
        const observedAt = Date.now();
        // A timed-out/aborted request may still consume remote quota. Its
        // reservation survives the local concurrency lease until the window ends.
        const pending = quota.reservations.filter(
          (entry) => entry.pending && entry.at + MINUTE > observedAt
        );
        for (const [resource, property, fallbackWindow] of [
          ['tokens', 'tokenHeader', MINUTE],
          // Groq's requests headers refer to DAILY quota, never requests/minute.
          ['requests', 'requestHeader', DAY],
        ] as const) {
          const remaining = integerHeader(headers, `x-ratelimit-remaining-${resource}`);
          const limit = integerHeader(headers, `x-ratelimit-limit-${resource}`);
          const limitProperty = resource === 'tokens' ? 'tokenLimit' : 'requestLimit';
          if (limit !== undefined)
            quota[limitProperty] = Math.min(quota[limitProperty] ?? limit, limit);
          if (remaining === undefined) continue;
          const outstanding = pending.reduce(
            (sum, entry) => sum + (resource === 'tokens' ? entry.tokens : 1),
            0
          );
          const balance = Math.max(0, remaining - outstanding);
          const resetsAt =
            observedAt +
            Math.min(
              DAY,
              Math.max(
                100,
                duration(headers.get(`x-ratelimit-reset-${resource}`)) ?? fallbackWindow
              )
            ) +
            100;
          const current = quota[property];
          quota[property] = {
            remaining:
              current && current.resetsAt > observedAt
                ? Math.min(current.remaining, balance)
                : balance,
            resetsAt: Math.max(current?.resetsAt ?? 0, resetsAt),
          };
        }
      },
      coolDown(delayMs) {
        quota.cooldownUntil = Math.max(
          quota.cooldownUntil,
          Date.now() + Math.min(DAY, Math.max(100, delayMs))
        );
      },
    },
  };
}
