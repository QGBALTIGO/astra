# Astra Simulation & Reliability Lab — audit, execution, limits

Date: 2026-11-12. Initial branch: feat/astra-simulation-reliability-lab-20261112.
Maintainer target: Node.js 22, PostgreSQL 16, Astra / OwnPilot. All profiles are fictitious.

## Non-negotiable separation of evidence

| Mode                                             | What it executes                                                                                                          | Does it prove Astra works?                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| synthetic_oracle                                 | 100,000 procedural human-scenario records plus local schema/ledger invariants                                             | NO; it does not call the Astra model, channels or database                                       |
| synthetic_properties                             | 18,000 fast-check properties over numeric parsing, dates and isolation                                                    | NO; validates test contracts, not live integration                                               |
| actual_astra_entrypoints_with_ephemeral_postgres | Existing real channel ingress/finance/reminder logic with synthetic accounts and a fresh PostgreSQL pgvector test service | PARTIALLY; validates those named entry points and database writes, not real LLM or live WhatsApp |
| isolated_adapter                                 | Opt-in Promptfoo to an explicitly isolated loopback test adapter                                                          | NOT RUN until such adapter is configured and provenance verified                                 |
| human_agent_simulator                            | MiroFish/OASIS behavioral agents with tool-running Astra                                                                  | NOT INSTALLED; requires separate license, cost, quality and isolation review                     |
| multimodal_real                                  | Audio/image/document decoding and interpretation                                                                          | NOT RUN by procedural media text fixtures                                                        |
| load_real                                        | Concurrent Astra gateway inferencing against isolated resources                                                           | NOT RUN; synthetic records do not establish 500 user throughput                                  |

A scenario containing an expected action is never evidence of a saved database row. The procedural oracle must not be confused with an Astra tool executor or a language model. Generated scenarios have a persistent, seeded script/persona identity but no factual relation to real people. These boundaries are printed in all generated reports.

## Live infrastructure before lab

Railway project astra-ownpilot (e2e1a32c-425e-46bc-8b70-25db268f9b78), environment production.
At initial audit (2026-11-12): astra-gateway, astra-postgres, astra-landing, astra-svg-preflight-temp.
The gateway service was online, one replica, and uses a Railway volume. There is no test/staging environment in that Railway project. NEVER launch lab tests there. Do not use the local user's Ollama machine for this lab without a separate explicit setup.

Existing code and tests to reuse:

- packages/gateway/src/channels/channel-ai-routing.ts — ingress, direct and bus paths.
- packages/gateway/src/channels/tool-selection.ts — scoped tool hints in Portuguese for goals, finances, reminders and memory.
- packages/gateway/src/services/agent/service.ts — customer registry allowlist and routing; admin tools restricted.
- packages/gateway/src/tools/customer-finance-tools.ts — typed financial tools and persisted user scope.
- packages/gateway/src/tools/goal-tools.ts — existing GoalService executor, not a replacement with a new goal implementation.
- packages/gateway/src/db/repositories/customer-finance.ts — financial state in PostgreSQL.
- packages/gateway/src/services/channel-reminder-worker.ts — scheduler and channel transport.
- packages/gateway/scripts/whatsapp-screenshot-smoke.ts — existing integration with empty PostgreSQL and synthetic WhatsApp transport; rejects network and a model.
- docs/ASTRA_CAPACITY_AUDIT_500.md — current capacity caveats; 500 concurrent users are not certified.
- docs/ASTRA_QUALITY_JOURNAL.md — metadata-only operational signals and privacy limits.
- docs/ADR/ADR-001-persistent-job-queue.md — pg-boss is proposed; not already a proven queue.

## Third-party compatibility and license matrix

| Project                    | License at audit        | Fit                                                                  | Decision                                                                          |
| -------------------------- | ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 666ghj/MiroFish            | AGPL-3.0                | Swarm/social-behavior simulator, not a WhatsApp transaction verifier | independent dev-only experiment; no code copied or service embedded               |
| nikmcfly/MiroFish-Offline  | AGPL-3.0                | Offline Ollama + Neo4j 5 + frontend                                  | postpone; documented 16 GB minimum RAM, 32 GB recommended, high VRAM expectations |
| promptfoo/promptfoo        | MIT                     | Prompt and agent eval runner                                         | optional isolated adapter config under scripts/astra-simulation-lab               |
| sierra-research/tau2-bench | MIT                     | Long-running user/tool/state evaluation                              | τ-style fixtures and action/state schema first; no Python benchmark run claimed   |
| dubzzz/fast-check          | MIT                     | Shrinkable property generation                                       | pinned 4.10.2 in a CI-only temporary npm prefix; no production dependencies       |
| comet-ml/opik              | Apache-2.0              | Tracing, tools, experiments                                          | chosen future platform, NOT deployed to Railway now                               |
| langfuse/langfuse          | MIT core; ee exceptions | Similar telemetry                                                    | don't install a second redundant platform                                         |
| camel-ai/oasis             | Apache-2.0              | Agent populations                                                    | defer; heavyweight, possible MiroFish underpinning                                |
| actualbudget/actual        | MIT                     | Financial accounting inspiration                                     | reference only, no component copied                                               |
| firefly-iii/firefly-iii    | AGPL-3.0                | Financial workflows                                                  | reference only, no component copied                                               |

