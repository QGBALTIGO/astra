import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/repositories/whatsapp-trials.js', () => ({
  whatsAppTrialsRepo: { recoverFirstContactTrial: vi.fn() },
}));
vi.mock('./pairing-service.js', () => ({ getOwnerUserId: vi.fn() }));
vi.mock('@ownpilot/core/channels', () => ({ getChannelService: vi.fn() }));
vi.mock('./log.js', () => ({ getLog: () => ({ info: vi.fn(), warn: vi.fn() }) }));
import { createWhatsAppFirstContactRecovery } from './whatsapp-first-contact-recovery.js';

const now = new Date('2026-11-16T20:00:00Z');
const phone = '5531999991234';
const botPhone = '5567999991111';
const request = { requestId: 'synthetic-recovery-01', phone, expiresAt: '2026-11-16T21:00:00Z' };
describe('named operator recovery of an unanswered first contact', () => {
  let raw: string | undefined;
  let enabled: boolean;
  const recover = vi.fn(async (_input: { requestId: string; phone: string; botPhone: string }) => ({
    outcome: 'queued' as const,
    userId: 'synthetic-user',
  }));
  const resolve = vi.fn(async () => phone);
  const owner = vi.fn(async (): Promise<string | null> => null);
  const api = {
    getPlatform: () => 'whatsapp',
    getStatus: () => 'connected',
    getBotInfo: () => ({ username: botPhone }),
    resolveWhatsAppRecipient: resolve,
  };
  const list = vi.fn(() => [
    { platform: 'whatsapp', status: 'connected', pluginId: 'channel.whatsapp' },
  ]);
  const get = vi.fn(() => api);
  const make = () =>
    createWhatsAppFirstContactRecovery({
      readRequest: () => raw,
      enabled: () => enabled,
      channels: () => ({ listChannels: list, getChannel: get }) as never,
      owner,
      recover,
      now: () => now,
    });
  beforeEach(() => {
    vi.clearAllMocks();
    raw = JSON.stringify(request);
    enabled = true;
    resolve.mockImplementation(async () => phone);
    owner.mockResolvedValue(null);
    list.mockReturnValue([
      { platform: 'whatsapp', status: 'connected', pluginId: 'channel.whatsapp' },
    ]);
    get.mockReturnValue(api);
    recover.mockResolvedValue({ outcome: 'queued', userId: 'synthetic-user' });
  });
  it('does nothing without an explicit request or with multiuser disabled', async () => {
    raw = undefined;
    expect(await make()()).toBe('disabled');
    raw = JSON.stringify(request);
    enabled = false;
    expect(await make()()).toBe('disabled');
    expect(list).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });
  it.each([
    '{invalid',
    '{}',
    JSON.stringify({ ...request, extra: true }),
    JSON.stringify({ ...request, phone: 'not-a-phone' }),
    JSON.stringify({ ...request, expiresAt: '2026-11-16T19:59:00Z' }),
    JSON.stringify({ ...request, expiresAt: '2026-11-18T20:00:00Z' }),
  ])(
    'rejects invalid or stale privileged requests without accessing a contact: %s',
    async (value) => {
      raw = value;
      expect(await make()()).toBe('invalid');
      expect(resolve).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
    }
  );
  it('verifies one intended recipient and queues once through the durable enrollment ledger', async () => {
    const run = make();
    expect(await run()).toBe('queued');
    expect(recover).toHaveBeenCalledExactlyOnceWith({
      requestId: request.requestId,
      phone,
      botPhone,
    });
    expect(await run()).toBe('skipped');
    expect(recover).toHaveBeenCalledTimes(1);
  });
  it('uses only a registered ninth-digit spelling of the specified number', async () => {
    resolve.mockResolvedValue('553199991234');
    expect(await make()()).toBe('queued');
    expect(recover.mock.calls[0]?.[0]).toMatchObject({ phone: '553199991234' });
  });
  it.each([null, '5531888887777'])(
    'defers an unverified or mismatched recipient %s',
    async (value) => {
      resolve.mockResolvedValue(value as never);
      expect(await make()()).toBe('deferred');
      expect(recover).not.toHaveBeenCalled();
    }
  );
  it('never guesses between multiple bots or queues while disconnected', async () => {
    list.mockReturnValue([]);
    expect(await make()()).toBe('deferred');
    list.mockReturnValue([
      { platform: 'whatsapp', status: 'connected', pluginId: 'one' },
      { platform: 'whatsapp', status: 'connected', pluginId: 'two' },
    ]);
    expect(await make()()).toBe('deferred');
    expect(recover).not.toHaveBeenCalled();
  });
  it('rejects the bot or owner, including equivalent dial strings', async () => {
    raw = JSON.stringify({ ...request, phone: botPhone });
    expect(await make()()).toBe('skipped');
    raw = JSON.stringify(request);
    owner.mockResolvedValue('553199991234');
    expect(await make()()).toBe('skipped');
    expect(recover).not.toHaveBeenCalled();
  });
  it('rechecks the request and channel after recipient verification', async () => {
    resolve.mockImplementation(async () => {
      raw = undefined;
      return phone;
    });
    expect(await make()()).toBe('deferred');
    expect(recover).not.toHaveBeenCalled();
  });
  it('defers if a second bot connects while resolving the recipient', async () => {
    resolve.mockImplementation(async () => {
      list.mockReturnValue([
        { platform: 'whatsapp', status: 'connected', pluginId: 'channel.whatsapp' },
        { platform: 'whatsapp', status: 'connected', pluginId: 'second' },
      ]);
      return phone;
    });
    expect(await make()()).toBe('deferred');
    expect(recover).not.toHaveBeenCalled();
  });
  it('serializes concurrent invocations and lets the ledger resolve an uncertain commit', async () => {
    let finish!: (value: string) => void;
    resolve.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        })
    );
    const run = make();
    const first = run();
    await Promise.resolve();
    await Promise.resolve();
    expect(await run()).toBe('deferred');
    finish(phone);
    expect(await first).toBe('queued');
    expect(recover).toHaveBeenCalledTimes(1);
  });
});
