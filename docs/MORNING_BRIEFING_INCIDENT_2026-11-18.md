# Morning Briefing incident — 2026-11-18

## Scope and production evidence

The security release was independently confirmed live on Railway deployment
`4ad5a6d2-8dce-481c-9ab0-db0de702deec`, created at 11:44:54 UTC (07:44:54
America/Campo_Grande). Its startup recorded a new release backup and runtime
UID/GID 1001. See [the security verification record](SECURITY_HARDENING_2026-11-18.md)
for the bounded public checks completed at 09:03 local time.

That deployment's readiness does not establish completion of a scheduled task.
The following incident was observed after startup, in the service logs between
11:59:45 and 12:01:45 UTC. No production inference, scheduled-job replay, or
test message was sent during this investigation.

| Event                        | Time in America/Campo_Grande | Evidence and interpretation                                                                                                                                                                                                 |
| ---------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Groq admission refusals      | 08:00:39–08:00:48            | Five synthetic HTTP 413 records, `attempt: 0`, elapsed 0–1 ms, estimated inputs 2,724–7,737, output reserve 8,192, configured total budget 8,000. These refusals occurred inside Astra before a credential/network attempt. |
| OpenRouter refusal           | 08:00:48.908                 | HTTP 429 / `rate_limited`. Four fallback successes appear earlier in the same window; records lack the identifiers needed to assign every earlier call to this exact trigger.                                               |
| Cloudflare attempt ended     | 08:01:08.903                 | A timeout exception and `All 3 providers failed`, not a recorded remote HTTP 408/504 response.                                                                                                                              |
| Agent and trigger completion | 08:01:08.903                 | AgentExecution reported `provider_or_agent_failure` / timeout; TriggerEngine logged `Executed trigger` and scheduled the next fire for 19 November at 08:00 local time.                                                     |

The OpenRouter logs do not expose the rate-limit subtype or `Retry-After`, so
they do not establish exhaustion of a daily or monthly quota. For Cloudflare,
the adjacent logs are about 20 seconds apart while the code's configured
provider budget is 12 seconds. The previous sanitized telemetry did not retain
the timeout layer/budget. This report does not attribute the whole interval to
external provider latency or assert Cloudflare quota exhaustion.

The trigger's historical database row and any delivery receipt were not directly
queried. The observed logs and the reproduced code path establish the false
success risk; they are not proof of a WhatsApp delivery.

## Two different morning flows

The default `Morning Briefing` trigger in `triggers/proactive.ts` uses the generic
`chat` action and the language-model fallback chain. Its default configuration
asks for a summary but does not configure a WhatsApp destination.

The WhatsApp daily greeting uses `daily-greeting-worker.ts` and
`buildMorningBriefing()`. Its basic output is deterministic, with independent
deadlines for optional weather/mail components. A failure of the generic chat
trigger does not establish that every customer's daily greeting failed.

## Root causes and changes

### The default output reservation exceeded the entire local request budget

An 8,192-token output reservation could never fit inside an 8,000-token total
budget, even with empty input. The provider request had not been sent, although
the old transport diagnostic made the failure look like provider unavailability.

The correction keeps the configured limit and separates planning from final
admission:

- Eligible non-channel agents using the operator's official Groq key pool plan
  context, real meta-tool schemas, dynamic injection, history, and output within
  the configured total budget. The redundant full tool catalog is omitted;
  identity, access instructions, tool registry, user scope, and permissions stay
  intact. Existing channel policies remain unchanged.
- The pool can lower only the output ceiling to fit the serialized request.
  It preserves at least 1,024 output tokens, or a smaller explicitly requested
  limit. Context that cannot leave this useful space still fails locally without
  a network call. Inputs and tool receipts are not silently removed.
- The policy does not spread to tenant credentials, custom endpoints, auth
  overrides, or legacy single-key transport. No key, account quota, pricing plan,
  model route, or production environment variable was changed for this fix.
- Output-limited completions are incomplete results. A non-streamed completion
  may use a fallback before any tool executes. Once a stream has emitted content
  or tool fragments, it fails explicitly instead of replaying through a reserve.
- Local admission refusals and output limits do not mark the provider unhealthy.
  Logs distinguish local rejection and retain only safe timeout-budget/phase
  metadata for future diagnosis.

### The scheduler ignored structured pipeline errors

MessageBus can resolve a failed operation with error metadata rather than reject
its Promise. The old handler returned its content as an ordinary successful
result. The new handler checks structured outcome markers, and AgentExecution
always supplies an unambiguous stage/code on failure, including empty error
messages. Legitimate empty/tool-only results and nonfatal warnings remain valid.