License classifications follow upstream as checked 2026-11-12. Legal compliance in a commercial deployment still requires review of all transitive dependencies and deployment terms. Upstream source and README are at github.com/org/project for each named project. No third-party AGPL code has been vendored into Astra.

## Reproducibility

Entry points:

    node --test scripts/astra-simulation-lab/core.test.mjs scripts/astra-simulation-lab/world-oracle.test.mjs
    node scripts/astra-simulation-lab/run.mjs --limit=100000 --seed=20261112 --output=/tmp/astra-lab-my-run
    node scripts/astra-simulation-lab/tau-fixtures.mjs /tmp/astra-lab-fixtures.jsonl 100
    ASTRA_LAB_FAST_CHECK_PREFIX=/tmp/fast-check-install node scripts/astra-simulation-lab/properties.fast-check.mjs

fast-check installation for the last command:

    npm install --prefix /tmp/fast-check-install --no-save --no-package-lock --ignore-scripts fast-check@4.10.2

The GitHub Actions workflow astra-simulation-lab.yml automates all of the above (minus an actual Promptfoo/τ model), and runs the existing gateway smoke against a disposable PostgreSQL container. The smoke has strictly synthetic credentials, requires NODE_ENV=test, blocks the model path, does not send real WhatsApp messages and refuses DATABASE_URL or non-loopback PostgreSQL.

The generator uses a seeded, non-cryptographic permutation for exact category quotas. Each synthetic profile has a stable biography, profession, finances, family or pet context and time zone; every ten turns form a multi-day/month narrative. The full scenarios, multi-message scripts, personas, failures, report JSON and HTML dashboard are exported to disposable CI artifacts (7-day retention), NOT checked into version control or production memory. Never confuse 100k corpus records with 100k real conversations.

The procedural corpus provides EXACTLY the requested 100k area quotas if the workflow succeeds. It contains 10k complete 10-turn scripts and 15k cases in the goals/debts category; those counts do not imply semantic uniqueness of every scenario. The report includes a smaller semantic-family count: intentionally transparent about template diversity. Media cases are synthetic text fixtures, not decoded audio or vision. All model-quality scores and live-intent accuracy are null until measured.

## Offline model and Promptfoo layer

The optional promptfooconfig.yaml points at promptfoo-provider.cjs. It refuses to run without ASTRA_LAB_ISOLATED=1, and only accepts an HTTP loopback adapter at /astra-lab/eval. It also rejects production Railway variables, DATABASE_URL, POSTGRES_HOST and OLLAMA_HOST. The adapter must separately enforce fake identities and return synthetic=true; a valid model response with an unknown database state is NOT a pass for finance, goals or reminder success.

Promptfoo must not be pointed at the production gateway or the user's Ollama PC. MiroFish and its offline fork should be separate services with separate manifests after license/legal review, resource budgets, and a monitored, bounded user-model pilot. The current lab does NOT launch Neo4j or consume API tokens.

## Acceptance and severity

P0: wrong-user data, authorization bypass, exposure of secrets, unsafe cross-user mutation.
P1: duplicate financial commit, false successful write, corrupted balance, missing confirmed reminder.
P2: recoverable intent misunderstanding, tool selection mismatch, continuity loss.
P3: presentation and style regression.

Evidence for a failure should include scenario ID, seed, category, synthetic history, expected state, observed state, model/tool receipt when available, independent DB assertion, severity, reproduction and revalidation. Never classify a synthetic oracle exception as a proven Astra production incident. The runner emits failures.json and a bounded set of examples.

Target gates (NOT results): 100% passing isolation criticals, no leaked internal markup or false financial confirmation in real integration, >=98% model intent precision over a labeled sample, >=4.5/5 naturalness in reviewed responses, zero repeated writes after retry.

## Incremental roadmap, separate approval gates

1. Seeded 100k procedural oracle and 10k ten-turn scripts — implemented; verify output from CI.
2. fast-check tests in isolated CI dependency — implemented; verify run.
3. Existing Astra entry points against an ephemeral PostgreSQL DB — integrated; verify run.
4. Domain-specific τ-style action and final-state judges connected to real Astra sandbox with an isolated external provider — NOT completed.
5. Promptfoo real conversational evaluation against isolated (never production) model — NOT completed.
6. Agent population via independent MiroFish/OASIS, with license and resource review — NOT completed.
7. Virtual clock injection into persisted reminder workers with no real delivery — NOT completed.
8. Distinct 500/500 load testing using k6 and an isolated gateway/queue — NOT completed.
9. Failure triage, fix in branch, regression then controlled production deploy — only after P0/P1 are cleared and all gates pass.

Do not delete test data, rotate real credentials, change business records, run load tests against Railway production, or alter the user's Ollama PC as part of this stage.
