# Astra security hardening — 2026-11-18

**Publication status, updated 2026-11-18:** the qualified container image is
**active in production**. Railway records deployment
`4ad5a6d2-8dce-481c-9ab0-db0de702deec` as successful, created at 11:44:54 UTC
(07:44:54 America/Campo_Grande) and started at approximately 07:45 local time.
The read-only checks below confirmed selected protections on the live site;
they do not constitute exhaustive production penetration testing.

## Scope and evidence

This change hardens the gateway, its authentication and public HTTP/WebSocket
ingress, and the tools used to build the dashboard. The baseline was main commit
`89b668db15ebca8fb894e3da9fb9fb2cf7234381`, deployed as the compiled Node gateway
with one Railway replica. No attack payload was replayed against production.
Production verification uses harmless reads; abuse cases use local synthetic
requests and mocked accounts.

The reported Vite requests received HTTP 200, but their historical response
bodies were unavailable. Harmless development-file paths independently returned
the SPA HTML fallback, providing a plausible explanation for those statuses.
This does not establish what the original requests returned, code execution,
exfiltration, or the absence of either. The deployed process is the compiled
gateway, not a Vite development server.

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

## Full-suite follow-up

The first full gateway run exposed 27 pre-existing audio/RSS unit-test failures
caused by real DNS lookups in tests that already mocked HTTP. The same failures
were reproduced on the baseline with Vitest 4.1.10. The tests now provide
deterministic public/loopback DNS fixtures while retaining the real SSRF policy
and all assertions; the dedicated safe-fetch and SSRF suites pass alongside them.

Two further pre-existing failures exposed a Pomodoro civil-date calculation
that interpreted `YYYY-MM-DD` as UTC before applying local midnight. The small
follow-up fix compares civil dates and advances calendar days directly. All 55
Pomodoro tests pass in both UTC and America/Campo_Grande, including year and
leap-day boundaries and a daylight-saving interval. These validation fixes are
kept in a separate commit from the security controls.

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

## Release validation record

