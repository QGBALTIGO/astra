/** Groq-specific controls; never send vendor parameters to unrelated transports. */
export function groqResponseOptions(
  baseUrl: string | undefined,
  model: string,
  maxTokens?: number
): Record<string, unknown> {
  let groq = false;
  try {
    groq = new URL(baseUrl ?? '').hostname === 'api.groq.com';
  } catch {
    return {};
  }
  if (!groq) return {};
  if (/^openai\/gpt-oss-(?:20b|120b)$/.test(model)) {
    return {
      include_reasoning: false,
      ...(maxTokens !== undefined && maxTokens <= 1024 ? { reasoning_effort: 'low' } : {}),
    };
  }
  if (model === 'qwen/qwen3.8-27b')
    return { reasoning_format: 'hidden', reasoning_effort: 'default' };
  return {};
}
