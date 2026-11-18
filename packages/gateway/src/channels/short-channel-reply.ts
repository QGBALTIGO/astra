import { createProvider, createFallbackProvider, type ProviderConfig } from '@ownpilot/core/agent';
import {
  parseAstraFallbackChain,
  limitAstraFallbacks,
  ASTRA_CLOUDFLARE_TIMEOUT_MS,
} from '../services/agent/fallback-chain.js';
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
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      complete(
        channel,
        system,
        prompt,
        tokens,
        deadline,
        responseFormat,
        temperature,
        controller.signal
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
          controller.abort();
        }, remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function complete(
  channel: string,
  system: string,
  prompt: string,
  tokens: number,
  deadline: number,
  responseFormat: 'text' | 'json',
  temperature: number,
  signal: AbortSignal
): Promise<string | null> {
  const { provider, model, fallbackProvider, fallbackModel } = await resolveForChannel(channel);
  if (signal.aborted || !provider || !model || provider.startsWith('cli-')) return null;
  const config = loadProviderConfig(provider);
  const native = NATIVE_PROVIDERS.has(provider);
  if (!native && !config?.baseUrl) return null;
  const resolvedAuth = await resolveAuthForRequest(provider);
  const apiKey = resolvedAuth?.value ?? (await getProviderApiKey(provider));
  const remaining = deadline - Date.now();
  if (signal.aborted || !apiKey || remaining <= 0) return null;
  const primary: ProviderConfig = {
    id: provider,
    provider: (native ? provider : (config?.type ?? 'openai')) as ProviderConfig['provider'],
    baseUrl: config?.baseUrl,
    endpoint: config?.endpoint,
    features: config?.features,
    apiKey,
    resolvedAuth,
    defaultModel: { model },
    timeout: Math.min(
      remaining,
      provider === 'cloudflare-workers-ai' ? ASTRA_CLOUDFLARE_TIMEOUT_MS : 2500
    ),
    maxRetries: 0,
    headers: {
      ...config?.headers,
      ...(provider === 'ollama-local' ? { 'X-Astra-Deadline': String(deadline) } : {}),
    },
  };
  const configuredFallbacks: ProviderConfig[] = [];
  for (const candidate of parseAstraFallbackChain(
    process.env.ASTRA_FALLBACK_CHAIN,
    provider,
    fallbackProvider && fallbackModel
      ? { provider: fallbackProvider, model: fallbackModel }
      : undefined,
    { deferLimit: true }
  )) {
    if (signal.aborted || deadline <= Date.now()) return null;
    const fbAuth = await resolveAuthForRequest(candidate.provider);
    const fbKey = fbAuth?.value ?? (await getProviderApiKey(candidate.provider));
    if (signal.aborted || deadline <= Date.now()) return null;
    const fb = loadProviderConfig(candidate.provider);
    if (!fbKey || (!fb?.baseUrl && !NATIVE_PROVIDERS.has(candidate.provider))) continue;
    configuredFallbacks.push({
      id: candidate.provider,
      provider: (NATIVE_PROVIDERS.has(candidate.provider)
        ? candidate.provider
        : (fb?.type ?? 'openai-compatible')) as ProviderConfig['provider'],
      apiKey: fbKey,
      resolvedAuth: fbAuth,
      baseUrl: fb?.baseUrl,
      headers: fb?.headers,
      defaultModel: { model: candidate.model },
      timeout: Math.min(
        remaining,
        candidate.provider === 'cloudflare-workers-ai' ? ASTRA_CLOUDFLARE_TIMEOUT_MS : 3000
      ),
      maxRetries: 0,
    });
  }
  const completionRemaining = deadline - Date.now();
  if (signal.aborted || completionRemaining <= 0) return null;
  const boundedPrimary = {
    ...primary,
    timeout: Math.min(primary.timeout!, completionRemaining),
  };
  const fallbacks = limitAstraFallbacks(configuredFallbacks, (candidate) => candidate.id);
  const writer = fallbacks.length
    ? createFallbackProvider({
        primary: boundedPrimary,
        fallbacks,
        circuitBreakerThreshold: 1,
        circuitBreakerCooldown: 300000,
        sharedCircuitBreaker: true,
        preferLastSuccessful: true,
        completionTimeoutMs: completionRemaining,
      })
    : createProvider(boundedPrimary);
  const result = await writer.complete({
    signal,
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
  // A successful transport can still end halfway through a word when the
  // generation reaches its token limit. Never publish that partial opening.
  return result.ok && result.value.finishReason === 'stop' ? result.value.content.trim() : null;
}
