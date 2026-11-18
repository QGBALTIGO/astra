import { describe, expect, it } from 'vitest';
import {
  ASTRA_LOCAL_FALLBACK_TIMEOUT_MS,
  ASTRA_CLOUDFLARE_TIMEOUT_MS,
  ASTRA_CHANNEL_OTHER_CLOUD_WITH_CLOUDFLARE_TIMEOUT_MS,
  astraChannelFallbackBudgetMs,
  getAstraChannelFallbackBudget,
  parseAstraFallbackChain,
  limitAstraFallbacks,
} from './fallback-chain.js';

describe('Astra free-only fallback policy', () => {
  it('preserves a full local inference allowance after every configured cloud timeout', () => {
    const cloudAttempts = [8_000, 8_000, 8_000, 8_000];
    const budget = astraChannelFallbackBudgetMs(5_000, [
      ...cloudAttempts,
      ASTRA_LOCAL_FALLBACK_TIMEOUT_MS,
    ]);
    expect(ASTRA_LOCAL_FALLBACK_TIMEOUT_MS).toBe(35_000);
    expect(budget - 5_000 - cloudAttempts.reduce((total, timeout) => total + timeout, 0)).toBe(
      36_000
    );
    expect(budget).toBeLessThanOrEqual(75_000);
    expect(astraChannelFallbackBudgetMs(35_000, [8_000])).toBe(44_000);
    expect(astraChannelFallbackBudgetMs(35_000, Array<number>(20).fill(8_000))).toBe(75_000);
  });

  it('reserves the full local allowance after the Cloudflare-specific attempt budgets', () => {
    expect(
      astraChannelFallbackBudgetMs(5_000, [
        ASTRA_CLOUDFLARE_TIMEOUT_MS,
        ASTRA_CHANNEL_OTHER_CLOUD_WITH_CLOUDFLARE_TIMEOUT_MS,
        ASTRA_LOCAL_FALLBACK_TIMEOUT_MS,
      ])
    ).toBe(60_000);
    expect(
      astraChannelFallbackBudgetMs(ASTRA_CLOUDFLARE_TIMEOUT_MS, [
        ASTRA_CHANNEL_OTHER_CLOUD_WITH_CLOUDFLARE_TIMEOUT_MS,
        ASTRA_LOCAL_FALLBACK_TIMEOUT_MS,
      ])
    ).toBe(55_000);
  });

  it.each([
    [[], 16_000],
    [['openrouter'], 16_000],
    [['cloudflare-workers-ai'], 24_000],
    [['cloudflare-workers-ai', 'openrouter'], 24_000],
  ] as const)('bounds a usable cloud-only channel chain %j to %i ms', (providers, budget) => {
    expect(getAstraChannelFallbackBudget(providers)).toBe(budget);
  });

  it('preserves existing manual fallback when feature is not enabled', () => {
    expect(
      parseAstraFallbackChain(undefined, 'groq', { provider: 'openai', model: 'gpt-4o' })
    ).toEqual([{ provider: 'openai', model: 'gpt-4o' }]);
  });

  it('keeps the five-reserve cap and stored priority after filtering unavailable candidates', () => {
    const chain =
      'zai=glm-4.7-flash,google=gemini-2.5-flash-lite,groq=openai/gpt-oss-20b,openrouter=openrouter/free,cloudflare-workers-ai=@cf/zai-org/glm-4.7-flash,ollama-local=qwen3:4b-instruct,openrouter=paid-model,unknown=secret';
    const explicit = { provider: 'openrouter', model: 'openrouter/free' };
    const candidates = parseAstraFallbackChain(chain, 'openai', explicit, { deferLimit: true });
    expect(candidates.map((candidate) => candidate.provider)).toEqual([
      'openrouter',
      'zai',
      'google',
      'groq',
      'cloudflare-workers-ai',
      'ollama-local',
    ]);
    expect(
      parseAstraFallbackChain(chain, 'openai', explicit).map((route) => route.provider)
    ).toEqual(['openrouter', 'zai', 'google', 'groq', 'ollama-local']);
    expect(limitAstraFallbacks(candidates, (route) => route.provider)).toEqual(
      parseAstraFallbackChain(chain, 'openai', explicit)
    );
    expect(
      limitAstraFallbacks(
        candidates.filter((route) => route.provider !== 'zai'),
        (route) => route.provider
      ).map((route) => route.provider)
    ).toEqual(['openrouter', 'google', 'groq', 'cloudflare-workers-ai', 'ollama-local']);
  });

  it('selects a deterministic multi-provider chain and excludes the primary', () => {
    expect(
      parseAstraFallbackChain(
        'zai=glm-4.7-flash,openrouter=openrouter/free,google=gemini-2.5-flash-lite,groq=openai/gpt-oss-120b',
        'groq'
      )
    ).toEqual([
      { provider: 'zai', model: 'glm-4.7-flash' },
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'google', model: 'gemini-2.5-flash-lite' },
    ]);
  });

  it('allows the verified free Gemini 3.5 Flash-Lite model as fallback', () => {
    expect(parseAstraFallbackChain('google=gemini-3.5-flash-lite', 'groq')).toEqual([
      { provider: 'google', model: 'gemini-3.5-flash-lite' },
    ]);
  });

  it('allows only the explicitly reviewed Workers AI model without changing cloud priority', () => {
    expect(
      parseAstraFallbackChain(
        'zai=glm-4.7-flash,cloudflare-workers-ai=@cf/zai-org/glm-4.7-flash,openrouter=openrouter/free,ollama-local=qwen3:4b-instruct',
        'groq'
      )
    ).toEqual([
      { provider: 'zai', model: 'glm-4.7-flash' },
      { provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-4.7-flash' },
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'ollama-local', model: 'qwen3:4b-instruct' },
    ]);
    expect(parseAstraFallbackChain('cloudflare-workers-ai=@cf/qwen/qwen3.8-27b', 'groq')).toEqual(
      []
    );
    expect(
      parseAstraFallbackChain(
        'cloudflare-workers-ai=@cf/zai-org/glm-4.7-flash',
        'cloudflare-workers-ai'
      )
    ).toEqual([]);
  });

  it('rejects paid, unknown and malformed fallback entries', () => {
    expect(
      parseAstraFallbackChain(
        'openrouter=openai/gpt-4o,zai=glm-5.2,unknown=model,google=gemini-3.7-pro,openrouter=openrouter/free',
        'groq',
        { provider: 'openai', model: 'gpt-4o' }
      )
    ).toEqual([{ provider: 'openrouter', model: 'openrouter/free' }]);
  });

  it('filters duplicates and accepts explicit free variant IDs', () => {
    expect(
      parseAstraFallbackChain(
        'openrouter=qwen/qwen3.8:free,openrouter=openrouter/free,zai=glm-4.5-flash,zai=glm-4.7-flash',
        'groq'
      )
    ).toEqual([
      { provider: 'openrouter', model: 'qwen/qwen3.8:free' },
      { provider: 'zai', model: 'glm-4.5-flash' },
    ]);
  });

  it('allows Groq free-tier models only when explicitly included in the chain', () => {
    expect(
      parseAstraFallbackChain(
        'zai=glm-4.7-flash,groq=openai/gpt-oss-20b,google=gemini-3.5-flash-lite,openrouter=openrouter/free',
        'ollama-local'
      )
    ).toEqual([
      { provider: 'zai', model: 'glm-4.7-flash' },
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
      { provider: 'google', model: 'gemini-3.5-flash-lite' },
      { provider: 'openrouter', model: 'openrouter/free' },
    ]);
    expect(parseAstraFallbackChain(undefined, 'ollama-local')).toEqual([]);
    expect(parseAstraFallbackChain('groq=openai/gpt-oss-120b', 'ollama-local')).toEqual([
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
    ]);
  });

  it('filters non-allowed Groq models and never duplicates the primary', () => {
    expect(
      parseAstraFallbackChain(
        'groq=qwen/qwen3.8-27b,groq=openai/gpt-oss-20b,google=gemini-2.5-flash-lite',
        'ollama-local'
      )
    ).toEqual([
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
      { provider: 'google', model: 'gemini-2.5-flash-lite' },
    ]);
    expect(parseAstraFallbackChain('groq=openai/gpt-oss-20b', 'groq')).toEqual([]);
  });

  it('never allows a paid model as fallback when automatic free routing is on', () => {
    expect(
      parseAstraFallbackChain('zai=glm-4.7-flash', 'groq', {
        provider: 'google',
        model: 'gemini-3.7-pro',
      })
    ).toEqual([{ provider: 'zai', model: 'glm-4.7-flash' }]);
  });

  it('allows only the installed local model as an explicitly selected last resort', () => {
    expect(
      parseAstraFallbackChain(
        'ollama-local=qwen3:4b-instruct,openrouter=openrouter/free,groq=openai/gpt-oss-20b',
        'groq'
      )
    ).toEqual([
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'ollama-local', model: 'qwen3:4b-instruct' },
    ]);
    expect(
      parseAstraFallbackChain('ollama-local=other-model,ollama=qwen3:4b-instruct', 'groq')
    ).toEqual([]);
    expect(
      parseAstraFallbackChain(undefined, 'groq', { provider: 'ollama-local', model: 'other-model' })
    ).toEqual([]);
    expect(
      parseAstraFallbackChain(undefined, 'groq', {
        provider: 'ollama-local',
        model: 'qwen3:4b-instruct',
      })
    ).toEqual([{ provider: 'ollama-local', model: 'qwen3:4b-instruct' }]);
  });

  it('never promotes a stored local fallback ahead of explicitly chosen cloud routes', () => {
    expect(
      parseAstraFallbackChain('openrouter=openrouter/free,ollama-local=qwen3:4b-instruct', 'groq', {
        provider: 'ollama-local',
        model: 'qwen3:4b-instruct',
      })
    ).toEqual([
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'ollama-local', model: 'qwen3:4b-instruct' },
    ]);
    expect(parseAstraFallbackChain('ollama-local=qwen3:4b-instruct', 'ollama-local')).toEqual([]);
    expect(parseAstraFallbackChain(undefined, 'groq')).toEqual([]);
  });
});
