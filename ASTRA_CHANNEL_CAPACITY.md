# Astra: reply pacing and bounded channel capacity

Implementation and verification record, updated 2026-11-18. This change controls a
single gateway process. It does not certify a sustained production load of
300 real people or guarantee that WhatsApp will not restrict an account.

## Reply behavior

Private conversational WhatsApp replies pause according to their normalized
text length: `800 ms + characters / 100 characters per second`, bounded by
1,500–6,000 ms. The pause applies before the first transport attempt; model,
queue and network time are additional. Text chunks remain ordered within a
conversation. Independent conversations can wait without holding an AI slot.

| Text length             | Default pause |
| ----------------------- | ------------: |
| Up to 70 characters     |   1.5 seconds |
| 120 characters          |     2 seconds |
| 420 characters          |     5 seconds |
| At least 520 characters |     6 seconds |

OTP, copy-code, login and deadline-bound messages have no cosmetic pause. They
can enter urgent slot admission while an ordinary reply to the same recipient
waits. Both lanes share the recipient transport lock and global quota. Urgency
never authorizes exceeding the quota or sending an expired code.

The existing ceiling remains 20 transport attempts per rolling minute, with
the existing recipient interval policy (3 seconds normally and 750 ms for
direct conversational replies). A permit occupies capacity while the fresh
access check runs; its timestamp is committed immediately before transport.
Failed/ambiguous transport attempts still consume quota. Authorization,
connection generation and deadlines are rechecked before each chunk.

## Admission and memory

| Stage                                   |             Default active work | Default waiting work | Scope                                                                                    |
| --------------------------------------- | ------------------------------: | -------------------: | ---------------------------------------------------------------------------------------- |
| Entire inbound pipeline                 |                              16 |                  600 | At most 20 total messages per conversation; before identity lookup and old session locks |
| Session construction and AI             |                               4 |                  600 | Shared pool; one active job per conversation                                             |
| WhatsApp media download and persistence |                               4 |                  300 | Queue stores metadata before allocating file bytes                                       |
| WhatsApp outbound messages              | Per recipient, subject to quota |    600 total pending | Normal FIFO plus urgent admission; one actual transport per recipient                    |
| Local Ollama bridge                     |                               1 |                    0 | Sequential physical worker; busy requests receive 429 with Retry-After                   |

Inbound and AI queue waits expire after 20 minutes by default. Refused or
expired work does not begin the callback. Feedback identifies that the request
could not start. Overload feedback itself is bounded, and all sends retain
access checks. The existing per-sender flood guard remains enabled.

New-session agent construction uses the same four-slot AI pool as inference;
300 first conversations cannot create 300 agents simultaneously. Waiting for
outbound delivery does not occupy that AI pool. The full inbound pipeline has
its own 16-slot bound, so older per-chat locks do not hide an unlimited backlog.

Media downloads retain the 12 MiB file limit and 12-second download timeout.
After successful persistence, application queues hold asset identifiers and
metadata, not the downloaded buffer. Hydration happens inside AI admission,
from the stored asset record after checking the exact channel, chat, message,
expiry and current authorization. Caller-supplied paths cannot select files.
Hydration checks file size and digest, permits at most 12 MiB per file and
36 MiB per admitted media stage, and uses a clone of the input message. When
the verified Brazilian phone-spelling resolver canonicalizes a chat, only its
private server-owned provenance can preserve the original asset chat scope;
caller metadata cannot supply that exception.
These limits bound concurrent allocations; they are not a measured production
RSS ceiling for OCR, images or PDF processing.

## Groq quota

Every operator-key Groq attempt reserves estimated serialized input, tools and
maximum output before network transport, with a 20% margin. The reservation is
atomic and shared across provider instances in this process. Defaults are four
concurrent requests, 20 requests/minute and 6,000 tokens/minute per organization
group and model. If no output limit is supplied, the actual request is capped
at 1,024 output tokens so the reservation corresponds to a bounded request.

The integrated request budget uses the smaller of `GROQ_MAX_REQUEST_TOKENS`
and the quota-derived allowance. With the default 6,000 TPM and 20% margin,
the estimated input plus reserved output must fit within 5,000 tokens.
Scheduled briefing prompt/memory planning and transport use this same ceiling.
The transport may lower the requested output maximum while retaining a useful
1,024-token allowance, or a smaller explicitly requested maximum. It never
silently removes conversation messages or tool receipts. Requests whose input
cannot fit with that output allowance are refused before external transport so
the existing fallback policy can run.

