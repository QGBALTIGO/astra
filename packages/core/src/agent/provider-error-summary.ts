/** Allowlisted diagnostics only: upstream errors can echo user messages and secrets. */
export function providerErrorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  const status = /(?:API error:|stream error:|HTTP)\s*([45]\d{2})\b/i.exec(text)?.[1];
  const category = /429|rate.limit/i.test(text)
    ? 'rate_limited'
    : /timeout|timed out/i.test(text)
      ? 'timeout'
      : /tool.*(?:contract|call)|required tool/i.test(text)
        ? 'tool_contract'
        : 'provider_failure';
  return status ? `${category} (HTTP ${status})` : category;
}
