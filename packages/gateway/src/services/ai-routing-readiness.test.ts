import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  catalog: [] as Array<{ id: string; models: Array<{ id: string }> }>,
  keys: new Map<string, string>(),
  configs: new Map<string, { baseUrl?: string }>(),
  configured: new Set<string>(),
  getProviderApiKey: vi.fn(),
  getResolvedAuth: vi.fn(),
  getConfiguredProviderIds: vi.fn(),
  resolveGlobal: vi.fn(),
  resolveProcess: vi.fn(),
  resolveChannel: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@ownpilot/core/agent', () => ({ getAllProviderConfigs: () => mocks.catalog }));
vi.mock('./app-settings.js', () => ({
  getResolvedAuth: mocks.getResolvedAuth,
  getConfiguredProviderIds: mocks.getConfiguredProviderIds,
  resolveDefaultProviderAndModel: mocks.resolveGlobal,
}));
vi.mock('./agent/cache.js', () => ({
  getProviderApiKey: mocks.getProviderApiKey,
  loadProviderConfig: (provider: string) => mocks.configs.get(provider) ?? null,
  NATIVE_PROVIDERS: new Set(['groq', 'google']),
}));
vi.mock('./llm/model-routing.js', () => ({
  resolveForProcess: mocks.resolveProcess,
  resolveForChannel: mocks.resolveChannel,
}));
vi.mock('./log.js', () => ({ getLog: () => ({ info: mocks.info, warn: mocks.warn }) }));

import { getAstraAiRoutingReadiness, logAstraAiRoutingReadiness } from './ai-routing-readiness.js';

