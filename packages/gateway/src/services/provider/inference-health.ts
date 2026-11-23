/**
 * Real, bounded inference health checks for the configured free Astra routes.
 * A models-list response is not proof that inference or quota is available.
 * Probes never use customer data or tools and yield to active channel traffic.
 */
import { createProvider, type ProviderConfig } from '@ownpilot/core/agent';
import { getLog } from '../log.js';
import { createInferenceObserver } from './inference-accounting.js';
import { getChannelAIAdmissionStats } from '../../channels/channel-ai-admission.js';
import { getAstraAiRoutingReadiness } from '../ai-routing-readiness.js';
import { getProviderApiKey, loadProviderConfig, NATIVE_PROVIDERS } from '../agent/cache.js';
import { getResolvedAuth } from '../app-settings.js';
import { isAllowedFreeRoute, type AstraFallbackRoute } from '../agent/fallback-chain.js';

const log = getLog('ProviderInferenceHealth');
const PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 60 * 60_000;

export interface InferenceProbeResult {
  provider: string;
  model: string;
  status: 'ok' | 'unavailable' | 'skipped';
  latencyMs: number;
}

interface ProbeDependencies {
  routes: () => Promise<AstraFallbackRoute[]>;
  customerBusy: () => boolean;
  probe: (route: AstraFallbackRoute, signal: AbortSignal) => Promise<boolean>;
}

async function configuredRoutes(): Promise<AstraFallbackRoute[]> {
  const readiness = await getAstraAiRoutingReadiness();
  return [
    ...(readiness.chat.primaryReady && readiness.chat.primary ? [readiness.chat.primary] : []),
    ...readiness.chat.fallbackChain,
    ...(readiness.whatsappDefault.primaryReady && readiness.whatsappDefault.primary
      ? [readiness.whatsappDefault.primary]
      : []),
    ...readiness.whatsappDefault.fallbackChain,
  ];
}

async function probeRoute(route: AstraFallbackRoute, signal: AbortSignal): Promise<boolean> {
  const auth = await getResolvedAuth(route.provider);
  const apiKey = auth?.value ?? (await getProviderApiKey(route.provider));
  const config = loadProviderConfig(route.provider);
  if (!apiKey || (!config?.baseUrl && !NATIVE_PROVIDERS.has(route.provider))) return false;
  signal.throwIfAborted();
  const provider = createProvider({
    id: route.provider,
    onInferenceAttempt: createInferenceObserver(null, 'health'),
    provider: (NATIVE_PROVIDERS.has(route.provider)
      ? route.provider
      : (config?.type ?? 'openai-compatible')) as ProviderConfig['provider'],
    apiKey,
    resolvedAuth: auth ?? undefined,
    baseUrl: config?.baseUrl,
    headers: config?.headers,
    defaultModel: { model: route.model, maxTokens: 256 },
    timeout: PROBE_TIMEOUT_MS,
    maxRetries: 0,
  });
  const result = await provider.complete({
    model: { model: route.model, maxTokens: 256 },
    messages: [{ role: 'user', content: 'Reply with OK only.' }],
    signal,
    toolChoice: 'none',
  });
  return (
    result.ok &&
    result.value.finishReason === 'stop' &&
    !result.value.toolCalls?.length &&
    result.value.content.trim().toUpperCase() === 'OK'
  );
}

const defaults: ProbeDependencies = {
  routes: configuredRoutes,
  customerBusy: () => {
    const stats = getChannelAIAdmissionStats();
    return stats.active > 0 || stats.queued > 0;
  },
  probe: probeRoute,
};

export async function checkProviderInference(
  deps: ProbeDependencies = defaults,
  signal?: AbortSignal
): Promise<InferenceProbeResult[]> {
  if (signal?.aborted || deps.customerBusy()) return [];
  const seen = new Set<string>();
  const results: InferenceProbeResult[] = [];
  for (const route of await deps.routes()) {
    if (signal?.aborted) break;
    if (!isAllowedFreeRoute(route)) continue; // Never spend on a paid/default model.
    const key = JSON.stringify([route.provider, route.model]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (deps.customerBusy()) {
      results.push({ ...route, status: 'skipped', latencyMs: 0 });
      continue;
    }
    const start = Date.now();
    const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const probeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let status: InferenceProbeResult['status'] = 'unavailable';
    try {
      if (await deps.probe(route, probeSignal)) status = 'ok';
    } catch {
      // Do not log upstream response bodies, credentials, or raw error text.
    }
    if (signal?.aborted) break;
    results.push({ ...route, status, latencyMs: Date.now() - start });
  }
  return results;
}

/** Start after boot without blocking it; never overlap cycles or keep Node alive. */
export function startProviderInferenceHealthChecks(deps: ProbeDependencies = defaults): () => void {
  const raw = Number(process.env.ASTRA_AI_INFERENCE_HEALTH_INTERVAL_MS);
  const interval = Number.isSafeInteger(raw) && raw >= 15 * 60_000 ? raw : DEFAULT_INTERVAL_MS;
  const controller = new AbortController();
  let running = false;
  const tick = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      for (const result of await checkProviderInference(deps, controller.signal)) {
        if (result.status === 'unavailable') log.warn('Astra inference probe unavailable', result);
        else log.info('Astra inference probe', result);
      }
    } catch {
      log.warn('Astra inference probe cycle could not complete');
    } finally {
      running = false;
    }
  };
  if (process.env.ASTRA_AI_INFERENCE_HEALTH_ENABLED === 'false') return () => controller.abort();
  const first = setTimeout(() => void tick(), 120_000);
  const timer = setInterval(() => void tick(), interval);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    controller.abort();
  };
}
