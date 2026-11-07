/**
 * Tests for provider/health.ts — provider health check service.
 *
 * Tests the runProviderHealthChecks function which probes provider /models
 * endpoints with a 5s timeout. Uses mocked fetch to simulate responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@ownpilot/core/services', () => ({
  getLog: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { runProviderHealthChecks } = await import('./health.js');

describe('provider/health', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear provider env vars so each test controls the setup
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('skips checks when no providers are configured', async () => {
    await runProviderHealthChecks();
    // No fetch calls should happen
    // (log.info 'No providers configured' is called but we mock the logger)
  });

  it('probes configured providers and reports results', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('openai')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
        });
      }
      return Promise.resolve({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await runProviderHealthChecks();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // OpenAI should be probed with its API key
    const openaiCall = mockFetch.mock.calls.find((c) => c[0].includes('openai'));
    expect(openaiCall).toBeDefined();
    expect(openaiCall![0]).toBe('https://api.openai.com/v1/models');
  });

  it('handles fetch errors gracefully', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network timeout'));
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    // Should not throw
    await expect(runProviderHealthChecks()).resolves.toBeUndefined();
  });

  it('handles mixed ok and unavailable providers', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GROQ_API_KEY = 'gsk_test';

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('openai')) {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
      }
      return Promise.resolve({ ok: false, status: 429, statusText: 'Too Many Requests' });
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await runProviderHealthChecks();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('includes Authorization header when API key is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await runProviderHealthChecks();

    const call = mockFetch.mock.calls[0];
    const options = call![1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-key');
  });
});