Multiple API keys are not assumed to mean multiple organizations. Unknown keys
share one conservative quota group. `GROQ_QUOTA_GROUPS` can map environment
variable names to independently verified organization labels. It must identify
the primary organization before separate backup organizations are accepted.
Neither keys nor message content are logged as quota identifiers.

Provider request headers are treated as daily limits, and token headers as
minute limits. Headers can lower availability, but late responses cannot
refill it within the current window. A 429 cools the whole organization/model
group. Cancelled or uncertain requests retain their token reservation until
the window expires. A concurrency lease lasts until the body/stream settles.

This is preventive admission, not an exact tokenizer or a guarantee against
external 429s. Other clients using the same organization can consume quota.
Other fallback providers retain their own failure/cooldown behavior; this
change does not invent or multiply their quotas.

## Local model reserve

The installed PC was observed running `qwen3:4b-instruct` (Q4_K_M), context
8,192, fully loaded on the GPU. Three synthetic direct-local requests measured:

| Probe                                         | Input tokens | Result                                | Wall time |
| --------------------------------------------- | -----------: | ------------------------------------- | --------: |
| Short Portuguese reply                        |           32 | 22 output tokens                      |   2.368 s |
| Fictional tool selection                      |          219 | One valid tool call, 29 output tokens |   3.808 s |
| 45 fictional records and two fake query tools |        2,930 | One valid tool call, 29 output tokens |  19.220 s |

No tools were executed by those probes and no customer messages were sent.
These timings exclude the private Railway relay round trip. The representative
19.220-second request exceeded Astra's previous 16-second local fallback limit.

Local primary and fallback completions now have a 35-second allowance. Cloud
primary/fallback limits default to 5/8 seconds. With Cloudflare available, its
attempt retains a 12-second allowance and the other cloud backups retain their
7-second allowance. A chain with Ollama budgets the sum
of the configured per-attempt deadlines plus 1 second, capped at 75 seconds per
completion. A cloud-only chain keeps its 16-second budget, or 24 seconds when
the Cloudflare route is configured. A tool
conversation can have multiple completions; 75 seconds is not a whole-turn SLA.

The private bridge admits one request, reserving before asynchronous JSON
parsing. If the client cancels after the worker started, the physical inference
lease remains until the worker returns or its deadline expires. A late result
cannot release another job's lease. A valid long inference does not make the
worker appear offline simply because it has not polled again.

## Configuration

Defaults are active without adding production variables. Keep the single
gateway writer while these reservations are process-local.

| Variable                                     |                                      Default |
| -------------------------------------------- | -------------------------------------------: |
| `ASTRA_WHATSAPP_REPLY_PACING`                | Enabled; `false` disables the cosmetic pause |
| `ASTRA_WHATSAPP_REPLY_DELAY_MIN_MS`          |                                         1500 |
| `ASTRA_WHATSAPP_REPLY_DELAY_MAX_MS`          |                                         6000 |
| `ASTRA_WHATSAPP_REPLY_CHARS_PER_SECOND`      |                                          100 |
| `ASTRA_CHANNEL_INBOUND_MAX_QUEUED`           |                                          600 |
| `ASTRA_CHANNEL_INBOUND_MAX_PER_CONVERSATION` |                                           20 |
| `ASTRA_CHANNEL_AI_CONCURRENCY`               |                                            4 |
| `ASTRA_CHANNEL_AI_MAX_QUEUED`                |                                          600 |
| `ASTRA_CHANNEL_AI_MAX_PER_CONVERSATION`      |                                           20 |
| `ASTRA_CHANNEL_AI_QUEUE_TIMEOUT_MS`          |                                      1200000 |
| `GROQ_MAX_CONCURRENT_REQUESTS`               |                                            4 |
| `GROQ_REQUESTS_PER_MINUTE`                   |                                           20 |
| `GROQ_TOKENS_PER_MINUTE`                     |                                         6000 |
| `GROQ_TOKEN_MARGIN_PERCENT`                  |                                           20 |
| `GROQ_DEFAULT_OUTPUT_TOKENS`                 |                                         1024 |
| `GROQ_QUOTA_GROUPS`                          |          Unknown credentials share one group |

