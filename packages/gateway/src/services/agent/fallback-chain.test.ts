import { describe, expect, it } from 'vitest';
import { parseAstraFallbackChain } from './fallback-chain.js';

describe('Astra free-only fallback policy', () => {
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

  it('never allows a paid model as fallback when automatic free routing is on', () => {
    expect(
      parseAstraFallbackChain('zai=glm-4.7-flash', 'groq', {
        provider: 'google',
        model: 'gemini-3.7-pro',
      })
    ).toEqual([{ provider: 'zai', model: 'glm-4.7-flash' }]);
  });
});
