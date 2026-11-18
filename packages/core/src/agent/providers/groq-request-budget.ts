import { groqPoolRequestFacts } from './groq-pool-telemetry.js';

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
