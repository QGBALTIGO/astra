/**
 * Trusted proxy / client-IP resolution (RATE-002, RATE-003).
 *
 * Without a proxy, the only meaningful identity we can assign to a request is
 * the socket peer address — which Node exposes but Hono doesn't expose
 * directly through `c.req`. When a reverse proxy is in front of us, we can
 * accept its `X-Forwarded-For` header — but ONLY with a trusted ingress that
 * overwrites forwarding headers. Otherwise a direct client could spoof XFF
 * and bypass per-IP rate limiting and login throttles.
 *
 * Configuration:
 *   TRUSTED_PROXY=true            — opt in to trusting proxy headers at all.
 *   TRUSTED_PROXY_IPS=ip1,ip2     — comma-separated list of immediate-upstream
 *                                   proxy IPs. Required when TRUSTED_PROXY=true;
 *                                   if missing, we fail safe and ignore XFF.
 *
 * This header-only helper does NOT verify the socket peer against that list.
 * Proxy mode therefore requires an ingress that overwrites these headers and
 * cannot be bypassed by untrusted direct/private-network clients. Railway's
 * public HTTP edge meets that header contract; its private network does not.
 * Do not treat TRUSTED_PROXY_IPS as a socket firewall or invent edge CIDRs.
 *
 * Without socket peer access (the typical Hono case), we:
 *   - When TRUSTED_PROXY=true AND TRUSTED_PROXY_IPS is set, take the LAST
 *     entry in `X-Forwarded-For` (closest to our edge — appended by the
 *     trusted proxy itself when that ingress contract holds) rather than the first
 *     entry (client-claimed, fully spoofable).
 *   - Otherwise fall back to a stable bucket key ('direct').
 */

import { getLog } from '../services/log.js';
import { isIP } from 'node:net';
const log = getLog('ClientIP');

const TRUST_PROXY = process.env.TRUSTED_PROXY === 'true';
// Railway's documented edge identity is X-Real-IP. An explicit selection
// prevents an untrusted, merely forwarded XFF header from taking precedence.
const USE_REAL_IP_ONLY = process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase() === 'x-real-ip';
const RAW_TRUSTED_PROXY_IPS = process.env.TRUSTED_PROXY_IPS ?? '';
const TRUSTED_PROXY_IPS = RAW_TRUSTED_PROXY_IPS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/**
 * Whether proxy-aware IP extraction has explicitly been enabled.
 * `TRUSTED_PROXY=true` without `TRUSTED_PROXY_IPS` is unsafe — we ignore XFF.
 * This checks configuration, not the network peer; see the trust boundary above.
 */
export function isProxyAwareConfigured(): boolean {
  return TRUST_PROXY && TRUSTED_PROXY_IPS.length > 0;
}

/** Bound identity size and collapse equivalent textual IPv6 spellings. */
function normalizeIp(raw: string | undefined): string {
  const address = raw?.trim() ?? '';
  if (address.length > 45) return 'direct';
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return 'direct';

  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    // IPv4-mapped IPv6 and plain IPv4 identify the same remote client.
    const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(canonical);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16);
      const low = parseInt(mapped[2]!, 16);
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
    return canonical;
  } catch {
    return 'direct';
  }
}

let warnedMisconfig = false;
function warnIfMisconfigured(): void {
  if (TRUST_PROXY && TRUSTED_PROXY_IPS.length === 0 && !warnedMisconfig) {
    warnedMisconfig = true;

    log.warn(
      '[client-ip] TRUSTED_PROXY=true but TRUSTED_PROXY_IPS is empty — ' +
        'X-Forwarded-For will be IGNORED (fail-safe). Set TRUSTED_PROXY_IPS to ' +
        'a comma-separated list of your reverse-proxy IPs to enable per-IP ' +
        'rate limiting / login throttle.'
    );
  }
}

/**
 * Get a stable client identity from a Hono-style header reader.
 *
 * Returns:
 *   - Last entry of `X-Forwarded-For` (or `X-Real-IP`) when proxy trust is
 *     correctly configured.
 *   - 'direct' otherwise (single-bucket fallback). When this happens, callers
 *     that care about per-client granularity should be aware that all
 *     attackers share the same bucket — but that's safer than the alternative
 *     (every attacker rotates X-Forwarded-For and bypasses the limiter).
 */
export function getClientIp(req: { header: (name: string) => string | undefined }): string {
  warnIfMisconfigured();

  if (!isProxyAwareConfigured()) return 'direct';

  if (USE_REAL_IP_ONLY) {
    return normalizeIp(req.header('X-Real-IP'));
  }

  const xff = req.header('X-Forwarded-For');
  if (xff) {
    // Only the nearest hop matters. Avoid allocating an array for an arbitrary
    // number of client-supplied preceding values; a malformed last hop fails closed.
    return normalizeIp(xff.slice(xff.lastIndexOf(',') + 1));
  }

  const xrealip = req.header('X-Real-IP');
  if (xrealip) return normalizeIp(xrealip);

  return 'direct';
}
