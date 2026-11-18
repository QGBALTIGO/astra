# Astra security hardening — 2026-11-18

## Scope and evidence

This change hardens the gateway, its authentication and public HTTP/WebSocket
ingress, and the tools used to build the dashboard. The baseline was main commit
`89b668db15ebca8fb894e3da9fb9fb2cf7234381`, deployed as the compiled Node gateway
with one Railway replica. No attack payload was replayed against production.
Production verification uses harmless reads; abuse cases use local synthetic
requests and mocked accounts.

The reported Vite requests received the SPA HTML fallback. That behavior was
independently reproduced with harmless development-file paths. The historical
response bodies were unavailable, so those HTTP 200 statuses do not establish
code execution, exfiltration, or the absence of either. The deployed process is
the compiled gateway, not a Vite development server.

The managed Codex Security scanner was unavailable in this session. This is a
source review with regression tests and dependency/advisory checks, not a claim
that a managed scan completed or that every vulnerability has been found.

## Controls implemented

### Public HTTP routing and request budgets

- Reject malformed/oversized URLs and private or development file paths before
  request logging, request-body parsing, and filesystem access. This includes
  Vite internal paths, hidden files, source maps, and source/configuration files.
  The policy does not scan opaque OAuth query strings or implement a generic
  attack-payload blacklist.
- Preserve legitimate SPA deep links, dotted record identifiers, existing
  public assets, service routes, and the public `.well-known` namespace.
  Missing assets and service paths receive an actual 404 instead of the SPA.
- Apply the API/webhook request limiter before reading bodies. Add a separate
  public-page/asset budget of 1,200 requests per minute with a 1,800-request
  hard burst ceiling, per resolved client identity and per process. Existing
  API limits are preserved; health exclusions use exact probe paths.
- Bound limiter state without evicting active counters when identities churn.
  At capacity, new identities share a bounded overflow budget. Login lockouts
  also survive delayed failed attempts that finish after their original window.
- Bind decisions use the actual gateway host. A proxy-supplied loopback address
  does not bypass rate limiting. All supported forwarded IP sources receive
  syntax validation and equivalent IPv6/IPv4-mapped spellings are normalized.
- Production SPA fallback uses the startup HTML cache; development retains
  fresh reads to support UI rebuilds.
- Readiness probes share one database check in flight and cache success for
  two seconds, failure for one second. A burst of public probes cannot multiply
  the seven-table readiness check by the number of requests. Failures still
  return 503 and recover after the short failure TTL; responses are `no-store`.

### Sessions and authentication availability

- Newly generated session tokens retain 256 bits of cryptographic randomness
  and use a versioned SHA-256 database lookup hash. Existing tokens remain valid
  until their normal expiry; their original scrypt hashes are checked through
  bounded asynchronous work. Password hashes retain their strong scrypt settings.
- Bound concurrent session lookups, deduplicate identical requests, and limit
  legacy hashing concurrency and queue length. The negative cache is bounded
  and short-lived. Malformed session tokens are rejected before hashing.
- Report authentication saturation as retryable HTTP 503 with `Retry-After`,
  without clearing valid cookies or treating resource pressure as a bad password.
  The dashboard preserves an already confirmed session and backs off retries;
  the initial loading state does not grant unauthenticated access.
- Prevent a lookup in flight from repopulating a revoked session in the local
  cache. Positive entries revalidate within five minutes, even if the underlying
  session lasts seven or thirty days.
- HTTP password verification/hashing runs asynchronously with one active job
  and four queued jobs, retaining the existing scrypt parameters. Authentication
  pressure does not run expensive password hashing on the event loop. The HTTP
  password boundary now accepts at most 1,024 characters, an explicit tightening
  of the prior body-size-only limit.
- Password operations check the credential snapshot/generation across awaits
  and serialize mutations. Session creation that crosses revocation removes
  its newly inserted row and refuses to return a token, preventing a stale
  password check or delayed insert from minting a session after revocation.

