import { groqPoolRequestFacts } from './groq-pool-telemetry.js';
import { groqQuotaRequestTokenLimit } from './groq-admission.js';

/** A useful answer allowance; explicitly smaller caller limits remain smaller. */
export const GROQ_MIN_OUTPUT_TOKENS = 1024;

/** Invalid/absent operator settings leave provider and tenant defaults unchanged. */
export function getGroqRequestTokenLimit(
  value: string | undefined = process.env.GROQ_MAX_REQUEST_TOKENS
): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

/** The same per-request ceiling for prompt planning and transport admission. */
export function getGroqEffectiveRequestTokenLimit(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  return Math.min(
    getGroqRequestTokenLimit(env.GROQ_MAX_REQUEST_TOKENS) ?? Number.POSITIVE_INFINITY,
    groqQuotaRequestTokenLimit(env)
  );
}

/**
 * Fit a chat output ceiling inside the operator's estimated total-token budget.
 * Never discard messages/tool receipts, mutate the caller's request, or reduce a
 * normal answer to a token fragment. Audio/FormData uses the same transport and
 * must remain outside this chat-only adjustment.
 */
export function applyGroqRequestBudget(
  body: RequestInit['body'],
  limit: number | undefined
): { body: RequestInit['body']; request: ReturnType<typeof groqPoolRequestFacts> } {
  const original = { body, request: groqPoolRequestFacts(body) };
  if (limit === undefined || typeof body !== 'string') return original;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return original;
    payload = parsed as Record<string, unknown>;
  } catch {
    return original;
  }
  if (!Array.isArray(payload.messages)) return original;

  const completion = payload.max_completion_tokens;
  const legacy = payload.max_tokens;
  const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  // Do not silently repair invalid caller parameters; normal provider validation
  // still applies. When both valid aliases exist, the current alias wins.
  if (
    (completion !== undefined && !positive(completion)) ||
    (legacy !== undefined && !positive(legacy))
  )
    return original;
  const field = completion !== undefined ? 'max_completion_tokens' : 'max_tokens';
  const requested = (completion ?? legacy ?? GROQ_MIN_OUTPUT_TOKENS) as number;
  const minimum = Math.min(requested, GROQ_MIN_OUTPUT_TOKENS);
  const next = { ...payload, [field]: requested };
  delete next[field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'];
  // Include the complete serialized request, including tools and the output
  // parameter itself. Lowering the integer cannot increase this estimate.
  const planned = groqPoolRequestFacts(JSON.stringify(next));
  const available = Math.floor(limit - planned.requestTokensApprox);
  if (available < minimum) {
    // Preserve a real reserved allowance so the final admission check rejects
    // this request even when the caller omitted an output limit.
    const rejectedBody = JSON.stringify(next);
    return { body: rejectedBody, request: planned };
  }
  next[field] = Math.min(requested, available);
  const adjustedBody = JSON.stringify(next);
  return { body: adjustedBody, request: groqPoolRequestFacts(adjustedBody) };
}

/**
 * Transport-only compaction for opted-in customer conversations.
 *
 * Preserve all leading system messages, the previous user turn, and the
 * complete active turn including every assistant tool call and tool receipt.
 * Only remove an older turn if its tool-call/result pairs are complete and
 * it ended with an assistant answer. Never truncate user text, tool schemas,
 * or receipts. If the protected context still cannot fit, keep the original
 * request so the normal provider fallback receives all available context.
 */
export function fitGroqChannelHistory(body: string, limit: number): string {
  const fits = (candidate: string): boolean => {
    const { request } = applyGroqRequestBudget(candidate, limit);
    return request.requestTokensApprox + request.maxOutputTokens <= limit;
  };
  if (!Number.isFinite(limit) || limit <= 0 || fits(body)) return body;

  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    if (!payload || !Array.isArray(payload.messages)) return body;
    const messages = payload.messages as Array<Record<string, unknown>>;
    if (messages.some((message) => !message || typeof message !== 'object')) return body;
    const firstUser = messages.findIndex((message) => message.role === 'user');
    if (firstUser < 0) return body;
    const leading = messages.slice(0, firstUser);
    if (leading.some((message) => message.role !== 'system')) return body;
    if (
      messages
        .slice(firstUser)
        .some((message) => !['user', 'assistant', 'tool'].includes(String(message.role)))
    )
      return body;
    const starts = messages.flatMap((message, index) => (message.role === 'user' ? [index] : []));
    if (starts.length < 3) return body;

    // Only complete, structurally valid historical turns may be omitted.
    const complete = (turn: Array<Record<string, unknown>>): boolean => {
      const last = turn.at(-1);
      if (last?.role !== 'assistant' || last.tool_calls) return false;
      const pending = new Set<string>();
      for (const message of turn) {
        if (message.role === 'assistant') {
          if (pending.size) return false;
          if (message.tool_calls !== undefined) {
            if (!Array.isArray(message.tool_calls)) return false;
            for (const call of message.tool_calls) {
              const id = call?.id;
              if (typeof id !== 'string' || !id || pending.has(id)) return false;
              pending.add(id);
            }
          }
        } else if (message.role === 'tool') {
          if (typeof message.tool_call_id !== 'string' || !pending.delete(message.tool_call_id))
            return false;
        }
      }
      return pending.size === 0;
    };

    for (let index = 1; index <= starts.length - 2; index++) {
      if (!complete(messages.slice(starts[index - 1], starts[index]))) break;
      const candidate = JSON.stringify({
        ...payload,
        messages: [...leading, ...messages.slice(starts[index])],
      });
      if (fits(candidate)) return candidate;
    }
  } catch {
    // Leave malformed or unsupported payloads to existing transport validation.
  }
  return body;
}
