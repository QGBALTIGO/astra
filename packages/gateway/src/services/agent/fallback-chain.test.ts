import { describe, expect, it } from 'vitest';
import { parseAstraFallbackChain, getAstraChannelFallbackBudget } from './fallback-chain.js';

describe('Astra free-only fallback policy', () => {
  it.each([
    [[], 16_000],
    [['openrouter'], 16_000],
    [['cloudflare-workers-ai', 'openrouter'], 24_000],
    [['openrouter', 'ollama-local'], 26_000],
    [['cloudflare-workers-ai', 'openrouter', 'ollama-local'], 26_000],
  ] as const)('bounds a usable channel chain %j to %i ms', (providers, budget) => {
    expect(getAstraChannelFallbackBudget(providers)).toBe(budget);
  });

  it('preserves existing manual fallback when feature is not enabled', () => {
    expect(
      parseAstraFallbackChain(undefined, 'groq', { provider: 'openai', model: 'gpt-4o' })
    ).toEqual([{ provider: 'openai', model: 'gpt-4o' }]);
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
