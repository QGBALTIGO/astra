import { createProvider, type ProviderConfig } from '@ownpilot/core/agent';
import { resolveForChannel } from '../services/llm/model-routing.js';
import {
  getProviderApiKey,
  loadProviderConfig,
  NATIVE_PROVIDERS,
} from '../services/agent/cache.js';
import { resolveAuthForRequest } from '../services/auth/oauth-flow.js';

/** A single stateless text completion on the configured channel route. Never executes tools. */
export async function writeShortChannelReply(
  channel: string,
  system: string,
  prompt: string,
  tokens: number,
  deadline: number,
  responseFormat: 'text' | 'json' = 'text'
): Promise<string | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      complete(channel, system, prompt, tokens, deadline, responseFormat),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function complete(
  channel: string,
  system: string,
  prompt: string,
  tokens: number,
  deadline: number,
  responseFormat: 'text' | 'json'
): Promise<string | null> {
  const { provider, model } = await resolveForChannel(channel);
  if (!provider || !model || provider.startsWith('cli-')) return null;
  const config = loadProviderConfig(provider);
  const native = NATIVE_PROVIDERS.has(provider);
  if (!native && !config?.baseUrl) return null;
  const resolvedAuth = await resolveAuthForRequest(provider);
  const apiKey = resolvedAuth?.value ?? (await getProviderApiKey(provider));
  const remaining = deadline - Date.now();
  if (!apiKey || remaining <= 0) return null;
  const writer = createProvider({
    ...config,
    id: provider,
    provider: (native ? provider : 'openai') as ProviderConfig['provider'],
    apiKey,
    resolvedAuth,
    timeout: remaining,
    maxRetries: 0,
    headers: {
      ...config?.headers,
      ...(provider === 'ollama-local' ? { 'X-Astra-Deadline': String(deadline) } : {}),
    },
  });
  const result = await writer.complete({
    model: {
      model,
      maxTokens: tokens,
      temperature: responseFormat === 'json' ? 0 : 0.75,
      responseFormat,
    },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  });
  return result.ok ? result.value.content.trim() : null;
}
