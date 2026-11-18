import { describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../services/get-log.js', () => ({ getLog: () => ({ warn: f.warn }) }));
import {
  groqPoolFailureFacts,
  groqPoolRequestFacts,
  reportGroqPoolFailure,
} from './groq-pool-telemetry.js';
import { fetchGroqPool } from './groq-key-pool.js';

const request = groqPoolRequestFacts(
  JSON.stringify({
    model: 'openai/gpt-oss-20b',
    messages: [{ role: 'user', content: 'PRIVATE_PROMPT_500_RECEIPT' }],
    tools: [
      { type: 'function', function: { name: 'PRIVATE_TOOL_NAME', parameters: { type: 'object' } } },
    ],
    max_tokens: 700,
  })
);
const input = () => ({
  model: 'openai/gpt-oss-20b',
  keys: ['synthetic-private-key'],
  request,
  status: 429 as const,
  attempt: 2,
  cooldownMs: 1_100,
  elapsedMs: 300,
  headers: new Headers({
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-tokens': '0',
  }),
  errorText:
    'Request too large for model openai/gpt-oss-20b in organization PRIVATE_ORG on tokens per minute (TPM): Limit 8000, Requested 12345. synthetic-private-key',
});
describe('sanitized numerical Groq diagnostics', () => {
  it('distinguishes an oversized request from a generic exhausted quota without retaining sensitive content', () => {
    const facts = groqPoolFailureFacts(input());
    expect(facts).toMatchObject({
      provider: 'groq',
      status: 429,
      messageCount: 1,
      toolCount: 1,
      maxOutputTokens: 700,
      tokenLimit: 8000,
      remainingTokens: 0,
      quotaKind: 'tokens_per_minute',
      quotaLimit: 8000,
      quotaRequested: 12345,
      requestTooLarge: true,
    });
    expect(facts.requestTokensApprox).toBeGreaterThan(0);
    expect(facts.toolTokensApprox).toBeGreaterThan(0);
    const serialized = JSON.stringify(facts);
    for (const privateText of [
      'PRIVATE_PROMPT',
      'PRIVATE_TOOL',
      'PRIVATE_ORG',
      'synthetic-private-key',
      'Authorization',
      'errorText',
      'headers',
    ])
      expect(serialized).not.toContain(privateText);
  });
  it('does not classify a request that can fit after refill as inherently too large', () => {
    expect(
      groqPoolFailureFacts({
        ...input(),
        errorText:
          'Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2000.',
      })
    ).toMatchObject({
      quotaKind: 'tokens_per_minute',
      quotaUsed: 7000,
      quotaRequested: 2000,
      requestTooLarge: false,
    });
  });
  it.each([
    ['requests per minute (RPM)', 'requests_per_minute'],
    ['tokens per day (TPD)', 'tokens_per_day'],
    ['requests per day (RPD)', 'requests_per_day'],
  ])('recognizes documented quota units %s', (text, kind) => {
    expect(
      groqPoolFailureFacts({ ...input(), errorText: text + ': Limit 100, Requested 2' }).quotaKind
    ).toBe(kind);
  });
  it('does not extract personal numbers from an unrecognized error body', () => {
    const facts = groqPoolFailureFacts({
      ...input(),
      errorText: 'PRIVATE invoice Limit 12345 Requested 500',
    });
    expect(facts.quotaKind).toBe('unknown');
    expect(facts).not.toHaveProperty('quotaLimit');
    expect(facts).not.toHaveProperty('quotaRequested');
  });
  it('redacts a model field containing credentials and discards arbitrary headers', () => {
    const facts = groqPoolFailureFacts({
      ...input(),
      model: 'synthetic-private-key',
      headers: new Headers({
        Authorization: 'Bearer synthetic-private-key',
        'x-ratelimit-limit-tokens': 'invalid',
      }),
    });
    expect(facts.model).toBe('redacted-model');
    expect(facts).not.toHaveProperty('tokenLimit');
    expect(JSON.stringify(facts)).not.toContain('synthetic-private-key');
  });
  it('logs only the allowlisted numerical result and never throws when the logger fails', () => {
    reportGroqPoolFailure(input());
    expect(f.warn).toHaveBeenLastCalledWith(
      'Groq transport unavailable',
      groqPoolFailureFacts(input())
    );
    f.warn.mockImplementationOnce(() => {
      throw new Error('PRIVATE_LOGGER_FAILURE');
    });
    expect(() => reportGroqPoolFailure(input())).not.toThrow();
  });
  it('distinguishes a local budget refusal from a remote transport failure', () => {
    const local = {
      ...input(),
      status: 413,
      attempt: 0,
      errorText: 'request_too_large: groq_local_admission; private diagnostic must not be logged',
      requestTokenLimit: 8000,
    };
    reportGroqPoolFailure(local);
    expect(f.warn).toHaveBeenLastCalledWith(
      'Groq request rejected by local token budget',
      groqPoolFailureFacts(local)
    );
    expect(JSON.stringify(f.warn.mock.calls.at(-1))).not.toContain('private diagnostic');
  });
  it('does not spread accidental extra fields from a future caller into telemetry', () => {
    expect(
      JSON.stringify(
        groqPoolFailureFacts({
          ...input(),
          request: { ...request, prompt: 'PRIVATE_EXTRA' },
        } as Parameters<typeof groqPoolFailureFacts>[0])
      )
    ).not.toContain('PRIVATE_EXTRA');
  });
  it('records the actual pooled429 path using only sanitized metrics', async () => {
    f.warn.mockClear();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () => new Response(input().errorText, { status: 429, headers: input().headers })
        )
    );
    try {
      const response = await fetchGroqPool({
        keys: ['synthetic-private-key', 'synthetic-secondary-key'],
        model: 'openai/gpt-oss-20b',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        controller: new AbortController(),
        timeoutMs: 500,
        options: {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'PRIVATE_REALISTIC_PROMPT' }],
            max_tokens: 700,
          }),
        },
      });
      response.finish();
      expect(f.warn).toHaveBeenCalledTimes(2);
      expect(f.warn.mock.calls[0]?.[1]).toMatchObject({
        status: 429,
        quotaLimit: 8000,
        quotaRequested: 12345,
        requestTooLarge: true,
      });
      const logs = JSON.stringify(f.warn.mock.calls);
      for (const forbidden of [
        'PRIVATE_REALISTIC_PROMPT',
        'PRIVATE_ORG',
        'synthetic-private-key',
        'synthetic-secondary-key',
      ])
        expect(logs).not.toContain(forbidden);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
