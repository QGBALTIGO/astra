/**
 * Trusted-proxy aware request origin / URL helpers.
 *
 * `X-Forwarded-Proto` and `X-Forwarded-Host` are honored ONLY when a trusted
 * proxy is configured via `TRUSTED_PROXY=true` + `TRUSTED_PROXY_IPS` and all
 * requests arrive through an ingress that overwrites those headers (see the
 * header-only trust boundary in utils/client-ip.ts). When directly exposed, these
 * headers are attacker-controllable and must be ignored.
 *
 * Used by:
 *   - SMS (Twilio) webhook signature verification — webhook URL reconstruction
 *   - UI session CSRF check — canonical request origin comparison
 *   - UI session cookie Secure flag — protocol detection
 */

import { isProxyAwareConfigured } from './client-ip.js';

interface RequestLike {
  url: string;
  header: (name: string) => string | undefined;
}

function forwardedProtocol(req: RequestLike): 'http' | 'https' | undefined {
  const value = req.header('X-Forwarded-Proto') ?? req.header('X-Forwarded-Scheme');
  if (value && /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const protocol = value?.trim().toLowerCase();
  return protocol === 'http' || protocol === 'https' ? protocol : undefined;
}

/**
 * Resolve the canonical external request origin (scheme + host[:port]).
 *
 * When a trusted proxy is configured, honors `X-Forwarded-Proto` /
 * `X-Forwarded-Host`. Otherwise falls back to the URL the request was
 * received on.
 */
export function getRequestOrigin(req: RequestLike): string {
  const url = new URL(req.url);
  if (isProxyAwareConfigured()) {
    const protocol = forwardedProtocol(req);
    const rawHost = req.header('X-Forwarded-Host');
    const host = rawHost?.trim();
    // A forwarded host must be one host[:port], never an origin, userinfo,
    // comma-separated chain or path. URL validation also rejects invalid ports
    // and IPv6 syntax. Malformed metadata falls back to the received origin.
    if (
      protocol &&
      host &&
      host.length <= 512 &&
      !/[\u0000-\u001f\u007f]/.test(rawHost!) &&
      !/[\s,/@\\?#]/.test(host) &&
      !host.endsWith(':')
    ) {
      try {
        return new URL(`${protocol}://${host}`).origin;
      } catch {
        // Ignore malformed forwarding metadata.
      }
    }
  }
  return url.origin;
}

/**
 * Reconstruct the full external URL for a request (origin + path).
 *
 * Used by webhook signature verification where the external URL is part of
 * the signed payload (e.g., Twilio).
 */
export function getRequestUrl(req: RequestLike, path: string): string {
  return `${getRequestOrigin(req)}${path}`;
}

/**
 * Determine whether the request was received over HTTPS, taking into account
 * a trusted reverse proxy that may be terminating TLS.
 */
export function isSecureRequest(req: RequestLike): boolean {
  if (req.url.startsWith('https://')) return true;
  if (isProxyAwareConfigured() && forwardedProtocol(req) === 'https') {
    return true;
  }
  return false;
}
