import { providerErrorSummary } from '../provider-error-summary.js';
/**
 * Fallback Provider
 *
 * Automatically tries alternative providers when the primary one fails.
 * This provides resilience against provider outages or rate limits.
 */

import type { Result } from '../../types/result.js';
import { ok, err } from '../../types/result.js';
import { InternalError, TimeoutError, ValidationError } from '../../types/errors.js';
import { getLog } from '../../services/get-log.js';

const log = getLog('Fallback');
import type {
  ProviderConfig,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  Message,
  AIProvider,
} from '../types.js';
import { type IProvider, createProvider, type ProviderHealthResult } from '../provider.js';
import { logError, logRetry } from '../debug.js';
import { createHash } from 'node:crypto';
import { readWithAbort } from './shared.js';
import { ignoreError } from '../../utils/ignore-error.js';

/** A request's output ceiling is not evidence of a provider-wide outage. */
class OutputLimitError extends InternalError {
  constructor() {
    super('Provider reached its output limit before completing the response');
  }
}

const timeoutDetails = (error: Error, phase: 'completion' | 'stream') =>
  error instanceof TimeoutError && Number.isFinite(error.timeoutMs) && error.timeoutMs >= 0
    ? { timeoutMs: Math.round(error.timeoutMs), timeoutPhase: phase }
    : undefined;

/**
 * Circuit breaker states
 */
type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerEntry {
  state: CircuitState;
  failureCount: number;
  failureVersion: number;
  inFlight: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  reopenAt?: number;
  probeUntil?: number;
  probeToken?: symbol;
}
interface CircuitAttempt {
  circuit: CircuitBreakerEntry;
  failureVersion: number;
  deadline: number;
  probeToken?: symbol;
  finish(): void;
}
const sharedCircuits = new Map<string, CircuitBreakerEntry>();
const sharedPreferred = new Map<string, { index: number; at: number }>();
const HEALTHY_PREFERENCE_MS = 60 * 60 * 1000;
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Retry hints are durations, never credentials or user content. */
export function providerCooldownMs(error: Error | undefined, baseline: number): number {
  const explicit = (error as (Error & { retryAfterMs?: number }) | undefined)?.retryAfterMs;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0)
    return Math.min(86400000, Math.max(1000, explicit));
  const text = error?.message ?? '';
  const hint =
    /try again in\s+(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i.exec(
      text
    );
  if (hint && (hint[1] || hint[2] || hint[3]))
    return Math.min(
      86400000,
      Math.max(
        1000,
        (Number(hint[1] ?? 0) * 3600 + Number(hint[2] ?? 0) * 60 + Number(hint[3] ?? 0)) * 1000 +
          1000
      )
    );
  if (/free-models-per-day|tokens per day|\bTPD\b/i.test(text))
    return Math.max(baseline, 15 * 60000);
  // An overload or transport hiccup must not disable a healthy model for minutes.
  // Explicit retry hints above still win; quota/authentication failures keep their baseline.
  if (
    /(?:API error:|stream error:|HTTP)\s*5\d{2}\b|timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed|network error/i.test(
      text
    )
  )
    return Math.min(baseline, 15_000);
  return baseline;
}

/** Circuit breaker defaults */
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000; // 1 minute

/**
 * Fallback provider configuration
 */
export interface FallbackProviderConfig {
  /** Primary provider configuration */
  primary: ProviderConfig;
  /** Fallback provider configurations (in priority order) */
  fallbacks: ProviderConfig[];
  /** Whether to enable fallback (default: true) */
  enableFallback?: boolean;
  /** Consecutive failures before opening circuit (default: 5) */
  circuitBreakerThreshold?: number;
  /** Cooldown in ms before retesting an open circuit (default: 60000) */
  circuitBreakerCooldown?: number;
  /** Opt-in shared provider/model/credential health for channel agents. */
  sharedCircuitBreaker?: boolean;
  preferLastSuccessful?: boolean;
  /** Prefer less occupied healthy cloud routes during concurrent requests. */
  balanceConcurrentLoad?: boolean;
  /** Deadline for one completion or stream including all fallback attempts. */
  completionTimeoutMs?: number;
  /** Callback when fallback is triggered */
  onFallback?: (failedProvider: AIProvider, error: Error, nextProvider: AIProvider) => void;
}

