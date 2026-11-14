import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  claim: vi.fn(),
  current: vi.fn(),
  finish: vi.fn(),
  save: vi.fn(),
  binding: vi.fn(),
  user: vi.fn(),
  phone: vi.fn(),
  build: vi.fn(),
  send: vi.fn(),
  platform: 'whatsapp',
  connected: true,
}));
vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => ({
    getChannel: () => ({
      getPlatform: () => m.platform,
      getStatus: () => (m.connected ? 'connected' : 'disconnected'),
    }),
    send: m.send,
  }),
}));
vi.mock('../db/repositories/email-digests.js', () => ({
  emailDigestsRepo: { claimDue: m.claim, isCurrent: m.current, finish: m.finish, save: m.save },
}));
vi.mock('../db/repositories/channels/users.js', () => ({
  channelUsersRepo: { findByPlatform: m.user },
}));
vi.mock('./customer-integrations.js', () => ({
  customerIntegrationService: { binding: m.binding },
}));
vi.mock('./customer-identity.js', () => ({ resolveCustomerPhone: m.phone }));
vi.mock('../channels/channel-access-service.js', () => ({
  isChannelUserAccessActive: (user: { active?: boolean } | undefined) => user?.active === true,
}));
vi.mock('./email-digest.js', () => ({ buildEmailDigest: m.build }));
import { dispatchDueEmailDigests } from './email-digest-worker.js';
const entry = {
  id: 'digest-a',
  userId: 'customer-a',
  platform: 'whatsapp',
  channelPluginId: 'channel-a',
  platformChatId: '5511999999999',
  connectionId: 'owned-a',
  timeZone: 'America/Cuiaba',
  hour: 8,
  minute: 0,
  version: 1,
  claimToken: 'claim-a',
  active: true,
  nextRunAt: new Date(),
};
beforeEach(() => {
  vi.clearAllMocks();
  m.platform = 'whatsapp';
  m.connected = true;
  m.claim.mockResolvedValue([entry]);
  m.current.mockResolvedValue(true);
  m.finish.mockResolvedValue(undefined);
  m.binding.mockResolvedValue({
    account: { id: 'account-a', phoneNumber: '5511999999999', timeZone: 'America/Cuiaba' },
  });
  m.user.mockResolvedValue({ ownpilotUserId: 'customer-a', active: true });
  m.phone.mockResolvedValue({ accountId: 'account-a', retired: false });
  m.build.mockResolvedValue('Resumo fictício');
  m.send.mockResolvedValue('delivery-a');
});
describe('durable private email delivery', () => {
  it.each(['whatsapp', 'telegram'])(
    'delivers only to the still-linked active %s customer',
    async (platform) => {
      m.platform = platform;
      m.claim.mockResolvedValue([
        {
          ...entry,
          platform,
          platformChatId: platform === 'telegram' ? '1234567' : entry.platformChatId,
        },
      ]);
      expect(await dispatchDueEmailDigests()).toEqual({ claimed: 1, delivered: 1 });
      expect(m.binding).toHaveBeenCalledWith('customer-a', 'gmail', 'owned-a');
      expect(m.send).toHaveBeenCalledWith('channel-a', {
        platformChatId: platform === 'telegram' ? '1234567' : '5511999999999',
        text: 'Resumo fictício',
      });
    }
  );
  it('does not deliver if cancelled while the summary is being generated', async () => {
    m.current.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await dispatchDueEmailDigests()).delivered).toBe(0);
    expect(m.send).not.toHaveBeenCalled();
  });
  it.each(['offline', 'revoked', 'relinked', 'inactive', 'group'])(
    'does not read or disclose mail for an invalid recipient: %s',
    async (reason) => {
      if (reason === 'offline') m.connected = false;
      if (reason === 'revoked') m.binding.mockRejectedValue(new Error('revoked'));
      if (reason === 'relinked')
        m.user.mockResolvedValue({ ownpilotUserId: 'customer-b', active: true });
      if (reason === 'inactive')
        m.user.mockResolvedValue({ ownpilotUserId: 'customer-a', active: false });
      if (reason === 'group') m.claim.mockResolvedValue([{ ...entry, platformChatId: '123@g.us' }]);
      expect((await dispatchDueEmailDigests()).delivered).toBe(0);
      expect(m.build).not.toHaveBeenCalled();
      expect(m.send).not.toHaveBeenCalled();
    }
  );
  it('rechecks revocation after reading before sending', async () => {
    m.binding
      .mockResolvedValueOnce({
        account: { id: 'account-a', phoneNumber: '5511999999999', timeZone: 'America/Cuiaba' },
      })
      .mockRejectedValueOnce(new Error('revoked'));
    expect((await dispatchDueEmailDigests()).delivered).toBe(0);
    expect(m.send).not.toHaveBeenCalled();
  });
  it('does not send at the old timezone after the customer changes it', async () => {
    m.binding.mockResolvedValue({
      account: { id: 'account-a', phoneNumber: '5511999999999', timeZone: 'America/Sao_Paulo' },
    });
    await dispatchDueEmailDigests();
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ timeZone: 'America/Sao_Paulo' }));
    expect(m.build).not.toHaveBeenCalled();
  });
  it.each([null, 'throw'])(
    'records an uncertain send without automatically sending again: %s',
    async (receipt) => {
      if (receipt === 'throw') m.send.mockRejectedValue(new Error('timeout after acceptance'));
      else m.send.mockResolvedValue(receipt);
      expect((await dispatchDueEmailDigests()).delivered).toBe(0);
      expect(m.send).toHaveBeenCalledTimes(1);
      expect(m.finish).toHaveBeenCalledWith(entry, null, 'digest_not_confirmed');
    }
  );
});
