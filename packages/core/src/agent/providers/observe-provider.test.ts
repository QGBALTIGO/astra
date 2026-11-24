import { describe, expect, it, vi } from 'vitest';
import type { IProvider } from '../provider-types.js';
import type { CompletionRequest, ProviderConfig } from '../types.js';
import { observeProvider } from './observe-provider.js';

const request: CompletionRequest = {
  model: { model: 'requested-model' },
  messages: [{ role: 'user', content: 'test' }],
};

describe('observeProvider', () => {
  it('records the concrete provider, requested and reported model, and actual usage', async () => {
    const usage = { promptTokens: 11, completionTokens: 7, totalTokens: 18 };
    const result = { ok: true, value: { model: 'reported-model', usage } };
    const complete = vi.fn().mockResolvedValue(result);
    const onInferenceAttempt = vi.fn();
    const config: ProviderConfig = {
      id: 'actual-provider',
      provider: 'openai-compatible',
      onInferenceAttempt,
    };
    const wrapped = observeProvider({ complete } as unknown as IProvider, config);
    expect(await wrapped.complete(request)).toBe(result);
    expect(onInferenceAttempt).toHaveBeenCalledWith({
      provider: 'actual-provider',
      requestedModel: 'requested-model',
      reportedModel: 'reported-model',
      usage,
      outcome: 'success',
      latencyMs: expect.any(Number),
    });
  });

  it('records a failed call without pretending its consumption was zero', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('upstream unavailable'));
    const onInferenceAttempt = vi.fn();
    const wrapped = observeProvider({ complete } as unknown as IProvider, {
      provider: 'openai',
      onInferenceAttempt,
    });
    await expect(wrapped.complete(request)).rejects.toThrow('upstream unavailable');
    expect(onInferenceAttempt).toHaveBeenCalledWith({
      provider: 'openai',
      requestedModel: 'requested-model',
      outcome: 'error',
      latencyMs: expect.any(Number),
    });
  });
});
