/**
 * Shared CORS origin sanitization helper (CORS-001).
 *
 * Lives in utils/ rather than app.ts so the WS server can import it
 * without re-introducing the app.ts ↔ ws/server.ts cycle that
 * `wsGateway` already creates from the other direction.
 */

/**
 * Parse the CORS_ORIGINS env value and return only entries that look like
 * a valid http(s) origin. Strips:
 *   - wildcard ('*') — combined with `credentials: true` on the cors()
 *     middleware, allowing '*' is a confusing trap. Browsers refuse the
 *     response, but the operator may believe every origin is whitelisted.
 *   - non-http(s) schemes (file:, chrome:, etc.)
 *   - unparseable junk (e.g. "https//bad.com" typo)
 *   - empty/whitespace-only entries
 *
 * Used by both DEFAULT_CONFIG and server.ts loadConfig() so a
 * CORS_ORIGINS containing '*' cannot survive into the running app.
 */
export function sanitizeCorsOriginsFromEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((origin) => {
      if (origin === '*') return false;
      try {
        const url = new URL(origin);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    });
}
