import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canDownloadTelegramMedia } from './media-access.js';
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  owner: vi.fn(),
  account: vi.fn(),
  context: vi.fn(),
}));
vi.mock('../../../db/repositories/channels/users.js', () => ({
  channelUsersRepo: { findByPlatform: mocks.user },
}));
vi.mock('../../../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mocks.account },
}));
vi.mock('../../../services/customer-identity.js', () => ({
  getCustomerIdentityService: () => ({ getContext: mocks.context }),
}));
vi.mock('../../../services/pairing-service.js', () => ({ getOwnerUserId: mocks.owner }));

describe('Telegram upload admission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.user.mockResolvedValue({
      isVerified: true,
      isBlocked: false,
      status: 'active',
      ownpilotUserId: 'whatsapp:synthetic-a',
    });
    mocks.owner.mockResolvedValue('operator');
    mocks.account.mockResolvedValue({ id: 'account-a' });
    mocks.context.mockResolvedValue({
      account: { dataUserId: 'whatsapp:synthetic-a' },
      customer: { access: { canWrite: true } },
    });
  });
  it('accepts a linked customer with a currently active subscription', async () => {
    expect(await canDownloadTelegramMedia('101')).toBe(true);
  });
  it('preserves upload access for the verified Telegram operator', async () => {
    mocks.owner.mockResolvedValue('101');
    mocks.context.mockResolvedValue(null);
    expect(await canDownloadTelegramMedia('101')).toBe(true);
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { isVerified: false },
    { isVerified: true, isBlocked: true },
    { isVerified: true, isBlocked: false, status: 'pending' },
  ])('rejects an unverified or blocked sender: %j', async (user) => {
    mocks.user.mockResolvedValue(user);
    expect(await canDownloadTelegramMedia('101')).toBe(false);
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { account: { dataUserId: 'whatsapp:synthetic-b' }, customer: { access: { canWrite: true } } },
    { account: { dataUserId: 'whatsapp:synthetic-a' }, customer: { access: { canWrite: false } } },
  ])('rejects a stale, different or expired customer identity: %j', async (context) => {
    mocks.context.mockResolvedValue(context);
    expect(await canDownloadTelegramMedia('101')).toBe(false);
  });
  it('fails closed during a database outage', async () => {
    mocks.user.mockRejectedValue(new Error('synthetic database outage'));
    expect(await canDownloadTelegramMedia('101')).toBe(false);
  });
});
