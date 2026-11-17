import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider } from '../provider.js';
import type { CompletionRequest } from '../types.js';

vi.mock('../../services/get-log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(['google', 'openai', 'anthropic'] as const)('%s request cancellation', (name) => {
  it.each(['completion fetch', 'completion body', 'stream fetch', 'stream body'])(
    'aborts %s using the caller signal without retrying the cancelled request',
    async (stage) => {
      const provider = createProvider({
        provider: name,
        apiKey: 'synthetic-native-key',
        timeout: 1000,
        maxRetries: 2,
      });
      const controller = new AbortController();
      const input: CompletionRequest = {
        messages: [{ id: 'user-1', role: 'user', content: 'Hello' }],
        model: { model: 'test-model' },
        signal: controller.signal,
      };
      let transportSignal: AbortSignal | undefined;
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const pendingUntilAbort = () =>
        new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException('Caller cancelled', 'AbortError'));
          if (transportSignal?.aborted) rejectAbort();
          else transportSignal?.addEventListener('abort', rejectAbort, { once: true });
        });
      const cancelBody = vi.fn();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, options: RequestInit) => {
          transportSignal = options.signal as AbortSignal;
          if (stage.endsWith('fetch')) {
            markStarted();
            return pendingUntilAbort();
          }
          if (stage === 'stream body') {
            return new Response(
              new ReadableStream({
                pull() {
                  markStarted();
                },
                cancel: cancelBody,
              })
            );
          }
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json() {
              markStarted();
              return pendingUntilAbort();
            },
          };
        })
      );
      const pending = stage.startsWith('stream')
        ? (async () => {
            const results = [];
            for await (const result of provider.stream(input)) results.push(result);
            return results.at(-1);
          })()
        : provider.complete(input);
      await started;
      controller.abort();
      const result = await pending;
      expect(result?.ok).toBe(false);
      expect(transportSignal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      if (stage === 'stream body') expect(cancelBody).toHaveBeenCalledTimes(1);
    }
  );
});