/**
 * Fallback provider that automatically tries alternative providers on failure
 */
export class FallbackProvider implements IProvider {
  readonly type: AIProvider;
  private readonly primary: IProvider;
  private readonly fallbacks: IProvider[];
  private readonly config: FallbackProviderConfig;
  /** Provider configs in invocation order: [primary, ...fallbacks]. */
  private readonly orderedConfigs: ProviderConfig[];
  private currentProviderIndex: number = 0;
  private readonly circuits = new Map<string, CircuitBreakerEntry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly availabilityIds: string[];
  private readonly groupKey: string;
  private readonly activeRequests = new Set<AbortController>();

  constructor(config: FallbackProviderConfig) {
    this.config = {
      enableFallback: true,
      ...config,
    };

    // A configured fallback is already the retry path. Let the primary fail
    // fast by default so rate limits and outages switch models immediately
    // instead of waiting through the provider's full retry budget first.
    const primaryConfig = {
      ...config.primary,
      maxRetries: config.primary.maxRetries ?? 0,
    };

    const fallbackConfigs = config.fallbacks.map((fc) => ({
      ...fc,
      maxRetries: fc.maxRetries ?? 0,
    }));
    this.primary = createProvider(primaryConfig);
    this.type = config.primary.provider;
    this.fallbacks = fallbackConfigs.map((fc) => createProvider(fc));
    this.orderedConfigs = [primaryConfig, ...fallbackConfigs];
    this.availabilityIds = this.orderedConfigs.map((c) =>
      fingerprint([
        c.id ?? c.provider,
        c.provider,
        c.baseUrl ?? '',
        c.endpoint ?? '',
        c.defaultModel?.model ?? '',
        c.apiKey ?? c.resolvedAuth?.value ?? '',
        c.headers ?? {},
      ])
    );
    this.groupKey = fingerprint(this.availabilityIds);
    this.failureThreshold = config.circuitBreakerThreshold ?? CIRCUIT_FAILURE_THRESHOLD;
    this.cooldownMs = config.circuitBreakerCooldown ?? CIRCUIT_COOLDOWN_MS;
  }

  /**
   * Build the request for the provider at `index`. A fallback whose config
   * carries a `defaultModel` gets the request's model swapped to it, because
   * the incoming request carries the PRIMARY model string which is usually
   * invalid on a different fallback provider. The primary (index 0) and any
   * provider without a defaultModel use the request's model unchanged — so
   * existing callers that don't set a fallback model keep their behavior.
   */
  private requestForProvider(request: CompletionRequest, index: number): CompletionRequest {
    if (index === 0) return request;
    const fallbackModel = this.orderedConfigs[index]?.defaultModel;
    if (!fallbackModel) return request;
    return { ...request, model: { ...request.model, ...fallbackModel } };
  }

  // ── Circuit Breaker ─────────────────────────────────────────────

  private getCircuit(provider: IProvider): CircuitBreakerEntry {
    // OpenAI-compatible transports all report the same type. Identifying a
    // circuit by type would let one broken API block every healthy backup.
    const index = this.getAllProviders().indexOf(provider);
    const circuitId =
      this.config.sharedCircuitBreaker && index >= 0
        ? this.availabilityIds[index]!
        : index < 0
          ? `unknown:${provider.type}`
          : `slot:${index}`;
    const circuits = this.config.sharedCircuitBreaker ? sharedCircuits : this.circuits;
    let entry = circuits.get(circuitId);
    if (!entry) {
      entry = {
        state: 'closed',
        failureCount: 0,
        failureVersion: 0,
        inFlight: 0,
        lastFailureTime: 0,
        lastSuccessTime: 0,
      };
      if (circuits.size >= 256) circuits.delete(circuits.keys().next().value!);
      circuits.set(circuitId, entry);
    }
    return entry;
  }

