import { getAllProviderConfigs } from '@ownpilot/core/agent';
import {
  getConfiguredProviderIds,
  getResolvedAuth,
  resolveDefaultProviderAndModel,
} from './app-settings.js';
import { getProviderApiKey, loadProviderConfig, NATIVE_PROVIDERS } from './agent/cache.js';
import {
  parseAstraFallbackChain,
  limitAstraFallbacks,
  type AstraFallbackRoute,
} from './agent/fallback-chain.js';
import { resolveForChannel, resolveForProcess } from './llm/model-routing.js';
import { getLog } from './log.js';

const log = getLog('AIRoutingReadiness');
const READINESS_TIMEOUT_MS = 3_000;

interface RoutingInput {
  provider: unknown;
  model: unknown;
  fallbackProvider?: unknown;
  fallbackModel?: unknown;
}

interface RouteReadiness {
  primary: AstraFallbackRoute | null;
  primaryReady: boolean;
  fallbackChain: AstraFallbackRoute[];
  /** Parsed routes whose identifiers cannot safely be reported from the catalog. */
  unrecognizedFallbackCount: number;
}

export interface AstraAiRoutingReadiness {
  globalDefault: AstraFallbackRoute | null;
  chat: RouteReadiness;
  /** Default text route; individual channel instances can have their own override. */
  whatsappDefault: RouteReadiness;
  configuredProviderIds: string[];
  unrecognizedConfiguredProviderCount: number;
  cloudflareReady: boolean;
}

/**
 * Configuration readiness, not an inference probe. Credentials and endpoints
 * are inspected only for presence and never included in the returned snapshot.
 * Values from settings/environment must match the shipped catalog before logging.
 */
export async function getAstraAiRoutingReadiness(): Promise<AstraAiRoutingReadiness> {
  const catalog = new Map<string, { id: string; models: Map<string, string> }>();
  for (const provider of getAllProviderConfigs()) {
    if (provider.id.trim() !== provider.id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider.id))
      continue;
    const models = new Map<string, string>();
    for (const model of provider.models) {
      if (model.id.trim() === model.id && /^[a-zA-Z0-9@][a-zA-Z0-9@._:/+-]{0,199}$/.test(model.id))
        models.set(model.id, model.id);
    }
    catalog.set(provider.id, { id: provider.id, models });
  }

  const canonicalRoute = (provider: unknown, model: unknown): AstraFallbackRoute | null => {
    if (typeof provider !== 'string' || typeof model !== 'string') return null;
    const knownProvider = catalog.get(provider);
    const knownModel = knownProvider?.models.get(model);
    return knownProvider && knownModel ? { provider: knownProvider.id, model: knownModel } : null;
  };

  const readiness = new Map<string, Promise<boolean>>();
  const providerReady = (provider: string): Promise<boolean> => {
    if (!catalog.has(provider)) return Promise.resolve(false);
    const existing = readiness.get(provider);
    if (existing) return existing;
    const pending = (async () => {
      // Mirror runtime credential precedence without refreshing OAuth tokens
      // or probing the provider while collecting startup diagnostics.
      const auth = await getResolvedAuth(provider);
      const apiKey = auth?.value ?? (await getProviderApiKey(provider));
      const config = loadProviderConfig(provider);
      return (
        typeof apiKey === 'string' &&
        apiKey.trim().length > 0 &&
        (!!config?.baseUrl || NATIVE_PROVIDERS.has(provider))
      );
    })();
    readiness.set(provider, pending);
    return pending;
  };

  const rawChain = process.env.ASTRA_FALLBACK_CHAIN;
  const inspectRoute = async (routing: RoutingInput): Promise<RouteReadiness> => {
    const primary = canonicalRoute(routing.provider, routing.model);
    const explicit =
      typeof routing.fallbackProvider === 'string' &&
      routing.fallbackProvider &&
      typeof routing.fallbackModel === 'string' &&
      routing.fallbackModel
        ? { provider: routing.fallbackProvider, model: routing.fallbackModel }
        : undefined;
    // Parsing preserves runtime priority, deduplication, free-model restrictions
    // and local-reserve ordering. An unknown model is omitted, never echoed.
    const candidates = parseAstraFallbackChain(
      rawChain,
      typeof routing.provider === 'string' ? routing.provider : '',
      explicit,
      { deferLimit: true }
    );
    const usableCandidates: AstraFallbackRoute[] = [];
    let unrecognizedFallbackCount = 0;
    for (const candidate of candidates) {
      const canonical = canonicalRoute(candidate.provider, candidate.model);
      if (!canonical) unrecognizedFallbackCount++;
      if (await providerReady(candidate.provider)) usableCandidates.push(candidate);
    }
    // A permitted model absent from the catalog still occupies a runtime slot.
    // Apply the runtime cap before removing values that cannot safely be logged.
    const fallbackChain = limitAstraFallbacks(usableCandidates, (candidate) => candidate.provider)
      .map((candidate) => canonicalRoute(candidate.provider, candidate.model))
      .filter((candidate): candidate is AstraFallbackRoute => candidate !== null);
    return {
      primary,
      primaryReady: primary ? await providerReady(primary.provider) : false,
      fallbackChain,
      unrecognizedFallbackCount,
    };
  };

  const [globalDefault, chat, whatsappDefault, configured] = await Promise.all([
    resolveDefaultProviderAndModel('default', 'default'),
    resolveForProcess('chat'),
    resolveForChannel('channel.whatsapp'),
    getConfiguredProviderIds(),
  ]);
  const [chatReadiness, whatsappReadiness, cloudflareReady] = await Promise.all([
    inspectRoute(chat),
    inspectRoute(whatsappDefault),
    providerReady('cloudflare-workers-ai'),
  ]);
  const configuredProviderIds = [...configured]
    .map((provider) => catalog.get(provider)?.id)
    .filter((provider): provider is string => provider !== undefined)
    .sort();
  return {
    globalDefault: canonicalRoute(globalDefault.provider, globalDefault.model),
    chat: chatReadiness,
    whatsappDefault: whatsappReadiness,
    configuredProviderIds,
    unrecognizedConfiguredProviderCount: configured.size - configuredProviderIds.length,
    cloudflareReady,
  };
}

/** Diagnostics are bounded and cannot turn a settings failure into a startup failure. */
export async function logAstraAiRoutingReadiness(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      getAstraAiRoutingReadiness(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('AI routing diagnostic timed out')),
          READINESS_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
    log.info('Astra AI routing ready', snapshot);
  } catch {
    // Error messages/stacks may contain credentials or raw configuration.
    log.warn('Astra AI routing readiness unavailable');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
