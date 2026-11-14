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

/**
 * Circuit breaker states
 */
type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerEntry {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  reopenAt?: number;
  probeUntil?: number;
}
const sharedCircuits = new Map<string, CircuitBreakerEntry>();
const sharedPreferred = new Map<string, { index: number; at: number }>();
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
  /** Deadline for one non-streaming completion including all fallback attempts. */
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

    this.primary = createProvider(primaryConfig);
    this.type = config.primary.provider;
    this.fallbacks = config.fallbacks.map((fc) => createProvider(fc));
    this.orderedConfigs = [primaryConfig, ...config.fallbacks];
    this.availabilityIds = this.orderedConfigs.map((c) =>
      fingerprint([
        c.id ?? c.provider,
        c.provider,
        c.baseUrl ?? '',
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
      entry = { state: 'closed', failureCount: 0, lastFailureTime: 0, lastSuccessTime: 0 };
      if (circuits.size >= 256) circuits.delete(circuits.keys().next().value!);
      circuits.set(circuitId, entry);
    }
    return entry;
  }

  /** Returns true if the provider should be skipped */
  private isCircuitOpen(provider: IProvider): boolean {
    const circuit = this.getCircuit(provider);
    if (circuit.state === 'closed') return false;
    if (circuit.state === 'open') {
      // Check if cooldown has elapsed → transition to half-open
      if (Date.now() >= (circuit.reopenAt ?? circuit.lastFailureTime + this.cooldownMs)) {
        circuit.state = 'half-open';
        if (this.config.sharedCircuitBreaker) circuit.probeUntil = Date.now() + 10000;
        log.info(`CircuitBreaker ${provider.type}: open → half-open (cooldown elapsed)`);
        return false; // allow one test request
      }
      return true; // still open, skip
    }
    if (this.config.sharedCircuitBreaker) {
      if ((circuit.probeUntil ?? 0) > Date.now()) return true;
      circuit.probeUntil = Date.now() + 10000;
    }
    // half-open: allow one recovery probe through
    return false;
  }

  private recordSuccess(provider: IProvider): void {
    const circuit = this.getCircuit(provider);
    if (circuit.state !== 'closed') {
      log.info(`CircuitBreaker ${provider.type}: ${circuit.state} → closed`);
    }
    circuit.state = 'closed';
    circuit.failureCount = 0;
    circuit.lastSuccessTime = Date.now();
    circuit.reopenAt = undefined;
    circuit.probeUntil = undefined;
    if (this.config.preferLastSuccessful) {
      const previous = sharedPreferred.get(this.groupKey),
        now = Date.now(),
        index = this.getAllProviders().indexOf(provider);
      if (!previous || previous.index !== index || now - previous.at >= 300000) {
        if (sharedPreferred.size >= 64)
          sharedPreferred.delete(sharedPreferred.keys().next().value!);
        sharedPreferred.set(this.groupKey, { index, at: now });
      }
    }
  }

  private recordFailure(provider: IProvider, error?: Error): void {
    if (
      this.config.sharedCircuitBreaker &&
      error &&
      (error instanceof ValidationError ||
        /\b400\b|context[_ -]length[_ -]exceeded|maximum context length/i.test(error.message))
    )
      return;
    const circuit = this.getCircuit(provider);
    circuit.failureCount++;
    circuit.lastFailureTime = Date.now();
    circuit.probeUntil = undefined;
    circuit.reopenAt =
      circuit.lastFailureTime +
      (this.config.sharedCircuitBreaker
        ? providerCooldownMs(error, this.cooldownMs)
        : this.cooldownMs);

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
    return preferred && Date.now() - preferred.at < 300000
      ? entries.sort(
          (a, b) =>
            Number(b.origIndex === preferred.index) - Number(a.origIndex === preferred.index)
        )
      : entries;
  }
  private async completeWithinBudget(
    provider: IProvider,
    request: CompletionRequest,
    index: number,
    deadline: number
  ) {
    if (!this.config.completionTimeoutMs) return provider.complete(request);
    const remaining = Math.min(
      deadline - Date.now(),
      this.orderedConfigs[index]?.timeout ?? Number.POSITIVE_INFINITY
    );
    if (remaining <= 0)
      throw new TimeoutError('channel response budget', this.config.completionTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        provider.complete(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new TimeoutError('channel provider attempt', remaining)),
            remaining
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
    // Keep each provider's ORIGINAL index (into orderedConfigs) through the
    // readiness filter, so the per-fallback model swap maps to the right config
    // even when some providers are filtered out.
    const providers = this.preferHealthy(
      this.getAllProviders()
        .map((provider, origIndex) => ({ provider, origIndex }))
        .filter((e) => e.provider.isReady())
    );

    if (providers.length === 0) {
      return err(new ValidationError('No providers are configured or ready'));
    }

    // If fallback is disabled, just use primary
    if (!this.config.enableFallback) {
      return this.primary.complete(request);
    }

    let lastError: InternalError | TimeoutError | ValidationError | null = null;
    const deadline = Date.now() + (this.config.completionTimeoutMs ?? Number.POSITIVE_INFINITY);

    for (let i = 0; i < providers.length; i++) {
      if (Date.now() >= deadline) {
        lastError = new TimeoutError('channel response budget', this.config.completionTimeoutMs!);
        break;
      }
      const entry = providers[i];
      if (!entry) continue;
      const provider = entry.provider;

      // Circuit breaker: skip providers whose circuit is open
      if (this.isCircuitOpen(provider)) {
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
          deadline
        );

        if (result.ok && request.toolChoice === 'required' && !result.value.toolCalls?.length) {
          // A prose-only answer is not a successful live lookup. No tool has
          // executed yet, so trying another configured model cannot replay a write.
          lastError = new InternalError('Provider did not perform the required tool call');
          this.recordFailure(provider, lastError);
          continue;
        }
        if (result.ok) {
          this.recordSuccess(provider);
          if (i > 0) {
            log.info(`Success with fallback provider: ${provider.type}`);
          }
          return result;
        }

        // Request failed
        lastError = result.error;
        const errorMessage = result.error.message;

        log.warn(`Provider ${provider.type} failed: ${errorMessage}`);
        logError(provider.type, result.error, 'Fallback triggered');
        this.recordFailure(provider, result.error);

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
        const errorObj = error instanceof Error ? error : new Error(String(error));
        lastError = new InternalError(errorObj.message);
        log.error(`Provider ${provider.type} threw exception: ${errorObj.message}`);
        logError(provider.type, errorObj, 'Exception during fallback');
        this.recordFailure(provider, errorObj);
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
    const providers = this.preferHealthy(
      this.getAllProviders()
        .map((provider, origIndex) => ({ provider, origIndex }))
        .filter((e) => e.provider.isReady())
    );

    if (providers.length === 0) {
      yield err(new InternalError('No providers are configured or ready'));
      return;
    }

    // If fallback is disabled, just use primary
    if (!this.config.enableFallback) {
      yield* this.primary.stream(request);
      return;
    }

    for (let i = 0; i < providers.length; i++) {
      const entry = providers[i];
      if (!entry) continue;
      const provider = entry.provider;

      // Circuit breaker: skip providers whose circuit is open
      if (this.isCircuitOpen(provider)) {
        log.info(`Stream: Skipping ${provider.type} (circuit open)`);
        continue;
      }

      this.currentProviderIndex = entry.origIndex;
      let hasYielded = false;

      try {
        log.info(`Stream: Trying provider ${i + 1}/${providers.length}: ${provider.type}`);

        let hasError = false;
        let lastError: InternalError | null = null;

        const generator = provider.stream(this.requestForProvider(request, entry.origIndex));

        for await (const result of generator) {
          if (!result.ok) {
            hasError = true;
            lastError = result.error;
            break;
          }

          hasYielded = true;
          yield result;

          if (result.value.done) {
            this.recordSuccess(provider);
            return;
          }
        }

        // If we yielded data and finished without error, we're done
        if (hasYielded && !hasError) {
          this.recordSuccess(provider);
          return;
        }

        // If error occurred, try next provider
        if (hasError && lastError) {
          log.warn(`Stream: Provider ${provider.type} failed: ${lastError.message}`);
          this.recordFailure(provider, lastError);

          // If we already sent chunks to the client, do NOT retry with another
          // provider — the client would see duplicate/overlapping content.
          // Instead, signal the error and stop.
          if (hasYielded) {
            log.warn('Stream: Partial data already sent — cannot retry. Yielding error.');
            yield err(
              new InternalError(`Stream interrupted after partial data: ${lastError.message}`)
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
        const errorObj = error instanceof Error ? error : new Error(String(error));
        log.error(`Stream: Provider ${provider.type} threw exception: ${errorObj.message}`);
        this.recordFailure(provider, errorObj);

        // A failed network stream after sending output is not replayable:
        // doing so could concatenate two responses or duplicate tool calls.
        if (hasYielded) {
          yield err(new InternalError('Stream interrupted after partial output'));
          return;
        }
        if (i < providers.length - 1) {
          continue;
        }

        yield err(new InternalError(errorObj.message));
        return;
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
    // Always fallback on timeout
    if (error instanceof TimeoutError) {
      return true;
    }

    // Fallback on internal errors (typically API issues)
    if (error instanceof InternalError) {
      const message = error.message.toLowerCase();

      // Don't fallback on validation errors that would fail everywhere
      if (
        message.includes('invalid api key') ||
        message.includes('api key not configured') ||
        message.includes('not configured')
      ) {
        return false;
      }

      // Fallback on rate limits, server errors, timeouts, connection issues
      if (
        message.includes('timeout') ||
        message.includes('rate limit') ||
        message.includes('429') ||
        message.includes('500') ||
        message.includes('502') ||
        message.includes('503') ||
        message.includes('504') ||
        message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('etimedout') ||
        message.includes('enotfound') ||
        message.includes('socket') ||
        message.includes('network')
      ) {
        return true;
      }

      // Default: try fallback for unknown errors
      return true;
    }

    // For validation errors, don't fallback (they'll fail everywhere)
    if (error instanceof ValidationError) {
      return false;
    }

    // Unknown error types: try fallback
    return true;
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