  /** Admit one recovery probe for its actual request budget, with owned cleanup. */
  private acquireCircuitAttempt(
    provider: IProvider,
    index: number,
    deadline: number,
    signal?: AbortSignal
  ): CircuitAttempt | undefined {
    const circuit = this.getCircuit(provider);
    const attemptDeadline = Math.min(
      deadline,
      Date.now() + (this.orderedConfigs[index]?.timeout ?? Number.POSITIVE_INFINITY)
    );
    let probeToken: symbol | undefined;
    if (circuit.state !== 'closed') {
      const now = Date.now();
      if (
        (circuit.state === 'open' &&
          now < (circuit.reopenAt ?? circuit.lastFailureTime + this.cooldownMs)) ||
        (circuit.state === 'half-open' && (circuit.probeUntil ?? 0) > now)
      )
        return undefined;
      circuit.state = 'half-open';
      circuit.probeToken = probeToken = Symbol('recovery probe');
      circuit.probeUntil = attemptDeadline;
      log.info(`CircuitBreaker ${provider.type}: allowing one recovery probe`);
    }
    circuit.inFlight++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      circuit.inFlight--;
      signal?.removeEventListener('abort', finish);
      if (probeToken && circuit.probeToken === probeToken) {
        // Cancellation, a request-specific error or an early consumer return
        // is not an outage. Leave the elapsed cooldown available for a new probe.
        circuit.state = 'open';
        circuit.probeToken = undefined;
        circuit.probeUntil = undefined;
      }
    };
    if (probeToken) signal?.addEventListener('abort', finish, { once: true });
    return {
      circuit,
      failureVersion: circuit.failureVersion,
      deadline: attemptDeadline,
      probeToken,
      finish,
    };
  }

  private recordSuccess(provider: IProvider, attempt: CircuitAttempt): void {
    const { circuit } = attempt;
    // A slow response started before a concurrent quota/outage must not erase
    // the newer failure or release another request's recovery probe.
    if (
      circuit.failureVersion !== attempt.failureVersion ||
      (attempt.probeToken && circuit.probeToken !== attempt.probeToken)
    )
      return;
    if (circuit.state !== 'closed') {
      log.info(`CircuitBreaker ${provider.type}: ${circuit.state} → closed`);
    }
    circuit.state = 'closed';
    circuit.failureCount = 0;
    circuit.lastSuccessTime = Date.now();
    circuit.reopenAt = undefined;
    circuit.probeUntil = undefined;
    circuit.probeToken = undefined;
    if (this.config.preferLastSuccessful) {
      const previous = sharedPreferred.get(this.groupKey),
        now = Date.now(),
        index = this.getAllProviders().indexOf(provider);
      if (!previous || previous.index !== index || now > previous.at) {
        if (sharedPreferred.size >= 64)
          sharedPreferred.delete(sharedPreferred.keys().next().value!);
        sharedPreferred.set(this.groupKey, { index, at: now });
      }
    }
  }

  private recordFailure(
    provider: IProvider,
    error: Error | undefined,
    attempt: CircuitAttempt
  ): void {
    const { circuit } = attempt;
    if (attempt.probeToken && circuit.probeToken !== attempt.probeToken) return;
    if (error instanceof OutputLimitError) return;
    const status = /(?:API error|stream error|HTTP|status(?:\s*code)?)\s*:?\s*(\d{3})\b/i.exec(
      error?.message ?? ''
    )?.[1];
    // A local payload budget rejection made no provider request. It must not
    // poison either a shared circuit or this agent's private circuit.
    if (
      status === '413' &&
      /\brequest_too_large: groq_local_admission\b/i.test(error?.message ?? '')
    )
      return;
    // A busy local concurrency gate is not a remote quota or outage. In
    // particular, a customer's next request may fit as soon as a lease ends.
    if (
      status === '429' &&
      /\bGroq local admission (?:concurrency|capacity)\b/i.test(error?.message ?? '')
    )
      return;
    if (
      this.config.sharedCircuitBreaker &&
      error &&
      (error instanceof ValidationError ||
        status === '400' ||
        (!status && /context[_ -]length[_ -]exceeded|maximum context length/i.test(error.message)))
    )
      return;
    circuit.failureCount++;
    circuit.failureVersion++;
    circuit.lastFailureTime = Date.now();
    circuit.probeUntil = undefined;
    circuit.probeToken = undefined;
    // In-flight requests can fail out of order. A late transient error must
    // never shorten a quota or explicit Retry-After already observed.
    circuit.reopenAt = Math.max(
      circuit.reopenAt ?? 0,
      circuit.lastFailureTime +
        (this.config.sharedCircuitBreaker
          ? providerCooldownMs(error, this.cooldownMs)
          : this.cooldownMs)
    );

    if (circuit.state === 'half-open') {
      // Failed during test → re-open
      circuit.state = 'open';
      log.warn(`CircuitBreaker ${provider.type}: half-open → open (test failed)`);
    } else if (circuit.failureCount >= this.failureThreshold) {
      circuit.state = 'open';
      log.warn(
        `CircuitBreaker ${provider.type}: closed → open (${circuit.failureCount} consecutive failures)`
      );
    }
  }

  // ── Provider Access ───────────────────────────────────────────

  /**
   * Get all providers in order (primary + fallbacks)
   */
  private getAllProviders(): IProvider[] {
    return [this.primary, ...this.fallbacks];
  }
  private preferHealthy<T extends { origIndex: number }>(entries: T[]): T[] {
    const preferred = this.config.preferLastSuccessful ? sharedPreferred.get(this.groupKey) : null;
    // A successful reserve must not keep a recovered primary behind it for an
    // hour. Let one primary recovery probe run when its actual cooldown ends.
    if (preferred && preferred.index > 0 && this.config.sharedCircuitBreaker) {
      const primary = this.getCircuit(this.primary);
      if (
        primary.state === 'closed' ||
        (primary.state === 'open' &&
          Date.now() >= (primary.reopenAt ?? primary.lastFailureTime + this.cooldownMs)) ||
        (primary.state === 'half-open' && Date.now() >= (primary.probeUntil ?? 0))
      )
        return entries;
    }
    return preferred && Date.now() - preferred.at < HEALTHY_PREFERENCE_MS
      ? entries.sort(
          (a, b) =>
            Number(b.origIndex === preferred.index) - Number(a.origIndex === preferred.index)
        )
      : entries;
  }
  private preferCapacity<T extends { origIndex: number; provider: IProvider }>(entries: T[]): T[] {
    if (!this.config.balanceConcurrentLoad || this.orderedConfigs[0]?.id === 'ollama-local')
      return entries;
    const now = Date.now();
    const rank = (entry: T): number => {
      if (this.orderedConfigs[entry.origIndex]?.id === 'ollama-local') return 3;
      const circuit = this.getCircuit(entry.provider);
      if (circuit.state === 'closed') return 1;
      if (
        (circuit.state === 'open' &&
          now >= (circuit.reopenAt ?? circuit.lastFailureTime + this.cooldownMs)) ||
        (circuit.state === 'half-open' && now >= (circuit.probeUntil ?? 0))
      )
        return 0; // Give recovered cloud routes a bounded circuit probe.
      return 2;
    };
    return entries.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        this.getCircuit(a.provider).inFlight - this.getCircuit(b.provider).inFlight
    );
  }

  private requestContext(request: CompletionRequest) {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    return {
      request: {
        ...request,
        signal: request.signal
          ? AbortSignal.any([request.signal, controller.signal])
          : controller.signal,
      },
      finish: () => this.activeRequests.delete(controller),
    };
  }

  private attemptTimeoutMs(index: number, deadline: number): number {
    return Math.min(
      deadline - Date.now(),
      this.orderedConfigs[index]?.timeout ?? Number.POSITIVE_INFINITY
    );
  }

  private attemptContext(request: CompletionRequest, index: number, deadline: number) {
    request.signal?.throwIfAborted();
    const remaining = this.attemptTimeoutMs(index, deadline);
    if (remaining <= 0)
      throw new TimeoutError('provider response budget', this.config.completionTimeoutMs ?? 0);
    const controller = new AbortController();
    const timer = Number.isFinite(remaining)
      ? setTimeout(
          () => controller.abort(new TimeoutError('provider attempt', remaining)),
          remaining
        )
      : undefined;
    timer?.unref?.();
    return {
      request: {
        ...request,
        signal: request.signal
          ? AbortSignal.any([request.signal, controller.signal])
          : controller.signal,
      },
      abort: () => controller.abort(),
      finish: () => {
        if (timer) clearTimeout(timer);
      },
    };
  }

  private async completeWithinBudget(
    provider: IProvider,
    request: CompletionRequest,
    index: number,
    deadline: number
  ) {
    const attempt = this.attemptContext(request, index, deadline);
    try {
      return await readWithAbort(
        Promise.resolve().then(() => {
          attempt.request.signal.throwIfAborted();
          return provider.complete(attempt.request);
        }),
        attempt.request.signal
      );
    } finally {
      attempt.finish();
    }
  }

  private async *streamWithinBudget(
    provider: IProvider,
    request: CompletionRequest,
    index: number,
    deadline: number
  ): AsyncGenerator<Result<StreamChunk, InternalError>, void, unknown> {
    const attempt = this.attemptContext(request, index, deadline);
    const generator = provider.stream(attempt.request);
    let finished = false;
    try {
      while (true) {
        attempt.request.signal.throwIfAborted();
        const next = await readWithAbort(generator.next(), attempt.request.signal);
        if (next.done) {
          finished = true;
          return;
        }
        yield next.value;
      }
    } finally {
      attempt.finish();
      if (!finished) {
        attempt.abort();
        // A timed-out generator may still be awaiting an uncooperative custom
        // transport. Closing it must not block the next provider indefinitely.
        ignoreError(generator.return(), 'fallback.close-stream');
      }
    }
  }

  /**
   * Check if any provider is ready
   */
  isReady(): boolean {
    return this.getAllProviders().some((p) => p.isReady());
  }

  /**
   * Complete request with automatic fallback
   */
  async complete(
    request: CompletionRequest
  ): Promise<Result<CompletionResponse, InternalError | TimeoutError | ValidationError>> {
    const context = this.requestContext(request);
    try {
      return await this.completeRequest(context.request);
    } catch (error) {
      return err(
        error instanceof TimeoutError ||
          error instanceof ValidationError ||
          error instanceof InternalError
          ? error
          : new InternalError(
              context.request.signal.aborted ? 'Provider request cancelled' : String(error)
            )
      );
    } finally {
      context.finish();
    }
  }

  private async completeRequest(
    request: CompletionRequest
  ): Promise<Result<CompletionResponse, InternalError | TimeoutError | ValidationError>> {
    request.signal?.throwIfAborted();
    // Keep each provider's ORIGINAL index (into orderedConfigs) through the
    // readiness filter, so the per-fallback model swap maps to the right config
    // even when some providers are filtered out.
    const providers = this.preferCapacity(
      this.preferHealthy(
        this.getAllProviders()
          .map((provider, origIndex) => ({ provider, origIndex }))
          .filter((e) => e.provider.isReady())
      )
    );

    if (providers.length === 0) {
      return err(new ValidationError('No providers are configured or ready'));
    }

    const deadline = Date.now() + (this.config.completionTimeoutMs ?? Number.POSITIVE_INFINITY);
    // If fallback is disabled, keep the same cancellation and deadline contract.
    if (!this.config.enableFallback) {
      return this.completeWithinBudget(this.primary, request, 0, deadline);
    }

    let lastError: InternalError | TimeoutError | ValidationError | null = null;

    for (let i = 0; i < providers.length; i++) {
      request.signal?.throwIfAborted();
      if (Date.now() >= deadline) {
        lastError = new TimeoutError('channel response budget', this.config.completionTimeoutMs!);
        break;
      }
      const entry = providers[i];
      if (!entry) continue;
      const provider = entry.provider;

      // Circuit breaker: skip providers whose circuit is open
      const circuitAttempt = this.acquireCircuitAttempt(
        provider,
        entry.origIndex,
        deadline,
        request.signal
      );
      if (!circuitAttempt) {
        log.info(`Skipping ${provider.type} (circuit open)`);
        continue;
      }

      this.currentProviderIndex = entry.origIndex;

      try {
        log.info(`Trying provider ${i + 1}/${providers.length}: ${provider.type}`);

        const result = await this.completeWithinBudget(
          provider,
          this.requestForProvider(request, entry.origIndex),
          entry.origIndex,
          circuitAttempt.deadline
        );
        request.signal?.throwIfAborted();

        // A provider refusal is meaningful, rather than an empty transport result.
        if (result.ok && result.value.finishReason === 'content_filter') {
          this.recordSuccess(provider, circuitAttempt);
          return result;
        }
        const calls = result.ok ? (result.value.toolCalls ?? []) : [];
        let invalidResponse: string | undefined;
        if (result.ok && result.value.finishReason === 'length')
          invalidResponse = 'Provider reached its output limit before completing the response';
        if (result.ok && request.requiredToolCall) {
          if (
            calls.length !== 1 ||
            calls[0]!.name.replace(/__/g, '.') !== request.requiredToolCall.replace(/__/g, '.')
          )
            invalidResponse = 'Provider violated the required tool call contract';
          else {
            try {
              const args: unknown = JSON.parse(calls[0]!.arguments);
              if (args === null || typeof args !== 'object' || Array.isArray(args))
                invalidResponse = 'Provider returned invalid required tool arguments';
            } catch {
              invalidResponse = 'Provider returned invalid required tool arguments';
            }
          }
        }
        if (result.ok && request.toolChoice === 'none' && calls.length)
          invalidResponse = 'Provider returned tools during a text-only completion';
        if (result.ok && !calls.length && !result.value.content?.trim())
          invalidResponse = 'Provider returned an empty completion';
        if (result.ok && request.toolChoice === 'required' && !calls.length)
          invalidResponse = 'Provider did not perform the required tool call';
        if (invalidResponse) {
          // A prose-only answer is not a successful live lookup. No tool has
          // executed yet, so trying another configured model cannot replay a write.
          lastError =
            result.ok && result.value.finishReason === 'length'
              ? new OutputLimitError()
              : new InternalError(invalidResponse);
          log.warn(invalidResponse);
          this.recordFailure(provider, lastError, circuitAttempt);
          continue;
        }
        if (result.ok) {
          this.recordSuccess(provider, circuitAttempt);
          if (i > 0) {
            log.info(`Success with fallback provider: ${provider.type}`);
          }
          return result;
        }

        // Request failed
        lastError = result.error;
        if (!this.shouldFallback(result.error)) return err(result.error);

        log.warn(`Provider ${provider.type} failed: ${providerErrorSummary(result.error)}`);
        logError(provider.type, result.error, 'Fallback triggered');
        this.recordFailure(provider, result.error, circuitAttempt);

        // Check if we should try next provider
        if (i < providers.length - 1 && this.shouldFallback(result.error)) {
          const nextProvider = providers[i + 1]?.provider;
          if (nextProvider) {
            log.info(`Switching to next provider: ${nextProvider.type}`);

            if (this.config.onFallback) {
              this.config.onFallback(provider.type, result.error, nextProvider.type);
            }

            logRetry(i + 1, providers.length, result.error, 0);
          }
        }
      } catch (error) {
        if (request.signal?.aborted) return err(new InternalError('Provider request cancelled'));
        const errorObj = error instanceof Error ? error : new Error(String(error));
        lastError =
          errorObj instanceof TimeoutError ||
          errorObj instanceof ValidationError ||
          errorObj instanceof InternalError
            ? errorObj
            : new InternalError(errorObj.message);
        if (!this.shouldFallback(errorObj)) return err(lastError);
        log.error(
          `Provider ${provider.type} threw exception: ${providerErrorSummary(errorObj)}`,
          timeoutDetails(errorObj, 'completion')
        );
        logError(provider.type, errorObj, 'Exception during fallback');
        this.recordFailure(provider, errorObj, circuitAttempt);
      } finally {
        circuitAttempt.finish();
      }
    }

    // All providers failed
    log.error(`All ${providers.length} providers failed`);
    return err(lastError ?? new InternalError('All providers failed'));
  }

  /**
   * Stream with automatic fallback
   */
  async *stream(
    request: CompletionRequest
  ): AsyncGenerator<Result<StreamChunk, InternalError>, void, unknown> {
    const context = this.requestContext(request);
    try {
      yield* this.streamRequest(context.request);
    } catch (error) {
      yield err(
        new InternalError(
          context.request.signal.aborted ? 'Provider request cancelled' : String(error)
        )
      );
    } finally {
      context.finish();
    }
  }

  private async *streamRequest(
    request: CompletionRequest
  ): AsyncGenerator<Result<StreamChunk, InternalError>, void, unknown> {
    request.signal?.throwIfAborted();
    const providers = this.preferCapacity(
      this.preferHealthy(
        this.getAllProviders()
          .map((provider, origIndex) => ({ provider, origIndex }))
          .filter((e) => e.provider.isReady())
      )
    );

    if (providers.length === 0) {
      yield err(new InternalError('No providers are configured or ready'));
      return;
    }

    const deadline = Date.now() + (this.config.completionTimeoutMs ?? Number.POSITIVE_INFINITY);
    // If fallback is disabled, keep the same cancellation and deadline contract.
    if (!this.config.enableFallback) {
      yield* this.streamWithinBudget(this.primary, request, 0, deadline);
      return;
    }

    for (let i = 0; i < providers.length; i++) {
      request.signal?.throwIfAborted();
      if (Date.now() >= deadline) {
        yield err(new InternalError('Provider stream response budget exceeded'));
        return;
      }
      const entry = providers[i];
      if (!entry) continue;
      const provider = entry.provider;

      // Circuit breaker: skip providers whose circuit is open
      const circuitAttempt = this.acquireCircuitAttempt(
        provider,
        entry.origIndex,
        deadline,
        request.signal
      );
      if (!circuitAttempt) {
        log.info(`Stream: Skipping ${provider.type} (circuit open)`);
        continue;
      }

      this.currentProviderIndex = entry.origIndex;
      let hasOutput = false;

      try {
        log.info(`Stream: Trying provider ${i + 1}/${providers.length}: ${provider.type}`);

        let hasError = false;
        let lastError: InternalError | null = null;

        const generator = this.streamWithinBudget(
          provider,
          this.requestForProvider(request, entry.origIndex),
          entry.origIndex,
          circuitAttempt.deadline
        );

        for await (const result of generator) {
          request.signal?.throwIfAborted();
          if (!result.ok) {
            hasError = true;
            lastError = result.error;
            break;
          }
          if (result.value.finishReason === 'length') {
            // This terminal result is incomplete, even if it carries valid JSON
            // or text. Earlier emitted fragments cannot be replayed elsewhere.
            hasError = true;
            lastError = new OutputLimitError();
            break;
          }

          // Role/usage-only events carry no replayable response. Any text or
          // tool fragment, including only an id or argument prefix, commits us
          // to this stream. A moderation refusal must not trigger a reserve.
          hasOutput ||= Boolean(
            result.value.content ||
            result.value.toolCalls?.length ||
            result.value.finishReason === 'content_filter'
          );
          if (result.value.done) this.recordSuccess(provider, circuitAttempt);
          yield result;

          if (result.value.done) {
            return;
          }
        }

        // EOF without a terminal chunk is incomplete: never execute a partial
        // tool call or silently report a truncated response as success.
        if (!hasError) {
          hasError = true;
          lastError = new InternalError(
            hasOutput
              ? 'Provider stream ended before completion'
              : 'Provider returned an empty stream'
          );
        }

        // If error occurred, try next provider
        if (hasError && lastError) {
          if (!this.shouldFallback(lastError)) {
            yield err(lastError);
            return;
          }
          log.warn(`Stream: Provider ${provider.type} failed: ${providerErrorSummary(lastError)}`);
          this.recordFailure(provider, lastError, circuitAttempt);

          // If we already sent chunks to the client, do NOT retry with another
          // provider — the client would see duplicate/overlapping content.
          // Instead, signal the error and stop.
          if (hasOutput) {
            log.warn('Stream: Partial data already sent — cannot retry. Yielding error.');
            yield err(
              new InternalError(
                `Stream interrupted after partial data: ${providerErrorSummary(lastError)}`
              )
            );
            return;
          }

          if (i < providers.length - 1 && this.shouldFallback(lastError)) {
            const nextProvider = providers[i + 1]?.provider;
            if (nextProvider) {
              log.info(`Stream: Switching to next provider: ${nextProvider.type}`);

              if (this.config.onFallback) {
                this.config.onFallback(provider.type, lastError, nextProvider.type);
              }
            }
            continue;
          }

          yield err(lastError);
          return;
        }
      } catch (error) {
        if (request.signal?.aborted) {
          yield err(new InternalError('Provider request cancelled'));
          return;
        }
        const errorObj = error instanceof Error ? error : new Error(String(error));
        if (!this.shouldFallback(errorObj)) {
          yield err(new InternalError('Provider request cancelled'));
          return;
        }
        log.error(
          `Stream: Provider ${provider.type} threw exception: ${providerErrorSummary(errorObj)}`,
          timeoutDetails(errorObj, 'stream')
        );
        this.recordFailure(provider, errorObj, circuitAttempt);

        // A failed network stream after sending output is not replayable:
        // doing so could concatenate two responses or duplicate tool calls.
        if (hasOutput) {
          yield err(new InternalError('Stream interrupted after partial output'));
          return;
        }
        if (i < providers.length - 1) {
          continue;
        }

        yield err(new InternalError(errorObj.message));
        return;
      } finally {
        circuitAttempt.finish();
      }
    }

    yield err(new InternalError('All providers failed'));
  }

  /**
   * Count tokens using primary provider
   */
  countTokens(messages: readonly Message[]): number {
    return this.primary.countTokens(messages);
  }

  /**
   * Get models from all providers
   */
  async getModels(): Promise<Result<string[], InternalError>> {
    const allModels: string[] = [];
    const providers = this.getAllProviders().filter((p) => p.isReady());

    for (const provider of providers) {
      const result = await provider.getModels();
      if (result.ok) {
        allModels.push(...result.value);
      }
    }

    return ok([...new Set(allModels)]); // Deduplicate
  }

  /**
   * Determine if we should try the next provider based on the error
   */
  private shouldFallback(error: Error): boolean {
    // Authentication, model availability and request constraints belong to
    // each route. A separately configured provider can still succeed. Caller
    // cancellation is checked separately and must never start a new attempt.
    return error.name !== 'AbortError';
  }

  /**
   * Get the currently active provider type
   */
  getCurrentProvider(): AIProvider {
    const providers = this.getAllProviders();
    return providers[this.currentProviderIndex]?.type ?? this.type;
  }

  /**
   * Health check - check all providers, return best result.
   * Returns 'ok' if at least one provider is reachable.
   */
  async healthCheck(): Promise<Result<ProviderHealthResult, InternalError>> {
    const results: ProviderHealthResult[] = [];

    for (const provider of this.getAllProviders()) {
      const result = await provider.healthCheck();
      if (result.ok) {
        results.push(result.value);
      }
    }

    if (results.length === 0) {
      return err(new InternalError('No providers available for health check'));
    }

    // Return the best result (prefer ok, then lowest latency)
    const okResults = results.filter((r) => r.status === 'ok');
    if (okResults.length > 0) {
      const sorted = okResults.sort(
        (a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)
      );
      return ok(sorted[0]!);
    }

    // All unavailable — return the fastest-failing one
    const unavailableResults = results.sort(
      (a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)
    );
    return ok(unavailableResults[0]!);
  }

  /**
   * Record telemetry for the current active provider.
   * Delegates to the primary provider's recordMetric.
   */
  async recordMetric(input: {
    modelId: string;
    latencyMs: number;
    error: boolean;
    errorType?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    costUsd?: number | null;
    workflowId?: string | null;
    agentId?: string | null;
    userId?: string | null;
  }): Promise<void> {
    // Delegate to primary provider (or first available fallback)
    const providers = this.getAllProviders();
    if (providers.length > 0) {
      await providers[0]!.recordMetric(input);
    }
  }

  /**
   * Cancel request on all providers
   */
  cancel(): void {
    for (const controller of this.activeRequests) controller.abort();
    const providers = this.getAllProviders();
    for (const provider of providers) {
      if ('cancel' in provider && typeof provider.cancel === 'function') {
        provider.cancel();
      }
    }
  }
}

/**
 * Create a fallback provider from configuration
 */
export function createFallbackProvider(config: FallbackProviderConfig): FallbackProvider {
  return new FallbackProvider(config);
}

/**
 * Helper to create a provider with common fallbacks
 */
export function createProviderWithFallbacks(
  primary: ProviderConfig,
  options?: {
    fallbacks?: ProviderConfig[];
    enableFallback?: boolean;
    onFallback?: FallbackProviderConfig['onFallback'];
  }
): IProvider {
  // If no fallbacks provided, just return the primary provider
  if (!options?.fallbacks?.length) {
    return createProvider(primary);
  }

  return new FallbackProvider({
    primary,
    fallbacks: options.fallbacks,
    enableFallback: options.enableFallback ?? true,
    onFallback: options.onFallback,
  });
}
