/** Local Groq admission is not evidence that a provider is unhealthy. */
export function localGroqAdmissionReason(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : '';
  if (
    /(?:API error:?|stream error:?|HTTP)\s*413\b/i.test(text) &&
    /\brequest_too_large: groq_local_admission\b/i.test(text)
  )
    return 'local_payload_budget';
  if (!/(?:API error:?|stream error:?|HTTP)\s*429\b/i.test(text)) return undefined;
  const reason = /\bGroq local admission (concurrency|quota|cooldown|capacity)\./i.exec(text)?.[1];
  return reason ? 'local_admission_' + reason.toLowerCase() : undefined;
}

/** Allowlisted diagnostics only: upstream errors can echo user messages and secrets. */
export function providerErrorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  const status = /(?:API error:|stream error:|HTTP)\s*([45]\d{2})\b/i.exec(text)?.[1];
  const category =
    localGroqAdmissionReason(error) ??
    (/429|rate.limit/i.test(text)
      ? 'rate_limited'
      : /timeout|timed out/i.test(text)
        ? 'timeout'
        : /tool.*(?:contract|call)|required tool/i.test(text)
          ? 'tool_contract'
          : 'provider_failure');
  return status ? `${category} (HTTP ${status})` : category;
}
