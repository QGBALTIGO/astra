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

const ALLOWED_FREE_MODELS: Readonly<Record<string, ReadonlySet<string>>> = {
  zai: new Set(['glm-4.7-flash', 'glm-4.5-flash']),
  openrouter: new Set(['openrouter/free']),
  google: new Set(['gemini-2.5-flash-lite', 'gemini-3.6-flash']),
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
  if (!chain?.trim()) return explicitFallback ? [explicitFallback] : [];

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
  const seen = new Set<string>([primaryProvider]);
  for (const candidate of entries) {
    // Never allow two provider slots for the same key/rate-limit pool.
    if (seen.has(candidate.provider) || !isAllowedFreeRoute(candidate)) continue;
    seen.add(candidate.provider);
    routes.push(candidate);
    if (routes.length === 5) break;
  }
  return routes;
}
