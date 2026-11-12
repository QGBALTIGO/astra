import { beforeEach, describe, expect, it, vi } from 'vitest';

const { stored, repo } = vi.hoisted(() => {
  const stored = new Map<string, string>();
  return {
    stored,
    repo: {
      get: vi.fn(async (key: string) => stored.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
    },
  };
});
vi.mock('../db/repositories/settings/system.js', () => ({
  getSystemSettingsRepository: () => repo,
}));

import {
  DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS,
  getWhatsAppAccessMessageSettings,
  setWhatsAppAccessMessageSettings,
  whatsAppAccessMessageSettingsSchema,
} from './channel-access-message-settings.js';

const defaults = DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS;

beforeEach(() => {
  stored.clear();
  vi.clearAllMocks();
});

describe('WhatsApp access message settings', () => {
  it('uses the real Astra site and no fabricated renewal link by default', async () => {
    expect(await getWhatsAppAccessMessageSettings()).toEqual({
      siteUrl: 'https://astraacessor.pro',
      renewalUrl: null,
      timeZone: 'America/Campo_Grande',
    });
    expect(repo.get).toHaveBeenCalledWith('channel_access_messages:whatsapp:default');
    expect(repo.set).not.toHaveBeenCalled();
  });

  it('writes all settings atomically to the owner scope and reads them after a module reload', async () => {
    const settings = {
      siteUrl: 'https://astra.example/sobre',
      renewalUrl: 'https://pay.example/renovar?id=astra',
      timeZone: 'America/Sao_Paulo',
    };
    expect(await setWhatsAppAccessMessageSettings(settings)).toEqual(settings);
    expect(repo.set).toHaveBeenCalledExactlyOnceWith(
      'channel_access_messages:whatsapp:default',
      JSON.stringify(settings)
    );
    vi.resetModules();
    const reloaded = await import('./channel-access-message-settings.js');
    expect(await reloaded.getWhatsAppAccessMessageSettings()).toEqual(settings);
  });

  it('can clear a configured renewal link without replacing the site or time zone', async () => {
    await setWhatsAppAccessMessageSettings({
      ...defaults,
      renewalUrl: 'https://pay.example/astra',
    });
    await setWhatsAppAccessMessageSettings({ ...defaults, renewalUrl: null });
    expect(await getWhatsAppAccessMessageSettings()).toEqual(defaults);
  });

  it('publishes the new site when a stored setting points to the previous official home', async () => {
    const legacy = {
      ...defaults,
      siteUrl: 'https://astraacessor.vercel.app/',
      renewalUrl: 'https://custom.example/renew',
      timeZone: 'America/Cuiaba',
    };
    const data = JSON.stringify(legacy);
    stored.set('channel_access_messages:whatsapp:default', data);
    expect(await getWhatsAppAccessMessageSettings()).toEqual({
      ...legacy,
      siteUrl: 'https://astraacessor.pro',
    });
    expect(stored.get('channel_access_messages:whatsapp:default')).toBe(data);
  });
  it.each([
    'not-json',
    'null',
    '{"siteUrl":"javascript:alert(1)"}',
    JSON.stringify({ ...defaults, timeZone: 'Mars/Olympus' }),
  ])('uses safe defaults for malformed stored settings: %s', async (value) => {
    stored.set('channel_access_messages:whatsapp:default', value);
    expect(await getWhatsAppAccessMessageSettings()).toEqual(defaults);
  });

  it.each([
    '',
    'http://astra.example',
    'javascript:alert(1)',
    'data:text/html,hello',
    '//astra.example',
    'https://owner:password@astra.example',
    'https://owner@astra.example',
    'https://astra.example\nOutra mensagem',
    '\nhttps://astra.example',
    'https://astra.example/%0aMensagem',
    'https://astra.example/has space',
    'https://astra.example\\@evil.example',
    'https://',
    'https://astra.example/' + 'a'.repeat(2048),
  ])('rejects unsafe URLs before persistence: %j', async (url) => {
    await expect(setWhatsAppAccessMessageSettings({ ...defaults, siteUrl: url })).rejects.toThrow();
    await expect(
      setWhatsAppAccessMessageSettings({ ...defaults, renewalUrl: url })
    ).rejects.toThrow();
    expect(repo.set).not.toHaveBeenCalled();
  });

  it.each([
    'UTC',
    'America/Campo_Grande',
    'America/Sao_Paulo',
    'Europe/Lisbon',
    'Etc/GMT+4',
    'GMT0',
  ])('accepts a named time zone: %s', (timeZone) => {
    expect(whatsAppAccessMessageSettingsSchema.safeParse({ ...defaults, timeZone }).success).toBe(
      true
    );
  });

  it.each(['', 'Mars/Olympus', '+04:00', 'America/Campo_Grande<script>'])(
    'rejects unsupported time zones: %s',
    (timeZone) => {
      expect(whatsAppAccessMessageSettingsSchema.safeParse({ ...defaults, timeZone }).success).toBe(
        false
      );
    }
  );

  it('trims surrounding spaces and rejects partial or extended settings objects', () => {
    expect(
      whatsAppAccessMessageSettingsSchema.parse({
        ...defaults,
        siteUrl: '  https://astra.example  ',
      }).siteUrl
    ).toBe('https://astra.example');
    expect(
      whatsAppAccessMessageSettingsSchema.safeParse({ siteUrl: defaults.siteUrl }).success
    ).toBe(false);
    expect(
      whatsAppAccessMessageSettingsSchema.safeParse({ ...defaults, ownerId: 'other' }).success
    ).toBe(false);
  });
});