Invalid numeric settings fall back to safe defaults or are clamped by their
implementation. Raising limits requires measured capacity and actual provider
quotas; adding replicas requires shared reservations and an explicit ownership
strategy for the WhatsApp connection.

## Regression evidence and interpretation

The automated reliability workflow includes the new admission, quota, media,
outbound and local-reserve suites. Meaningful scenarios include 300 synthetic
identities through admission, 300 new conversations through ChannelService with
isolated simulated repositories/providers, 300 Groq submissions, and 300 relay
submissions. They validate bounds and isolation, not real provider throughput.

The outbound scheduler drains 300 simulated single-message recipients in
845 virtual seconds with an initial five-second pause, preserving 20 attempts
per rolling minute. Under a full global window plus 100 queued conversations,
an OTP for a recipient with an ordinary response already waiting obtains the
next legal slot at 60 seconds. These are fake-clock transport tests.

The relay saturation test admits one of 300 concurrent synthetic requests and
returns 429 for the other 299. It deliberately does not promise 300 local
inferences in parallel. A completion-budget regression spends 28.996 seconds
on configured cloud attempts and 34.500 seconds locally, succeeding within a
65-second budget. The Cloudflare variant spends 37.995 seconds on cloud attempts
and the same 34.500 seconds locally, within its 74-second budget.
The original 19.220-second case also succeeds under its new
local deadline.

Queues in this patch are in memory. Persisted inbound history and assets are
not a durable delivery outbox; a process restart does not guarantee replay of
waiting work. Financial actions with uncertain results are not automatically
replayed. Long saturation can expire queued requests. Production capacity also
depends on actual token availability, model/tool latency, database load and
external delivery. This release establishes bounded behavior under a burst;
it does not certify a sustained 300-user service level.

## Conditional alerts and reminder authorization

The 2026-11-18 screenshot showed a conditional USD request being persisted as
an ordinary reminder at the same wall-clock time as a different subject.
The channel shortcut now recognizes an explicit supported currency condition
and passes the original request to the existing Radar subscription flow.
`USD <= 5` uses PTAX sale-rate reference data and an inclusive comparison.
Confirmation describes the reference source, periodic polling and configured
quiet hours. PTAX is not an intraday market-price feed. Its collector polls at
30-minute intervals; the provider adapter uses the latest closing bulletin.

Scheduled reminder writes require a customer-authored notification request
and a concrete time or a scoped continuation of that request. The short-lived
continuation record is bounded by 5,000 user/channel/chat keys and a ten-minute
expiry. It cannot inherit a time from an unrelated completed request, another
customer or a quoted assistant promise. Original typed text and direct user
speech can provide authority; OCR/PDF interpretation cannot. Conditional event
requests cannot be converted to a fixed reminder by fabricated tool arguments.
An unsupported event such as service availability requires an honest response
about monitoring, rather than a scheduled-success receipt.

This guard proves request intent and the presence of customer-supplied timing.
It is not a complete natural-language date parser comparing every possible
utterance against all model-generated date arguments. The existing date,
timezone and reminder-argument validators still apply.

Radar comparisons support strict and inclusive upper/lower bounds with exact
fixed-point arithmetic. Equivalent decimal spellings such as `5` and `5.00`
do not rearm a duplicate subscription. Provider values with unsupported decimal
precision fail validation instead of being rounded across a threshold.
Recovery from an expired delivery requires explicit proof that transport was
not attempted and current account/interest revisions. Confirmed, partial or
uncertain transport is never automatically replayed by that recovery.

Regressions cover the exact screenshot request, boundary equality, source
precision, wrong units, unsupported date restrictions, reminder conversation
scope, typed/speech versus extracted-document authority, and PostgreSQL
subscription persistence, isolation, deduplication and delivery recovery.

## External references

- [Groq rate limits](https://console.groq.com/docs/rate-limits): quotas are
  organization-level; API keys do not independently multiply them.
- [Ollama FAQ](https://docs.ollama.com/faq): inference concurrency and memory
  depend on model loading and context size.
- [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy):
  expected/consented messaging and opt-out obligations still apply. A typing
  pause is not a published guarantee against platform restrictions.
- [Banco Central exchange-rate bulletins](https://dadosabertos.bcb.gov.br/dataset/taxas-de-cambio-todos-os-boletins-diarios):
  the closing PTAX bulletin is the arithmetic mean of the day's reference
  consultation bulletins, not a continuous market-price stream.
