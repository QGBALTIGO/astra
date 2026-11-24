import { describe, expect, it, vi } from 'vitest';

vi.mock('@ownpilot/core/agent', () => ({ createProvider: vi.fn() }));
vi.mock('../log.js', () => ({ getLog: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../channels/channel-ai-admission.js', () => ({ getChannelAIAdmissionStats: vi.fn() }));
vi.mock('../ai-routing-readiness.js', () => ({ getAstraAiRoutingReadiness: vi.fn() }));
vi.mock('../agent/cache.js', () => ({
  getProviderApiKey: vi.fn(),
  loadProviderConfig: vi.fn(),
  NATIVE_PROVIDERS: new Set(),
}));
vi.mock('../app-settings.js', () => ({ getResolvedAuth: vi.fn() }));

import { checkProviderInference } from './inference-health.js';

const groq = { provider: 'groq', model: 'openai/gpt-oss-20b' };
const cloudflare = { provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-4.7-flash' };

describe('real-inference health probe orchestration', () => {
  it('deduplicates configured routes, excludes paid routes and isolates provider failures', async () => {
    const probe = vi.fn().mockRejectedValueOnce(new Error('secret')).mockResolvedValueOnce(true);
    const result = await checkProviderInference({
      routes: async () => [groq, groq, { provider: 'openai', model: 'paid' }, cloudflare],
      customerBusy: () => false,
      probe,
    });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.map(({ provider, status }) => [provider, status])).toEqual([
      ['groq', 'unavailable'],
      ['cloudflare-workers-ai', 'ok'],
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('never uses quota while a customer is active or queued', async () => {
    const probe = vi.fn();
    const routes = vi.fn(async () => [groq, cloudflare]);
    expect(await checkProviderInference({ routes, customerBusy: () => true, probe })).toEqual([]);
    expect(routes).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not start a second probe when customer traffic arrives mid-cycle', async () => {
    let busy = false;
    const probe = vi.fn(async () => {
      busy = true;
      return true;
    });
    const result = await checkProviderInference({
      routes: async () => [groq, cloudflare],
      customerBusy: () => busy,
      probe,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.map(({ status }) => status)).toEqual(['ok', 'skipped']);
  });
});
