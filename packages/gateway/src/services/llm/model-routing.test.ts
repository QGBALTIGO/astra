/**
 * Model Routing Service Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted lets the vi.mock factory below reference these vars
// without the temporal-dead-zone problem hoisting normally creates.
// ---------------------------------------------------------------------------

const { mockSettingsRepo } = vi.hoisted(() => ({
  mockSettingsRepo: {
    get: vi.fn((_: string) => null as string | null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => true),
    deleteByPrefix: vi.fn(async () => 0),
  },
}));

vi.mock('../../db/repositories/index.js', () => ({
  settingsRepo: mockSettingsRepo,
}));

const mockGetDefaultProvider = vi.fn(async () => 'openai' as string | null);
const mockGetDefaultModel = vi.fn(async (_provider?: string) => 'gpt-4o' as string | null);
const mockHasApiKey = vi.fn(async (_provider: string) => true);

vi.mock('../app-settings.js', () => ({
  getDefaultProvider: () => mockGetDefaultProvider(),
  getDefaultModel: (provider?: string) => mockGetDefaultModel(provider),
  hasApiKey: (provider: string) => mockHasApiKey(provider),
}));

vi.mock('../log.js', () => ({
  getLog: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { pricingByExactKey } from '@ownpilot/core/costs';
import {
  getProcessRouting,
  getAllRouting,
  resolveForProcess,
  setProcessRouting,
  setChannelScopedRouting,
  clearProcessRouting,
  clearChannelScopedRouting,
  isValidProcess,
  VALID_PROCESSES,
  getChannelRouting,
  getChannelScopedRouting,
  resolveForChannel,
  inferProviderForModel,
} from './model-routing.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('model-routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultProvider.mockResolvedValue('openai');
    mockGetDefaultModel.mockResolvedValue('gpt-4o');
  });

  // ── isValidProcess ──────────────────────────────────────────────────

  describe('isValidProcess', () => {
    it('returns true for valid processes', () => {
      expect(isValidProcess('chat')).toBe(true);
      expect(isValidProcess('channel')).toBe(true);
      expect(isValidProcess('channel_media')).toBe(true);
      expect(isValidProcess('pulse')).toBe(true);
    });

    it('returns false for invalid processes', () => {
      expect(isValidProcess('scheduler')).toBe(false);
      expect(isValidProcess('')).toBe(false);
      expect(isValidProcess('invalid')).toBe(false);
    });
  });

  describe('VALID_PROCESSES', () => {
    it('contains exactly 4 processes', () => {
      expect(VALID_PROCESSES).toEqual(['chat', 'channel', 'channel_media', 'pulse']);
    });
  });

  // ── inferProviderForModel ───────────────────────────────────────────
  // Uses the real pricing catalog (not mocked) — fixtures are derived from
  // a live entry so the test stays valid as models.dev data changes.

  describe('inferProviderForModel', () => {
    const [sampleKey, samplePricing] = [...pricingByExactKey.entries()][0]!;
    const sampleProvider = sampleKey.split(':')[0]!;
    const sampleModel = samplePricing.modelId;

    it('returns null for an empty model', () => {
      expect(inferProviderForModel('')).toBeNull();
      expect(inferProviderForModel('', sampleProvider)).toBeNull();
    });

    it('returns null for an unknown model', () => {
      expect(inferProviderForModel('definitely-not-a-real-model-zzz')).toBeNull();
    });

    it('keeps the preferred provider when it owns the model', () => {
      expect(inferProviderForModel(sampleModel, sampleProvider)).toBe(sampleProvider);
    });

    it('infers the owning provider from the catalog when no preference is given', () => {
      const expected = [...pricingByExactKey.values()].find(
        (p) => p.modelId === sampleModel
      )?.provider;
      expect(inferProviderForModel(sampleModel)).toBe(expected);
    });

    it('ignores a preferred provider that does not serve the model', () => {
      const result = inferProviderForModel(sampleModel, 'nonexistent-provider-xyz');
      expect(result).not.toBe('nonexistent-provider-xyz');
      expect(result).toBeTruthy();
    });
  });

  // ── getProcessRouting ───────────────────────────────────────────────

  describe('getProcessRouting', () => {
    it('returns nulls when no keys are set', () => {
      mockSettingsRepo.get.mockReturnValue(null);
      const result = getProcessRouting('chat');
      expect(result).toEqual({
        provider: null,
        model: null,
        fallbackProvider: null,
        fallbackModel: null,
      });
    });

    it('returns correct values when keys are set', () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        const map: Record<string, string> = {
          'model_routing:chat:provider': 'anthropic',
          'model_routing:chat:model': 'claude-sonnet-4-20250514',
          'model_routing:chat:fallback_provider': 'openai',
          'model_routing:chat:fallback_model': 'gpt-4o',
        };
        return map[key] ?? null;
      });

      const result = getProcessRouting('chat');
      expect(result).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        fallbackProvider: 'openai',
        fallbackModel: 'gpt-4o',
      });
    });

    it('reads the correct keys for each process', () => {
      mockSettingsRepo.get.mockReturnValue(null);
      getProcessRouting('channel');
      expect(mockSettingsRepo.get).toHaveBeenCalledWith('model_routing:channel:provider');
      expect(mockSettingsRepo.get).toHaveBeenCalledWith('model_routing:channel:model');
      expect(mockSettingsRepo.get).toHaveBeenCalledWith('model_routing:channel:fallback_provider');
      expect(mockSettingsRepo.get).toHaveBeenCalledWith('model_routing:channel:fallback_model');
    });
  });

  // ── getAllRouting ───────────────────────────────────────────────────

  describe('getAllRouting', () => {
    it('returns routing for all 3 processes', () => {
      mockSettingsRepo.get.mockReturnValue(null);
      const result = getAllRouting();
      expect(result).toHaveProperty('chat');
      expect(result).toHaveProperty('channel');
      expect(result).toHaveProperty('channel_media');
      expect(result).toHaveProperty('pulse');
    });
  });

  // ── resolveForProcess ──────────────────────────────────────────────

  describe('resolveForProcess', () => {
    it('returns process config with source=process when provider is set', async () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:chat:provider') return 'anthropic';
        if (key === 'model_routing:chat:model') return 'claude-sonnet-4-20250514';
        return null;
      });

      const result = await resolveForProcess('chat');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.source).toBe('process');
    });

    it('falls back to global default with source=global when no process config', async () => {
      mockSettingsRepo.get.mockReturnValue(null);
      mockGetDefaultProvider.mockResolvedValue('openai');
      mockGetDefaultModel.mockResolvedValue('gpt-4o');

      const result = await resolveForProcess('chat');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o');
      expect(result.source).toBe('global');
    });

    it('returns source=first-configured when no global default', async () => {
      mockSettingsRepo.get.mockReturnValue(null);
      mockGetDefaultProvider.mockImplementation(async () => null);
      mockGetDefaultModel.mockImplementation(async () => null);

      const result = await resolveForProcess('chat');
      expect(result.provider).toBeNull();
      expect(result.source).toBe('first-configured');
    });

    it('resolves model from provider default when only provider is set', async () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:pulse:provider') return 'anthropic';
        return null;
      });
      mockGetDefaultModel.mockResolvedValue('claude-sonnet-4-20250514');

      const result = await resolveForProcess('pulse');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.source).toBe('process');
      expect(mockGetDefaultModel).toHaveBeenCalledWith('anthropic');
    });

    it('passes through fallback fields independently', async () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:channel:fallback_provider') return 'openai';
        if (key === 'model_routing:channel:fallback_model') return 'gpt-4o-mini';
        return null;
      });

      const result = await resolveForProcess('channel');
      expect(result.fallbackProvider).toBe('openai');
      expect(result.fallbackModel).toBe('gpt-4o-mini');
      // Primary still falls to global
      expect(result.source).toBe('global');
    });
  });

  // ── setProcessRouting ──────────────────────────────────────────────

  describe('setProcessRouting', () => {
    it('writes correct keys for provider and model', async () => {
      await setProcessRouting('chat', { provider: 'anthropic', model: 'claude-3' });
      expect(mockSettingsRepo.set).toHaveBeenCalledWith('model_routing:chat:provider', 'anthropic');
      expect(mockSettingsRepo.set).toHaveBeenCalledWith('model_routing:chat:model', 'claude-3');
    });

    it('deletes key when value is null', async () => {
      await setProcessRouting('chat', { provider: null });
      expect(mockSettingsRepo.delete).toHaveBeenCalledWith('model_routing:chat:provider');
    });

    it('deletes key when value is empty string', async () => {
      await setProcessRouting('chat', { model: '' });
      expect(mockSettingsRepo.delete).toHaveBeenCalledWith('model_routing:chat:model');
    });

    it('writes fallback fields correctly', async () => {
      await setProcessRouting('pulse', {
        fallbackProvider: 'openai',
        fallbackModel: 'gpt-4o-mini',
      });
      expect(mockSettingsRepo.set).toHaveBeenCalledWith(
        'model_routing:pulse:fallback_provider',
        'openai'
      );
      expect(mockSettingsRepo.set).toHaveBeenCalledWith(
        'model_routing:pulse:fallback_model',
        'gpt-4o-mini'
      );
    });

    it('skips undefined fields', async () => {
      await setProcessRouting('chat', { provider: 'openai' });
      // Only provider should be set, not model/fallback
      expect(mockSettingsRepo.set).toHaveBeenCalledTimes(1);
      expect(mockSettingsRepo.delete).not.toHaveBeenCalled();
    });
  });

  // ── clearProcessRouting ────────────────────────────────────────────

  describe('clearProcessRouting', () => {
    it('calls deleteByPrefix with correct prefix', async () => {
      await clearProcessRouting('channel');
      expect(mockSettingsRepo.deleteByPrefix).toHaveBeenCalledWith('model_routing:channel:');
    });

    it('uses the right prefix for each process', async () => {
      await clearProcessRouting('chat');
      expect(mockSettingsRepo.deleteByPrefix).toHaveBeenCalledWith('model_routing:chat:');

      await clearProcessRouting('pulse');
      expect(mockSettingsRepo.deleteByPrefix).toHaveBeenCalledWith('model_routing:pulse:');
    });
  });

  // ── getChannelRouting ──────────────────────────────────────────────

  describe('getChannelRouting', () => {
    it('returns channel config when channel provider is set', () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:channel:provider') return 'anthropic';
        if (key === 'model_routing:channel:model') return 'claude-3';
        return null;
      });

      const result = getChannelRouting();
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-3');
    });

    it('falls back to legacy telegram keys when no channel config (lines 99-100)', () => {
      // channel config: all null; legacy telegram keys have values
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:telegram:provider') return 'openai';
        if (key === 'model_routing:telegram:model') return 'gpt-4o';
        if (key === 'model_routing:telegram:fallback_provider') return 'anthropic';
        if (key === 'model_routing:telegram:fallback_model') return 'claude-3';
        return null; // all channel: keys return null
      });

      const result = getChannelRouting();
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o');
      expect(result.fallbackProvider).toBe('anthropic');
      expect(result.fallbackModel).toBe('claude-3');
    });
  });

  describe('channel-scoped routing', () => {
    it("resolves the new provider default instead of inheriting another provider's model", async () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:channel:provider') return 'groq';
        if (key === 'model_routing:channel:model') return 'openai/gpt-oss-20b';
        if (key === 'model_routing:channel_plugin:channel.whatsapp:provider')
          return 'cloudflare-workers-ai';
        return null;
      });
      mockGetDefaultModel.mockImplementation(async (provider?: string) =>
        provider === 'cloudflare-workers-ai' ? '@cf/zai-org/glm-4.7-flash' : 'gpt-4o'
      );
      expect(await resolveForChannel('channel.whatsapp')).toMatchObject({
        provider: 'cloudflare-workers-ai',
        model: '@cf/zai-org/glm-4.7-flash',
      });
    });

    it('does not pair an overridden fallback provider with an inherited incompatible model', async () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:channel:provider') return 'groq';
        if (key === 'model_routing:channel:model') return 'openai/gpt-oss-20b';
        if (key === 'model_routing:channel:fallback_provider') return 'openrouter';
        if (key === 'model_routing:channel:fallback_model') return 'openrouter/free';
        if (key === 'model_routing:channel_plugin:channel.whatsapp:fallback_provider')
          return 'cloudflare-workers-ai';
        return null;
      });
      expect(await resolveForChannel('channel.whatsapp')).toMatchObject({
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        fallbackProvider: 'cloudflare-workers-ai',
        fallbackModel: null,
      });
    });

    it('reads plugin-scoped channel routing keys', () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:channel_plugin:channel.telegram:provider') return 'openai';
        if (key === 'model_routing:channel_plugin:channel.telegram:model') return 'gpt-4o';
        return null;
      });

      const result = getChannelScopedRouting('channel.telegram');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o');
    });

    it('writes and clears plugin-scoped media routing keys', async () => {
      await setChannelScopedRouting(
        'channel.whatsapp',
        { provider: 'google', model: 'gemini-2.5-flash' },
        'media'
      );
      expect(mockSettingsRepo.set).toHaveBeenCalledWith(
        'model_routing:channel_plugin_media:channel.whatsapp:provider',
        'google'
      );
      expect(mockSettingsRepo.set).toHaveBeenCalledWith(
        'model_routing:channel_plugin_media:channel.whatsapp:model',
        'gemini-2.5-flash'
      );

      await clearChannelScopedRouting('channel.whatsapp', 'media');
      expect(mockSettingsRepo.deleteByPrefix).toHaveBeenCalledWith(
        'model_routing:channel_plugin_media:channel.whatsapp:'
      );
    });

    it('prefers channel-specific routing over shared channel routing', async () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:channel:provider') return 'anthropic';
        if (key === 'model_routing:channel:model') return 'claude-shared';
        if (key === 'model_routing:channel_plugin:channel.telegram:provider') return 'openai';
        if (key === 'model_routing:channel_plugin:channel.telegram:model') return 'gpt-4o';
        return null;
      });

      const result = await resolveForChannel('channel.telegram');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o');
      expect(result.source).toBe('channel');
    });

    it('uses channel_media routing for attachment-heavy messages', async () => {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:channel:provider') return 'anthropic';
        if (key === 'model_routing:channel:model') return 'claude-text';
        if (key === 'model_routing:channel_media:provider') return 'google';
        if (key === 'model_routing:channel_media:model') return 'gemini-2.5-flash';
        return null;
      });

      const result = await resolveForChannel('channel.whatsapp', { hasMedia: true });
      expect(result.provider).toBe('google');
      expect(result.model).toBe('gemini-2.5-flash');
      expect(result.source).toBe('process');
    });
  });
});

describe('opt-in local Ollama WhatsApp routing', () => {
  it('prefers the local model only for text WhatsApp turns when explicitly enabled', async () => {
    vi.stubEnv('ASTRA_CHANNEL_LOCAL_OLLAMA', 'true');
    vi.stubEnv('ASTRA_ONLY_GROQ', 'false');
    vi.stubEnv('ASTRA_LOCAL_OLLAMA_BRIDGE_TOKEN', 'a'.repeat(64));
    try {
      mockSettingsRepo.get.mockImplementation((key: string) => {
        if (key === 'model_routing:channel:provider') return 'groq';
        if (key === 'model_routing:channel:model') return 'openai/gpt-oss-120b';
        if (key === 'model_routing:channel:fallback_provider') return 'zai';
        if (key === 'model_routing:channel:fallback_model') return 'glm-4.7-flash';
        return null;
      });
      const local = await resolveForChannel('channel.whatsapp');
      expect(local.provider).toBe('ollama-local');
      expect(local.model).toBe('qwen3:4b-instruct');
      expect(local.fallbackProvider).toBe('zai');
      expect(local.fallbackModel).toBe('glm-4.7-flash');

      const media = await resolveForChannel('channel.whatsapp', { hasMedia: true });
      expect(media.provider).toBe('groq');
      const telegram = await resolveForChannel('channel.telegram');
      expect(telegram.provider).toBe('groq');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed when token is missing or the operator disabled the pilot', async () => {
    vi.stubEnv('ASTRA_CHANNEL_LOCAL_OLLAMA', 'true');
    vi.stubEnv('ASTRA_LOCAL_OLLAMA_BRIDGE_TOKEN', '');
    try {
      const noKey = await resolveForChannel('channel.whatsapp');
      expect(noKey.provider).not.toBe('ollama-local');
      vi.stubEnv('ASTRA_LOCAL_OLLAMA_BRIDGE_TOKEN', 'a'.repeat(64));
      vi.stubEnv('ASTRA_CHANNEL_LOCAL_OLLAMA', 'false');
      const disabled = await resolveForChannel('channel.whatsapp');
      expect(disabled.provider).not.toBe('ollama-local');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('explicit Groq primary for text channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ASTRA_CHANNEL_USE_PRIMARY', 'true');
    vi.stubEnv('ASTRA_PRIMARY_PROVIDER', 'groq');
    vi.stubEnv('ASTRA_GROQ_MODEL', 'openai/gpt-oss-20b');
    vi.stubEnv('ASTRA_CHANNEL_LOCAL_OLLAMA', 'false');
    mockHasApiKey.mockResolvedValue(true);
    mockSettingsRepo.get.mockImplementation((key: string) => {
      if (key.endsWith(':fallback_provider')) return 'openai';
      if (key.endsWith(':fallback_model')) return 'gpt-4o';
      if (key.endsWith(':provider')) return 'google';
      if (key.endsWith(':model')) return 'gemini-stored';
      return null;
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    'channel.whatsapp',
    'channel.telegram',
    'channel.whatsapp.support',
    'channel.telegram-support',
  ])('overrides stored Google routing for %s without changing settings', async (channel) => {
    expect(await resolveForChannel(channel)).toEqual({
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
      source: 'channel-primary',
      fallbackProvider: null,
      fallbackModel: null,
    });
    expect(mockHasApiKey).toHaveBeenCalledWith('groq');
    expect(getChannelScopedRouting(channel).provider).toBe('google');
    expect(mockSettingsRepo.set).not.toHaveBeenCalled();
    expect(mockSettingsRepo.delete).not.toHaveBeenCalled();
    expect(mockSettingsRepo.deleteByPrefix).not.toHaveBeenCalled();
  });
  it.each(['openai/gpt-oss-20b', 'openai/gpt-oss-120b'])(
    'accepts only a reviewed Groq model: %s',
    async (model) => {
      vi.stubEnv('ASTRA_GROQ_MODEL', model);
      expect(await resolveForChannel('channel.whatsapp')).toMatchObject({
        provider: 'groq',
        model,
        source: 'channel-primary',
      });
    }
  );
  it.each([
    '',
    'gpt-4o',
    'groq/unknown',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-20b,google=gemini-2.5-flash-lite',
  ])(
    'preserves stored routing when the model is absent or not explicitly allowed: %s',
    async (model) => {
      vi.stubEnv('ASTRA_GROQ_MODEL', model);
      expect(await resolveForChannel('channel.whatsapp')).toMatchObject({
        provider: 'google',
        model: 'gemini-stored',
        source: 'channel',
      });
      expect(mockHasApiKey).not.toHaveBeenCalled();
      expect(mockSettingsRepo.set).not.toHaveBeenCalled();
    }
  );
  it('restores the original routing immediately when the operator disables the flag', async () => {
    expect((await resolveForChannel('channel.whatsapp')).provider).toBe('groq');
    vi.stubEnv('ASTRA_CHANNEL_USE_PRIMARY', 'false');
    expect(await resolveForChannel('channel.whatsapp')).toMatchObject({
      provider: 'google',
      model: 'gemini-stored',
      source: 'channel',
    });
    expect(mockSettingsRepo.set).not.toHaveBeenCalled();
  });
  it('does not pin another provider or a Groq route without an existing credential', async () => {
    vi.stubEnv('ASTRA_PRIMARY_PROVIDER', 'openai');
    expect((await resolveForChannel('channel.whatsapp')).provider).toBe('google');
    vi.stubEnv('ASTRA_PRIMARY_PROVIDER', 'groq');
    mockHasApiKey.mockResolvedValue(false);
    expect((await resolveForChannel('channel.whatsapp')).provider).toBe('google');
    expect(mockSettingsRepo.set).not.toHaveBeenCalled();
  });
  it('preserves media, other channels and UI/autonomous process routing', async () => {
    for (const channel of ['channel.whatsapp', 'channel.telegram'])
      expect((await resolveForChannel(channel, { hasMedia: true })).provider).toBe('google');
    expect((await resolveForChannel('channel.slack')).provider).toBe('google');
    expect((await resolveForProcess('chat')).provider).toBe('google');
    expect((await resolveForProcess('pulse')).provider).toBe('google');
    expect(mockHasApiKey).not.toHaveBeenCalled();
  });
  it('retains an explicitly configured allowed fallback without inferring a paid route', async () => {
    mockSettingsRepo.get.mockImplementation((key: string) => {
      if (key.endsWith(':fallback_provider')) return 'zai';
      if (key.endsWith(':fallback_model')) return 'glm-4.7-flash';
      return null;
    });
    expect(await resolveForChannel('channel.whatsapp')).toMatchObject({
      provider: 'groq',
      fallbackProvider: 'zai',
      fallbackModel: 'glm-4.7-flash',
    });
  });
  it('takes precedence over an older opt-in local WhatsApp pilot', async () => {
    vi.stubEnv('ASTRA_CHANNEL_LOCAL_OLLAMA', 'true');
    vi.stubEnv('ASTRA_LOCAL_OLLAMA_BRIDGE_TOKEN', 'synthetic'.repeat(8));
    expect((await resolveForChannel('channel.whatsapp')).provider).toBe('groq');
  });
});
