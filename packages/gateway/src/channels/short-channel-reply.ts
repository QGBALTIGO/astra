import { createProvider, createFallbackProvider, type ProviderConfig } from '@ownpilot/core/agent';
import { parseAstraFallbackChain } from '../services/agent/fallback-chain.js';
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
  responseFormat: 'text' | 'json' = 'text',
  temperature = 0.75
): Promise<string | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      complete(channel, system, prompt, tokens, deadline, responseFormat, temperature),
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
  responseFormat: 'text' | 'json',
  temperature: number
): Promise<string | null> {
  const { provider, model, fallbackProvider, fallbackModel } = await resolveForChannel(channel);
  if (!provider || !model || provider.startsWith('cli-')) return null;
  const config = loadProviderConfig(provider);
  const native = NATIVE_PROVIDERS.has(provider);
  if (!native && !config?.baseUrl) return null;
  const resolvedAuth = await resolveAuthForRequest(provider);
  const apiKey = resolvedAuth?.value ?? (await getProviderApiKey(provider));
  const remaining = deadline - Date.now();
  if (!apiKey || remaining <= 0) return null;
  const primary: ProviderConfig = {
    id: provider,
    provider: (native ? provider : (config?.type ?? 'openai')) as ProviderConfig['provider'],
    baseUrl: config?.baseUrl,
    endpoint: config?.endpoint,
    features: config?.features,
    apiKey,
    resolvedAuth,
    defaultModel: { model },
    timeout: Math.min(remaining, 2500),
    maxRetries: 0,
    headers: {
      ...config?.headers,
      ...(provider === 'ollama-local' ? { 'X-Astra-Deadline': String(deadline) } : {}),
    },
  };
  const fallbacks: ProviderConfig[] = [];
  for (const candidate of parseAstraFallbackChain(
    process.env.ASTRA_FALLBACK_CHAIN,
    provider,
    fallbackProvider && fallbackModel
      ? { provider: fallbackProvider, model: fallbackModel }
      : undefined
  )) {
    const fbAuth = await resolveAuthForRequest(candidate.provider);
    const fbKey = fbAuth?.value ?? (await getProviderApiKey(candidate.provider));
    const fb = loadProviderConfig(candidate.provider);
    if (!fbKey || (!fb?.baseUrl && !NATIVE_PROVIDERS.has(candidate.provider))) continue;
    fallbacks.push({
      id: candidate.provider,
      provider: (NATIVE_PROVIDERS.has(candidate.provider)
        ? candidate.provider
        : (fb?.type ?? 'openai-compatible')) as ProviderConfig['provider'],
      apiKey: fbKey,
      resolvedAuth: fbAuth,
      baseUrl: fb?.baseUrl,
      headers: fb?.headers,
      defaultModel: { model: candidate.model },
      timeout: Math.min(remaining, 3000),
      maxRetries: 0,
    });
  }
  const writer = fallbacks.length
    ? createFallbackProvider({
        primary,
        fallbacks,
        circuitBreakerThreshold: 1,
        circuitBreakerCooldown: 300000,
        sharedCircuitBreaker: true,
        preferLastSuccessful: true,
        completionTimeoutMs: Math.max(1, deadline - Date.now()),
      })
    : createProvider(primary);
  const result = await writer.complete({
    model: {
      model,
      maxTokens: tokens,
      temperature: responseFormat === 'json' ? 0 : temperature,
      responseFormat,
    },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  });
  return result.ok ? result.value.content.trim() : null;
}