const groq = { provider: 'groq', model: 'openai/gpt-oss-120b' };
const cloudflare = { provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-4.7-flash' };
const zai = { provider: 'zai', model: 'glm-4.7-flash' };
const openrouter = { provider: 'openrouter', model: 'openrouter/free' };
const google = { provider: 'google', model: 'gemini-2.5-flash-lite' };
const local = { provider: 'ollama-local', model: 'qwen3:4b-instruct' };
const credential = 'synthetic-credential-must-never-be-logged';
const accountId = '0123456789abcdef0123456789abcdef';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.keys.clear();
  mocks.configs.clear();
  mocks.configured.clear();
  mocks.catalog = [groq, cloudflare, zai, openrouter, google, local].map((route) => ({
    id: route.provider,
    models: [{ id: route.model }],
  }));
  for (const route of [groq, cloudflare, zai, openrouter]) {
    mocks.keys.set(route.provider, credential);
    mocks.configured.add(route.provider);
    mocks.configs.set(route.provider, {
      baseUrl: `https://example.invalid/accounts/${accountId}/${route.provider}`,
    });
  }
  mocks.getProviderApiKey.mockImplementation(async (provider: string) => mocks.keys.get(provider));
  mocks.getResolvedAuth.mockResolvedValue(undefined);
  mocks.getConfiguredProviderIds.mockImplementation(async () => new Set(mocks.configured));
  mocks.resolveGlobal.mockResolvedValue(groq);
  mocks.resolveProcess.mockResolvedValue({ ...groq, fallbackProvider: null, fallbackModel: null });
  mocks.resolveChannel.mockResolvedValue({ ...groq, fallbackProvider: null, fallbackModel: null });
  vi.stubEnv('ASTRA_FALLBACK_CHAIN', `${cloudflare.provider}=${cloudflare.model}`);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Astra AI routing startup readiness', () => {
  it('reports actual parsed priority with separate chat and default WhatsApp routes', async () => {
    vi.stubEnv(
      'ASTRA_FALLBACK_CHAIN',
      [cloudflare, google, zai, local, openrouter]
        .map((route) => `${route.provider}=${route.model}`)
        .join(',')
    );
    mocks.keys.set(local.provider, credential); // A key without a supported endpoint is insufficient.
    mocks.resolveProcess.mockResolvedValue({
      ...groq,
      fallbackProvider: openrouter.provider,
      fallbackModel: openrouter.model,
    });
    mocks.resolveChannel.mockResolvedValue({
      ...zai,
      fallbackProvider: cloudflare.provider,
      fallbackModel: cloudflare.model,
    });

    const snapshot = await getAstraAiRoutingReadiness();

    expect(snapshot).toEqual({
      globalDefault: groq,
      chat: {
        primary: groq,
        primaryReady: true,
        fallbackChain: [openrouter, cloudflare, zai],
        unrecognizedFallbackCount: 0,
      },
      whatsappDefault: {
        primary: zai,
        primaryReady: true,
        fallbackChain: [cloudflare, openrouter],
        unrecognizedFallbackCount: 0,
      },
      configuredProviderIds: ['cloudflare-workers-ai', 'groq', 'openrouter', 'zai'],
      unrecognizedConfiguredProviderCount: 0,
      cloudflareReady: true,
    });
    expect(mocks.resolveGlobal).toHaveBeenCalledWith('default', 'default');
    expect(mocks.resolveProcess).toHaveBeenCalledWith('chat');
    expect(mocks.resolveChannel).toHaveBeenCalledWith('channel.whatsapp');
  });

  it('does not report Cloudflare ready without an account-scoped endpoint or credential', async () => {
    mocks.configs.set(cloudflare.provider, { baseUrl: '' });
    let snapshot = await getAstraAiRoutingReadiness();
    expect(snapshot.cloudflareReady).toBe(false);
    expect(snapshot.chat.fallbackChain).toEqual([]);

    mocks.configs.set(cloudflare.provider, { baseUrl: 'https://example.invalid/ai/v1' });
    mocks.keys.delete(cloudflare.provider);
    snapshot = await getAstraAiRoutingReadiness();
    expect(snapshot.cloudflareReady).toBe(false);
    expect(snapshot.whatsappDefault.fallbackChain).toEqual([]);
  });

  it('includes a fallback configured only through a stored auth credential', async () => {
    mocks.keys.delete(cloudflare.provider);
    mocks.configured.delete(cloudflare.provider);
    mocks.getResolvedAuth.mockImplementation(async (provider: string) =>
      provider === cloudflare.provider ? { method: 'api_key', value: credential } : undefined
    );

    const snapshot = await getAstraAiRoutingReadiness();

    expect(snapshot.cloudflareReady).toBe(true);
    expect(snapshot.chat.fallbackChain).toEqual([cloudflare]);
    expect(snapshot.whatsappDefault.fallbackChain).toEqual([cloudflare]);
    expect(mocks.getProviderApiKey).not.toHaveBeenCalledWith(cloudflare.provider);
    expect(JSON.stringify(snapshot)).not.toContain(credential);
  });

  it('keeps the local reserve last when it is configured and permitted by the parser', async () => {
    mocks.keys.set(local.provider, credential);
    mocks.configs.set(local.provider, { baseUrl: 'http://127.0.0.1:8080/private/v1' });
    vi.stubEnv(
      'ASTRA_FALLBACK_CHAIN',
      [local, cloudflare, zai].map((route) => `${route.provider}=${route.model}`).join(',')
    );

    expect((await getAstraAiRoutingReadiness()).chat.fallbackChain).toEqual([
      cloudflare,
      zai,
      local,
    ]);
  });

  it('applies the chain cap only after unavailable providers have been removed', async () => {
    mocks.resolveProcess.mockResolvedValue({ provider: 'openai', model: 'gpt-4o' });
    vi.stubEnv(
      'ASTRA_FALLBACK_CHAIN',
      [zai, google, groq, openrouter, cloudflare, local]
        .map((route) => `${route.provider}=${route.model}`)
        .join(',')
    );
    // Google and the requested local reserve have no usable credential/config.
    expect((await getAstraAiRoutingReadiness()).chat.fallbackChain).toEqual([
      zai,
      groq,
      openrouter,
      cloudflare,
    ]);
  });

  it('does not report a displaced reserve when a runtime model is omitted from sanitized logs', async () => {
    mocks.resolveProcess.mockResolvedValue({ provider: 'openai', model: 'gpt-4o' });
    for (const route of [google, local]) {
      mocks.keys.set(route.provider, credential);
      mocks.configs.set(route.provider, { baseUrl: 'https://example.invalid/v1' });
    }
    vi.stubEnv(
      'ASTRA_FALLBACK_CHAIN',
      `openrouter=private-new-model:free,zai=glm-4.7-flash,google=gemini-2.5-flash-lite,groq=${groq.model},cloudflare-workers-ai=@cf/zai-org/glm-4.7-flash,ollama-local=qwen3:4b-instruct`
    );
    const snapshot = await getAstraAiRoutingReadiness();
    expect(snapshot.chat.fallbackChain).toEqual([zai, google, groq, local]);
    expect(snapshot.chat.unrecognizedFallbackCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('private-new-model');
  });

  it('logs only canonical identifiers, omitting malicious routing and credential strings', async () => {
    const injectedProvider = `groq\nAuthorization: Bearer ${credential}`;
    const injectedModel = `openai/gpt-oss-120b?api_key=${credential}`;
    const unknownFreeModel = 'private-credential-from-settings:free';
    mocks.configured.add(injectedProvider);
    mocks.configured.add('unknown-private-provider');
    mocks.resolveGlobal.mockResolvedValue({ provider: injectedProvider, model: injectedModel });
    mocks.resolveProcess.mockResolvedValue({
      provider: groq.provider,
      model: injectedModel,
      fallbackProvider: openrouter.provider,
      fallbackModel: unknownFreeModel,
    });
    mocks.resolveChannel.mockResolvedValue({
      provider: injectedProvider,
      model: cloudflare.model,
      fallbackProvider: injectedProvider,
      fallbackModel: injectedModel,
    });
    vi.stubEnv(
      'ASTRA_FALLBACK_CHAIN',
      `${openrouter.provider}=${unknownFreeModel},${zai.provider}=${zai.model}`
    );

    await logAstraAiRoutingReadiness();

    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenCalledWith(
      'Astra AI routing ready',
      expect.objectContaining({
        globalDefault: null,
        chat: expect.objectContaining({
          primary: null,
          primaryReady: false,
          fallbackChain: [zai],
          unrecognizedFallbackCount: 1,
        }),
        whatsappDefault: expect.objectContaining({ primary: null, primaryReady: false }),
        configuredProviderIds: ['cloudflare-workers-ai', 'groq', 'openrouter', 'zai'],
        unrecognizedConfiguredProviderCount: 2,
      })
    );
    const output = JSON.stringify([mocks.info.mock.calls, mocks.warn.mock.calls]);
    for (const privateValue of [
      credential,
      accountId,
      injectedProvider,
      injectedModel,
      unknownFreeModel,
      'unknown-private-provider',
      'https://',
      'Authorization',
    ])
      expect(output).not.toContain(privateValue);
    expect(mocks.getProviderApiKey).not.toHaveBeenCalledWith(injectedProvider);
    expect(mocks.getResolvedAuth).not.toHaveBeenCalledWith(injectedProvider);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('does not treat a model from another provider as a valid primary', async () => {
    mocks.resolveProcess.mockResolvedValue({ provider: groq.provider, model: cloudflare.model });
    const snapshot = await getAstraAiRoutingReadiness();
    expect(snapshot.chat.primary).toBeNull();
    expect(snapshot.chat.primaryReady).toBe(false);
  });

  it('contains database failures with a fixed warning and no private error details', async () => {
    mocks.getConfiguredProviderIds.mockRejectedValue(new Error(`database failed: ${credential}`));

    await expect(logAstraAiRoutingReadiness()).resolves.toBeUndefined();

    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.warn.mock.calls).toEqual([['Astra AI routing readiness unavailable']]);
  });

  it('bounds a stalled diagnostic and does not emit a late success marker', async () => {
    vi.useFakeTimers();
    let release: ((configured: Set<string>) => void) | undefined;
    mocks.getConfiguredProviderIds.mockImplementation(
      () =>
        new Promise<Set<string>>((resolve) => {
          release = resolve;
        })
    );
    const logging = logAstraAiRoutingReadiness();

    await vi.advanceTimersByTimeAsync(3_001);
    await logging;
    release?.(new Set(mocks.configured));
    await vi.runAllTimersAsync();

    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.warn.mock.calls).toEqual([['Astra AI routing readiness unavailable']]);
  });
});