The code was integrated through [PR #155](https://github.com/QGBALTIGO/astra/pull/155)
as commit `2e17ecc1c7f21f40026f9af4f0453dd7eb44e0d2`. Its tree
`0cf51a725e1257aedf9cc5c4ff1c7cbe49c32fc0` exactly matches the locally validated
tree. All ten PR workflows completed successfully, including Linux/Windows CI,
the isolated interface audit, customer portal, dashboard, onboarding,
PostgreSQL scenarios, WhatsApp reliability, simulation, and touch/keyboard checks.

- The complete monorepo run passed **37,317 tests**, with **zero failures** and
  **1,299 conditional skips**. Build, type checks, lint, formatting, and the
  frozen-lockfile install also passed.
- [PR CI](https://github.com/QGBALTIGO/astra/actions/runs/44291586586) passed
  **176 Playwright browser tests**. Its separate PostgreSQL regression group
  passed **114 tests**; Windows checks passed **13,035 tests**.
- [Main CI](https://github.com/QGBALTIGO/astra/actions/runs/44293315953) passed the
  normal build/test job, production dependency audit, gateway boot, and database
  migrations. Its overall result is **failure only because of the existing
  coverage debt** tracked in [#150](https://github.com/QGBALTIGO/astra/issues/150).
  Gateway function coverage is **83.36%**, improved from **83.26%** on the base,
  but below the unchanged **84%** requirement. All instrumented tests passed.
  This report does not represent that coverage gate as green.
- The production image is built by the separate
  [qualified-image workflow](https://github.com/QGBALTIGO/astra/actions/runs/44293315880),
  whose required dashboard, customer, onboarding, and runtime-preservation gates
  must all pass before the image is published.

## Prepared production change and approval history

The qualified-image workflow completed successfully at **11:29:22 UTC on
2026-11-18** (**07:29:22 America/Campo_Grande**). All three application gates,
container build, backup refusal tests, private-volume ownership checks, original
command passthrough, and publication passed. The immutable candidate is:

```text
ghcr.io/qgbaltigo/astra@sha256:b5c6693860a2dca09c3c55f4aa406e164cd5622e17868efc978fd1e783b10be0
```

The prepared patch targets only `astra-gateway` in `astra-ownpilot` / `production`:

- Switch the image to the qualified digest above.
- Set `ASTRA_RELEASE_BACKUP_LABEL=astra-security-20261118-2e17ecc1` to require a
  release-preservation backup before application startup.
- Set `UI_SESSION_COOKIE_SECURE=true` to require HTTPS for session cookies.
- Keep the existing `TRUSTED_PROXY_IP_HEADER=x-real-ip` selection. Staging the
  same value produced no configuration change.

The final review confirmed that build settings, startup/pre-deployment commands,
health check, networking, and `/app/data` volume mounts remain unchanged. No
service or volume deletion was staged, no other service was touched, and no
shared variable was changed. The staged patch ID is
`cacf712c-c041-4faa-9341-4940fb51f48b`.

The Railway `accept-deploy` operation returned:

> Cancelled — the user did not approve this action. No changes were made.

At that time, read-only verification confirmed that the patch remained **STAGED**,
with **no deployment triggered**. The then-current deployment remained
`153d2198-d455-4d9a-9fe2-111e13718e9a` (**SUCCESS**, one running replica), using the
previous image digest
`sha256:887b2759ebab063fc183519ab5da46bb427bf0e6766e170825d75b0cccd537bd`.
The approval refusal was not bypassed through another deployment mechanism.

That approval refusal was a historical blocker. A later deployment is now
confirmed by the evidence in the next section. Cloudflare DNS/proxy/WAF
activation remains separately pending authenticated account and DNS access;
none of the checks below establishes that a Cloudflare WAF is active.

## Subsequent activation and live verification

On 2026-11-18, a later read of the production service confirmed the exact approved
image digest `sha256:b5c6693860a2dca09c3c55f4aa406e164cd5622e17868efc978fd1e783b10be0`,
deployment `4ad5a6d2-8dce-481c-9ab0-db0de702deec` in **SUCCESS**, and no pending patch.
The evidence confirms publication; it does not identify who completed approval.

The deployment's startup logs record:

- **11:45:32 UTC:** runtime UID/GID **1001**, not root.
- **11:45:33 UTC:** `[ReleaseBackup] created.` before application startup.
- **11:45:35 UTC:** proxy client identity configured, header `x-real-ip`, JWT
  authentication, and API limit **500 requests per 60,000 ms**.

At **13:03 UTC / 09:03 America/Campo_Grande**, bounded unauthenticated GET requests
to `https://app.astraacessor.pro` produced these results:

| Path                                                                     | Observed result                            |
| ------------------------------------------------------------------------ | ------------------------------------------ |
| `/` and `/cliente/entrar`                                                | 200, HTML, CSP and HSTS present            |
| `/@vite/client`, `/@id/__vite-browser-external`, `/.env`, `/.git/config` | 404, plain text, `Cache-Control: no-store` |
| `/assets/astra-security-missing-file.js`                                 | 404, JSON                                  |
| `/api/v1/settings`                                                       | 401, authentication required               |
| `/health/sandbox`                                                        | 401, authentication required               |
| `/api/v1/auth/status`                                                    | 200, password configured, unauthenticated  |
| `/health/ready`                                                          | 200, `ready`, `Cache-Control: no-store`    |

These are read-only route/configuration checks, not production load tests.
They establish that the observed deployment is serving the intended perimeter
behavior, while the broader concurrency, cancellation, and revocation cases
remain covered by the recorded isolated regression tests. The session-cookie
HTTPS setting is present; no production login was performed to obtain a new
session cookie during this verification. Backup creation was observed; a fresh
production restore was not performed.
