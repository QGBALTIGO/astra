import type { IProvider } from '../provider-types.js';
import type { CompletionRequest, InferenceAttempt, ProviderConfig } from '../types.js';

/** Observe each provider invocation, including those that a fallback later replaces. */
export function observeProvider(provider: IProvider, config: ProviderConfig): IProvider {
  const notify = (
    request: CompletionRequest,
    start: number,
    event: Pick<InferenceAttempt, 'outcome' | 'reportedModel' | 'usage'>
  ) => {
    try {
      config.onInferenceAttempt?.({
        provider: config.id ?? config.provider,
        requestedModel: request.model.model,
        latencyMs: Math.max(0, Date.now() - start),
        ...event,
      });
    } catch {
      // Accounting must never change the inference result.
    }
  };

  return new Proxy(provider, {
    get(target, key) {
      if (key === 'complete') {
        return async (request: CompletionRequest) => {
          const start = Date.now();
          try {
            const result = await target.complete(request);
            notify(
              request,
              start,
              result.ok
                ? { outcome: 'success', reportedModel: result.value.model, usage: result.value.usage }
                : { outcome: 'error' }
            );
            return result;
          } catch (error) {
            notify(request, start, { outcome: 'error' });
            throw error;
          }
        };
      }
      if (key === 'stream') {
        return async function* (request: CompletionRequest) {
          const start = Date.now();
          let outcome: InferenceAttempt['outcome'] = 'interrupted';
          let usage: InferenceAttempt['usage'];
          try {
            for await (const result of target.stream(request)) {
              if (result.ok) {
                usage = result.value.usage ?? usage;
                if (result.value.done && outcome !== 'error') outcome = 'success';
              } else {
                outcome = 'error';
              }
              yield result;
            }
          } catch (error) {
            outcome = 'error';
            throw error;
          } finally {
            notify(request, start, { outcome, usage });
          }
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
