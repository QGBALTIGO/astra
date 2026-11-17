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

// A representative 2,930-token local request took 19.22 seconds on the
// installed PC. Keep a bounded allowance for inference and the private relay;
// healthy cloud requests still return immediately without entering this route.
export const ASTRA_LOCAL_FALLBACK_TIMEOUT_MS = 35_000;
export const ASTRA_LOCAL_FALLBACK_MAX_TOKENS = 768;
export const ASTRA_CHANNEL_FALLBACK_MAX_BUDGET_MS = 75_000;
export const ASTRA_CLOUDFLARE_TIMEOUT_MS = 12_000;
export const ASTRA_CHANNEL_FALLBACK_WITH_CLOUDFLARE_BUDGET_MS = 24_000;
export const ASTRA_CHANNEL_OTHER_CLOUD_WITH_CLOUDFLARE_TIMEOUT_MS = 7_000;

/** Preserve the local attempt's time after the configured cloud attempts. */
export function astraChannelFallbackBudgetMs(
  primaryTimeoutMs: number,
  fallbackTimeoutsMs: readonly number[]
): number {
  return Math.min(
    ASTRA_CHANNEL_FALLBACK_MAX_BUDGET_MS,
    primaryTimeoutMs + fallbackTimeoutsMs.reduce((total, timeout) => total + timeout, 0) + 1_000
  );
}

/**
 * Cloud-only budget for providers that passed credential/endpoint checks.
 * A chain with local inference must instead sum its actual attempt timeouts.
 */
export function getAstraChannelFallbackBudget(providerIds: readonly string[]): number {
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
  explicitFallback?: AstraFallbackRoute
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
    else if (routes.length < 5) routes.push(candidate);
  }
  // Local inference must never displace a healthy cloud attempt, even if a
  // stored explicit fallback or the environment lists it first.
  return localReserve ? [...routes.slice(0, 4), localReserve] : routes;
}
