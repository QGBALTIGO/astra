/** Numerical transport diagnostics only. Never pass credentials, prompts, headers or error bodies to a logger. */
import { getLog } from '../../services/get-log.js';

const log = getLog('GroqPool');
const integer = (value: unknown): number | undefined => {
  const number =
    typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function groqPoolRequestFacts(body: unknown) {
  const serialized = typeof body === 'string' ? body : '';
  const result = {
    requestBytes: Buffer.byteLength(serialized, 'utf8'),
    requestTokensApprox: Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4),
    messageCount: 0,
    toolCount: 0,
    messageTokensApprox: 0,
    toolTokensApprox: 0,
    maxOutputTokens: 0,
  };
  try {
    const payload = object(JSON.parse(serialized));
    if (!payload) return result;
    if (Array.isArray(payload.messages)) {
      result.messageCount = payload.messages.length;
      result.messageTokensApprox = Math.ceil(JSON.stringify(payload.messages).length / 4);
    }
    if (Array.isArray(payload.tools)) {
      result.toolCount = payload.tools.length;
      result.toolTokensApprox = Math.ceil(JSON.stringify(payload.tools).length / 4);
    }
    result.maxOutputTokens =
      integer(payload.max_completion_tokens) ?? integer(payload.max_tokens) ?? 0;
  } catch {
    /* The diagnostic must never expose a malformed body. */
  }
  return result;
}

export function groqPoolFailureFacts(input: {
  model: string;
  keys: readonly string[];
  request: ReturnType<typeof groqPoolRequestFacts>;
  status: number | 'network_error' | 'timeout' | 'cancelled' | 'pool_cooldown' | 'body_error';
  attempt: number;
  cooldownMs: number;
  elapsedMs: number;
  headers?: Headers;
  errorText?: string;
  requestTokenLimit?: number;
  admissionReason?: 'concurrency' | 'quota' | 'cooldown' | 'request_too_large' | 'capacity';
}) {
  const header = (name: string) => integer(input.headers?.get(name));
  const tokenLimit = header('x-ratelimit-limit-tokens');
  const requestLimit = header('x-ratelimit-limit-requests');
  const remainingTokens = header('x-ratelimit-remaining-tokens');
  const remainingRequests = header('x-ratelimit-remaining-requests');
  const message = input.status === 429 ? (input.errorText ?? '').slice(0, 16_384) : '';
  const quotaKind = /tokens per minute|\bTPM\b/iu.test(message)
    ? 'tokens_per_minute'
    : /requests per minute|\bRPM\b/iu.test(message)
      ? 'requests_per_minute'
      : /tokens per day|\bTPD\b/iu.test(message)
        ? 'tokens_per_day'
        : /requests per day|\bRPD\b/iu.test(message)
          ? 'requests_per_day'
          : 'unknown';
  // These values are read only from a recognized quota diagnostic, never arbitrary model prose.
  const field = (name: string) =>
    quotaKind === 'unknown'
      ? undefined
      : integer(new RegExp('\\b' + name + '\\s*[:=]?\\s*(\\d+)(?:\\b|$)', 'iu').exec(message)?.[1]);
  const quotaLimit = field('Limit');
  const quotaRequested = field('Requested');
  const quotaUsed = field('Used');
  const admissionReason = [
    'concurrency',
    'quota',
    'cooldown',
    'request_too_large',
    'capacity',
  ].includes(input.admissionReason ?? '')
    ? input.admissionReason
    : undefined;
  const model =
    /^[a-z\d][a-z\d./:_-]{0,159}$/iu.test(input.model) &&
    !input.keys.some((key) => input.model.includes(key))
      ? input.model
      : 'redacted-model';
  return {
    provider: 'groq',
    model,
    requestBytes: integer(input.request.requestBytes) ?? 0,
    requestTokensApprox: integer(input.request.requestTokensApprox) ?? 0,
    messageCount: integer(input.request.messageCount) ?? 0,
    toolCount: integer(input.request.toolCount) ?? 0,
    messageTokensApprox: integer(input.request.messageTokensApprox) ?? 0,
    toolTokensApprox: integer(input.request.toolTokensApprox) ?? 0,
    maxOutputTokens: integer(input.request.maxOutputTokens) ?? 0,
    status: input.status,
    attempt: input.attempt,
    poolSize: input.keys.length,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    cooldownMs: Math.max(0, Math.ceil(input.cooldownMs)),
    quotaKind,
    requestTooLarge:
      (input.status === 413 &&
        input.errorText?.startsWith('request_too_large: groq_local_admission') === true) ||
      /request too large/iu.test(message) ||
      (quotaKind.startsWith('tokens_') &&
        quotaLimit !== undefined &&
        quotaRequested !== undefined &&
        quotaRequested > quotaLimit),
    ...(tokenLimit !== undefined ? { tokenLimit } : {}),
    ...(requestLimit !== undefined ? { requestLimit } : {}),
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(remainingRequests !== undefined ? { remainingRequests } : {}),
    ...(quotaLimit !== undefined ? { quotaLimit } : {}),
    ...(quotaRequested !== undefined ? { quotaRequested } : {}),
    ...(quotaUsed !== undefined ? { quotaUsed } : {}),
    ...(integer(input.requestTokenLimit) !== undefined
      ? { requestTokenLimit: input.requestTokenLimit }
      : {}),
    ...(admissionReason ? { admissionReason } : {}),
  };
}

export function reportGroqPoolFailure(input: Parameters<typeof groqPoolFailureFacts>[0]): void {
  try {
    const facts = groqPoolFailureFacts(input);
    // Backpressure is expected admission behavior, not a transport incident per waiting user.
    if (facts.admissionReason) log.debug('Groq request deferred by local admission', facts);
    else {
      const localAdmission =
        input.status === 413 &&
        input.errorText?.startsWith('request_too_large: groq_local_admission') === true;
      log.warn(
        localAdmission
          ? 'Groq request rejected by local token budget'
          : 'Groq transport unavailable',
        facts
      );
    }
  } catch {
    /* Diagnostics must not change transport behavior or print the failed logger's arguments. */
  }
}

const quotaSamples = new Map<string, number>();

/** Sample actual provider quota headers once per organization/model/minute.
 * The group fingerprint is used only as a local key and never logged.
 */
export function reportGroqPoolQuota(
  input: Parameters<typeof groqPoolFailureFacts>[0] & { group: string }
): void {
  try {
    const facts = groqPoolFailureFacts(input);
    if (facts.tokenLimit === undefined && facts.requestLimit === undefined) return;
    const now = Date.now();
    const key = input.group + ':' + facts.model;
    const previous = quotaSamples.get(key);
    if (previous !== undefined && now - previous < 60_000) return;
    if (quotaSamples.size >= 256) {
      for (const [id, sampledAt] of quotaSamples) {
        if (now - sampledAt >= 60_000) quotaSamples.delete(id);
      }
      if (quotaSamples.size >= 256) return;
    }
    quotaSamples.set(key, now);
    log.info('Groq provider quota observed', facts);
  } catch {
    // Monitoring cannot interrupt the inference.
  }
}
