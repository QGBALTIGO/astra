/**
 * Safe, explicitly free Astra model failover chain.
 *
 * A provider's configured API key does NOT grant permission to spend credits.
 * Never infer a default model from the model catalog (many defaults are paid).
 * Review these exact model IDs against the providers' current free-tier terms.
 */
export interface AstraFallbackRoute {
  provider: string;
  model: string;
}

// The installed private relay measured about 12 seconds. Only an explicitly
// selected last resort gets this allowance; healthy cloud calls never wait for it.
export const ASTRA_LOCAL_FALLBACK_TIMEOUT_MS = 16_000;
export const ASTRA_LOCAL_FALLBACK_MAX_TOKENS = 768;
export const ASTRA_CHANNEL_FALLBACK_WITH_LOCAL_BUDGET_MS = 26_000;
export const ASTRA_CLOUDFLARE_TIMEOUT_MS = 12_000;
export const ASTRA_CHANNEL_FALLBACK_WITH_CLOUDFLARE_BUDGET_MS = 24_000;
export const ASTRA_CHANNEL_OTHER_CLOUD_WITH_CLOUDFLARE_TIMEOUT_MS = 7_000;

/** Call only with providers that have already passed credential/endpoint checks. */
export function getAstraChannelFallbackBudget(providerIds: readonly string[]): number {
  if (providerIds.includes('ollama-local')) return ASTRA_CHANNEL_FALLBACK_WITH_LOCAL_BUDGET_MS;
  return providerIds.includes('cloudflare-workers-ai')
    ? ASTRA_CHANNEL_FALLBACK_WITH_CLOUDFLARE_BUDGET_MS
    : 16_000;
}

const ALLOWED_FREE_MODELS: Readonly<Record<string, ReadonlySet<string>>> = {
  zai: new Set(['glm-4.7-flash', 'glm-4.5-flash']),
  openrouter: new Set(['openrouter/free']),
  google: new Set(['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']),
  // Groq Free Plan includes these models within rate limits. Explicit opt-in
  // only: API keys may also belong to paid Developer plans.
  groq: new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']),
  // Workers AI has an account-wide daily free allowance. Explicit opt-in only;
  // the operator must keep the Cloudflare account on the Free plan.
  'cloudflare-workers-ai': new Set(['@cf/zai-org/glm-4.7-flash']),
  // Operator-hosted, not a hosted paid tier. Keep the installed model exact
  // and require its own configured credential and guarded loopback relay.
  'ollama-local': new Set(['qwen3:4b-instruct']),
};

function isAllowedFreeRoute(route: AstraFallbackRoute): boolean {
  return (
    ALLOWED_FREE_MODELS[route.provider]?.has(route.model) === true ||
    (route.provider === 'openrouter' && /^[a-z0-9._/-]+:free$/.test(route.model))
  );
}

/** Limit usable reserves, preserving cloud priority and keeping local inference last. */
export function limitAstraFallbacks<T>(
  candidates: readonly T[],
  providerId: (candidate: T) => string | undefined
): T[] {
  const local = candidates.find((candidate) => providerId(candidate) === 'ollama-local');
  const cloud = candidates
    .filter((candidate) => providerId(candidate) !== 'ollama-local')
    .slice(0, local ? 4 : 5);
  return local ? [...cloud, local] : cloud;
}

/**
 * ASTRA_FALLBACK_CHAIN is a comma-separated provider=model list.
 * For example: zai=glm-4.7-flash,openrouter=openrouter/free.
 *
 * When this environment switch is absent, preserve the existing explicitly
 * configured fallback behavior. With it enabled, never route to a paid model,
 * even if a stored channel fallback used to point to one.
 */
export function parseAstraFallbackChain(
  chain: string | undefined,
  primaryProvider: string,
  explicitFallback?: AstraFallbackRoute,
  options?: { deferLimit?: boolean }
): AstraFallbackRoute[] {
  if (!chain?.trim()) {
    return explicitFallback &&
      (explicitFallback.provider !== 'ollama-local' || isAllowedFreeRoute(explicitFallback))
      ? [explicitFallback]
      : [];
  }

  const entries = [
    ...(explicitFallback ? [explicitFallback] : []),
    ...chain.split(',').map((item): AstraFallbackRoute => {
      const separator = item.indexOf('=');
      if (separator < 1 || item.indexOf('=', separator + 1) >= 0) {
        return { provider: '', model: '' };
      }
      return {
        provider: item.slice(0, separator).trim().toLowerCase(),
        model: item.slice(separator + 1).trim(),
      };
    }),
  ];
  const routes: AstraFallbackRoute[] = [];
  let localReserve: AstraFallbackRoute | undefined;
  const seen = new Set<string>([primaryProvider]);
  for (const candidate of entries) {
    // Never allow two provider slots for the same key/rate-limit pool.
    if (seen.has(candidate.provider) || !isAllowedFreeRoute(candidate)) continue;
    seen.add(candidate.provider);
    if (candidate.provider === 'ollama-local') localReserve = candidate;
    else routes.push(candidate);
  }
  // Local inference must never displace a healthy cloud attempt, even if a
  // stored explicit fallback or the environment lists it first.
  const ordered = localReserve ? [...routes, localReserve] : routes;
  // Runtime callers filter credentials/endpoints first, so unavailable entries
  // cannot consume one of the five slots. Policy validation/deduplication still
  // happens here even when the size limit is deferred.
  return options?.deferLimit ? ordered : limitAstraFallbacks(ordered, (route) => route.provider);
}