### HTTP sockets and WebSockets

- Bound HTTP headers to 16 KiB, receipt of headers to 15 seconds, and receipt of
  a complete request to 120 seconds. Incomplete requests are checked every
  second. Keep-alive is five seconds, with bounded headers and requests per
  socket. These limits do not impose a response timeout on SSE or long AI work.
- Check WebSocket origin and capacity before authenticating/upgrading. Apply
  the configured proxy client-IP contract to the login-attempt budget.
- Handle invalid URLs/cookies and asynchronous authentication errors without
  leaving an upgraded socket pending. Own the raw socket's error listener while
  authentication is pending, then hand it to the WebSocket library.
- Limit pending upgrades to 32, bound authentication admission to ten seconds,
  release the slot when the peer disconnects, and return retryable 503 on
  operational authentication failures. Existing per-connection payload and
  message limits remain in place.

## Dependency remediation and remaining tooling advisory

The root Vite override previously resolved Vite 8.3.6 despite the UI manifest
appearing to request an older exact version. The production dashboard now builds
with Vite **8.3.7** and Rolldown **1.2.19**; the separate website uses Vite
**6.4.6**. These satisfy the branches fixed in the official advisory:

- [Vite GHSA-p4f5-76q4-ffq7](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7)
- [Vitest mocker GHSA-qxg6-89mg-rqv8](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)
- [Happy DOM GHSA-834v-8h66-3h79](https://github.com/capricorn86/happy-dom/security/advisories/GHSA-834v-8h66-3h79)
- [smol-toml security fixes](https://github.com/squirrelchat/smol-toml/releases)
- [source-map-js 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)

Vitest/coverage is pinned to 4.1.12; Happy DOM to 21.0.4; Knip's smol-toml to
1.9.0; the website's source-map-js to 1.2.2. The production dependency graph did
not change. Its audit reports no known registry advisories, but the Vite advisory
was absent from the initial registry audit, demonstrating why an audit result
alone is insufficient evidence of safety.

The remaining registry advisory is **GHSA-fc5q-39xc-vjpf**, in development-only
picomatch paths used by Knip and the standalone website's build tools. No safe
patched version was reported by the registry during this review. The suggested
automatic Vite downgrade would restore known Vite flaws and was not applied.
These dependency paths are not in the gateway's production dependency graph.
Do not process untrusted glob patterns through those development tools until
upstream remediation is available.

Both UI and website production builds emitted no source-map files. Developer
tools/F12 remain available: the security boundary is the server and its access
checks, not hiding files that a browser must download to render the application.

## Deployment boundary and operational limitations

- Railway's public HTTP ingress overwrites the forwarding headers used here;
  `X-Real-IP` is the appropriate client identity on that platform. This is a
  platform trust contract, not verification of a socket peer against
  `TRUSTED_PROXY_IPS`. Private-network callers in the same environment can
  bypass public ingress sanitization and must remain trusted. No public TCP
  proxy was configured for this gateway at review time.
- See [Railway ingress specifications](https://docs.railway.com/networking/public-networking/specs-and-limits)
  and the [Railway staff clarification](https://station.railway.com/questions/need-authoritative-client-ip-proxy-tru-090eac86).
- Rate-limit counters and session caches are per process. This release targets
  the observed single replica. Multiple replicas require shared rate-limit and
  revocation state for strict global guarantees; another replica can retain a
  positive session cache for up to five minutes.
- Application limits reduce resource abuse but cannot guarantee availability
  against a volumetric/distributed attack. At review time, the custom domain
  resolved directly to Railway and Cloudflare's dashboard required sign-in.
  Workers AI credentials alone do not put the domain behind Cloudflare's proxy
  or WAF. No DNS/WAF activation is claimed by this change.
- No guarantee of "100% security" is made. Image qualification, production
  health checks, backups, continued dependency maintenance, and monitoring
  remain part of operation. The existing build/release gates are preserved.
