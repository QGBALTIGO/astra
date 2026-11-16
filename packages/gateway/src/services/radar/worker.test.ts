import { beforeEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({
  reserve: vi.fn(),
  claim: vi.fn(),
  current: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
  defer: vi.fn(),
  raw: vi.fn(),
  mark: vi.fn(),
  preferences: vi.fn(),
  account: vi.fn(),
  latest: vi.fn(),
  user: vi.fn(),
  identity: vi.fn(),
  list: vi.fn(),
  channel: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => ({ listChannels: m.list, getChannel: m.channel, send: m.send }),
}));
vi.mock('../../db/repositories/customer-radar.js', () => ({
  radarRepo: {
    reserveProvider: m.reserve,
    claimDeliveries: m.claim,
    deliveryCurrent: m.current,
    beginDelivery: m.begin,
    finishDelivery: m.finish,
    deferDelivery: m.defer,
    rawInterests: m.raw,
    markContent: m.mark,
  },
  CustomerRadarRepository: class {
    preferences = m.preferences;
  },
}));
vi.mock('../../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: m.account, getById: m.latest },
  effectiveCustomerTimeZone: () => 'America/Campo_Grande',
}));
vi.mock('../../db/repositories/channels/users.js', () => ({
  channelUsersRepo: { getById: m.user },
}));
vi.mock('../customer-identity.js', () => ({ resolveCustomerPhone: m.identity }));
vi.mock('./providers.js', () => ({
  snapshotFingerprint: () => 'hash',
  RADAR_POLL_SECONDS: {},
  fetchRadarResource: vi.fn(),
}));
import { dispatchRadar } from './worker.js';
import { ChannelSendNotAttemptedError } from '../../channels/send-not-attempted.js';
const now = new Date('2026-11-16T11:00:00Z');
const account = {
  id: 'account-a',
  dataUserId: 'whatsapp:5567999991111',
  channelUserId: 'channel-a',
  phoneNumber: '5567999991111',
  timeZone: 'America/Campo_Grande',
};
const job = {
  id: 'job',
  user_id: account.dataUserId,
  interest_id: null,
  interest_revision: 1,
  preference_revision: 1,
  event_key: 'digest:2026-11-16',
  payload: {},
  expires_at: '2026-11-16T13:00:00Z',
  lease_token: 'lease',
};
function followed() {
  return {
    id: 'interest',
    user_id: account.dataUserId,
    resource_id: 'resource',
    label: 'USD',
    active: true,
    revision: 1,
    input: { source: 'currency', target: 'USD', delivery: 'digest', leadMinutes: 60 },
    last_content_key: null,
    snapshot: {
      items: [{ id: 'price', title: 'USD', value: '5.65', text: 'Referência' }],
      observedAt: now.toISOString(),
      expiresAt: '2026-11-16T12:00:00Z',
      sourceLabel: 'Frankfurter',
      sourceUrl: 'https://frankfurter.dev/',
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  m.reserve.mockResolvedValue(true);
  m.claim.mockResolvedValue([structuredClone(job)]);
  m.current.mockResolvedValue(true);
  m.begin.mockResolvedValue(true);
  m.account.mockResolvedValue({ ...account });
  m.latest.mockResolvedValue({ ...account });
  m.user.mockResolvedValue({
    id: 'channel-a',
    ownpilotUserId: 'whatsapp:' + account.phoneNumber,
    isVerified: true,
    isBlocked: false,
    status: 'active',
    accessSource: 'trial',
    accessExpiresAt: new Date('2099-01-01T00:00:00Z'),
  });
  m.identity.mockResolvedValue({ accountId: 'account-a', retired: false });
  m.raw.mockResolvedValue([followed()]);
  m.preferences.mockResolvedValue({
    preferences: { enabled: true, time: '07:00', quietStart: '22:00', quietEnd: '07:00' },
    revision: 1,
  });
  m.list.mockReturnValue([{ pluginId: 'wa-main', platform: 'whatsapp' }]);
  m.channel.mockReturnValue({ getStatus: () => 'connected' });
  m.send.mockResolvedValue('receipt');
});
describe('Radar final delivery authorization and failures', () => {
  it('submits one combined message to the current verified phone', async () => {
    expect(await dispatchRadar(now)).toBe(1);
    expect(m.send).toHaveBeenCalledWith(
      'wa-main',
      expect.objectContaining({
        platformChatId: account.phoneNumber,
        text: expect.stringContaining('Seu Radar Astra'),
      })
    );
    expect(m.finish).toHaveBeenCalledWith(expect.anything(), 'sent', 'receipt');
  });
  it('does not transmit after an opt-out during processing', async () => {
    m.begin.mockResolvedValue(false);
    await dispatchRadar(now);
    expect(m.send).not.toHaveBeenCalled();
  });
  it('does not transmit an already cancelled or stale revision', async () => {
    m.current.mockResolvedValue(false);
    await dispatchRadar(now);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.finish).toHaveBeenCalledWith(expect.anything(), 'cancelled');
  });
  it.each(['blocked', 'expired', 'unverified', 'inactive'])(
    'does not submit for access state %s',
    async (kind) => {
      const u = await m.user();
      if (kind === 'blocked') u.isBlocked = true;
      if (kind === 'expired') u.accessExpiresAt = new Date('2000-01-01');
      if (kind === 'unverified') u.isVerified = false;
      if (kind === 'inactive') u.status = 'inactive';
      m.user.mockResolvedValue(u);
      await dispatchRadar(now);
      expect(m.send).not.toHaveBeenCalled();
      expect(m.finish).toHaveBeenCalledWith(expect.anything(), 'cancelled');
    }
  );
  it('does not use an alias now assigned to another account', async () => {
    m.identity.mockResolvedValue({ accountId: 'account-b', retired: false });
    await dispatchRadar(now);
    expect(m.send).not.toHaveBeenCalled();
  });
  it('does not transmit to a retired number', async () => {
    m.identity.mockResolvedValue({ accountId: 'account-a', retired: true });
    await dispatchRadar(now);
    expect(m.send).not.toHaveBeenCalled();
  });
  it('defers after a number change while preparing the message', async () => {
    m.latest.mockResolvedValue({ ...account, phoneNumber: '5567999992222' });
    await dispatchRadar(now);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.defer).toHaveBeenCalled();
  });
  it('defers until the account is outside its own quiet hours', async () => {
    m.preferences.mockResolvedValue({
      preferences: { enabled: true, time: '08:00', quietStart: '22:00', quietEnd: '08:00' },
      revision: 1,
    });
    await dispatchRadar(now);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.defer).toHaveBeenCalledWith(expect.anything(), 60);
  });
  it('does not choose an arbitrary sender when multiple WhatsApp channels exist', async () => {
    m.list.mockReturnValue([
      { pluginId: 'wa-a', platform: 'whatsapp' },
      { pluginId: 'wa-b', platform: 'whatsapp' },
    ]);
    await dispatchRadar(now);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.defer).toHaveBeenCalled();
  });
  it('waits for reconnection without consuming transport attempts', async () => {
    m.channel.mockReturnValue({ getStatus: () => 'disconnected' });
    await dispatchRadar(now);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.defer).toHaveBeenCalled();
  });
  it('does not treat an empty receipt as a successful send', async () => {
    m.send.mockResolvedValue('');
    expect(await dispatchRadar(now)).toBe(0);
    expect(m.finish).toHaveBeenCalledWith(expect.anything(), 'unknown', '');
  });
  it('does not blindly retry after a transport timeout', async () => {
    m.send.mockRejectedValue(new Error('timeout'));
    await dispatchRadar(now);
    expect(m.finish).toHaveBeenCalledWith(expect.anything(), 'unknown');
    expect(m.defer).not.toHaveBeenCalled();
  });
  it('recovers a trusted provably-not-attempted preflight rejection', async () => {
    m.send.mockRejectedValue(
      new ChannelSendNotAttemptedError(new Error('authorization unavailable'))
    );
    await dispatchRadar(now);
    expect(m.defer).toHaveBeenCalledWith(expect.anything(), 60, true);
  });
  it('does not trust an ordinary transport exception with a spoofed class name', async () => {
    const error = new Error('transport failed');
    error.name = 'ChannelSendNotAttemptedError';
    m.send.mockRejectedValue(error);
    await dispatchRadar(now);
    expect(m.finish).toHaveBeenCalledWith(expect.anything(), 'unknown');
    expect(m.defer).not.toHaveBeenCalled();
  });
  it('suppresses events whose source was disabled by the operator', async () => {
    vi.stubEnv('ASTRA_RADAR_ENABLED', 'false');
    const i = followed();
    i.input.source = 'football';
    m.raw.mockResolvedValue([i]);
    await dispatchRadar(now);
    expect(m.send).not.toHaveBeenCalled();
  });
});