The handler throws only a static error description. Provider bodies, credentials,
and raw exception text do not cross into trigger history, events, or logs through
this new boundary. Trigger execution logs now include an explicit result status.

### Scheduled work shared an interactive agent

Each scheduled chat now gets a unique conversation/agent, scoped to the trusted
user of its TriggerEngine. A payload cannot replace that user. The handler no
longer resets the interactive chat, and a `finally` removes only the owned
instance from the cache, including failure and concurrent-run cases.

## Validation and operational limits

Regression tests use synthetic credentials and intercepted HTTP. They cover the
real non-channel agent builder and serialized tool schemas, impossible budgets
rejected before fetch, aliases and retries, cancellation, streaming without
replay, provider health, empty errors, safe diagnostics, user isolation, and
MessageBus/TriggerEngine history and events. The existing deterministic morning
flows and runner utility tests also pass. Release results are recorded in the
pull request and qualified-image workflow.

No automatic whole-job retry was introduced: a generic chat may have executed
tools before a later model call failed. Replaying it without idempotency could
duplicate effects. Failed runs remain visible and advance to the normal next
cron. The historical failed run was not rewritten or replayed.

These changes remove the reproduced local admission and false-success bugs;
they do not guarantee availability of third-party free inference. A successful
deployment or health check is not a successful end-to-end morning-summary run.

Primary provider references used to interpret, not overstate, the evidence:

- [Groq API parameters](https://console.groq.com/docs/api-reference)
- [Groq rate-limit behavior](https://console.groq.com/docs/rate-limits)
- [OpenRouter rate-limit documentation](https://github.com/OpenRouterTeam/docs/blob/main/api_reference/limits.mdx)
- [Cloudflare Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/)

## Release evidence and final deployment status

As of 18 November 2026 at 20:20:31 UTC (16:20:31 America/Campo_Grande),
the correction is **merged and qualified, but not deployed**.

- [PR #156](https://github.com/QGBALTIGO/astra/pull/156) merged as
  `84a2d88ac5e51a7fc25e71bfc7c7369817edb0d1`. The qualified artifact uses that
  commit, not later unrelated changes on `main`.
- Local focused verification passed 797 tests across 18 files, the full build,
  type checking, lint, and formatting.
- [PR CI](https://github.com/QGBALTIGO/astra/actions/runs/44314197055) passed
  37,391 Linux tests (1,299 conditional skips), 13,068 Windows tests,
  176 Playwright tests, and 114 PostgreSQL integration tests. The six
  PR-triggered workflows completed successfully.
- The [main CI run](https://github.com/QGBALTIGO/astra/actions/runs/44315144357)
  passed its build/test, boot, and migration jobs. Its coverage job failed:
  gateway function coverage is 83.30%, below the existing 84% threshold and
  0.06 percentage points below the prior 83.36%. This remains unresolved
  coverage debt; the threshold and exclusions were not changed. The main CI
  run is therefore not entirely green.
- The [qualified-image workflow](https://github.com/QGBALTIGO/astra/actions/runs/44315144176)
  completed successfully at 13:44:51 UTC. Its existing dashboard, portal,
  onboarding, backup-preservation, private-volume, symlink-refusal, and non-root
  runtime checks passed. No release gate was disabled.

Qualified candidate image:

```text
ghcr.io/qgbaltigo/astra@sha256:85f3346da4140f6f345017a94cb282faf94788034c26e738a823ac06bc0ed08a
```

Railway patch `9369fbb5-9e56-4ac7-87cc-0cfd742200d4` remains `STAGED`.
Its changes are confined to `astra-gateway`: the qualified image and release
backup label `astra-briefing-20261118-84a2d88a`, plus removal of already-empty
repository-source fields. The reviewed patch reports `destructive: false`;
the start command, pre-deploy command, health checks, networking, and persistent
volume are preserved.

The final connector deployment call ended with `aborted by user`. A fresh
read afterward confirmed no new deployment: the active deployment remains
`4ad5a6d2-8dce-481c-9ab0-db0de702deec` (the security release), `SUCCESS`,
with one running replica and no reported warnings, criticals, or recent
deployment failures. This cancellation was not bypassed through another
deployment route.

Completing the staged Railway deployment is the remaining release step.
Afterward, verify the candidate deployment ID, startup backup and readiness,
and separately inspect a real scheduled execution's outcome and any configured
delivery receipt. Neither the staged image nor a successful health check is
evidence that the failed historical summary was delivered.
