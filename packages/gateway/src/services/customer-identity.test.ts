import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@ownpilot/core/channels', () => ({ getChannelService: vi.fn() }));
vi.mock('../db/repositories/customer-accounts.js', () => ({ customerAccountsRepo: {} }));
vi.mock('../db/repositories/channels/users.js', () => ({ channelUsersRepo: {} }));
vi.mock('./pairing-service.js', () => ({ getOwnerUserId: vi.fn() }));

import { CustomerIdentityService } from './customer-identity.js';

const now = new Date('2026-11-10T12:00:00Z');
const phone = '5567999998888';
const account = {
  id: 'account-1',
  channelUserId: 'cu-1',
  dataUserId: 'whatsapp:5511999997777',
  phoneNumber: phone,
  displayName: 'Ana',
  timeZone: 'America/Campo_Grande',
  currency: 'BRL' as const,
  theme: 'system' as const,
  hideAmounts: false,
  authVersion: 1,
};
const resolution = {
  accountId: account.id,
  dataUserId: account.dataUserId,
  phoneNumber: phone,
  isCurrent: true,
  retired: false,
};

describe('CustomerIdentityService', () => {
  const accounts = { resolvePhone: vi.fn(), getById: vi.fn(), provision: vi.fn() };
  const users = { findByPlatform: vi.fn(), getById: vi.fn() };
  const owner = vi.fn();
  const connectedPhones = vi.fn();
  let service: CustomerIdentityService;
  let user: Record<string, unknown>;
  beforeEach(() => {
    vi.resetAllMocks();
    user = {
      id: 'cu-1',
      platform: 'whatsapp',
      platformUserId: phone,
      ownpilotUserId: `whatsapp:${phone}`,
      isVerified: true,
      isBlocked: false,
      status: 'active',
      accessSource: 'manual',
      accessExpiresAt: null,
    };
    accounts.getById.mockResolvedValue(account);
    accounts.resolvePhone.mockResolvedValue(resolution);
    accounts.provision.mockResolvedValue(account);
    users.getById.mockImplementation(async () => user);
    users.findByPlatform.mockImplementation(async () => user);
    owner.mockResolvedValue('5567999991111');
    connectedPhones.mockReturnValue(['5567999991111']);
    service = new CustomerIdentityService({
      accounts,
      users,
      owner,
      connectedPhones,
      now: () => now,
    });
  });

  it('keeps data ownership immutable after a phone change and exposes current contact separately', async () => {
    const result = await service.getContext(account.id);
    expect(result?.customer).toMatchObject({
      dataUserId: 'whatsapp:5511999997777',
      phoneNumber: phone,
      access: { status: 'active', canWrite: true, expiresAt: null },
    });
  });
  it('allows an approved expired account to read while disabling writes', async () => {
    user.accessExpiresAt = new Date(now.getTime() - 1);
    expect((await service.getContext(account.id))?.customer.access).toEqual({
      status: 'expired',
      canWrite: false,
      expiresAt: '2026-11-10T11:59:59.999Z',
    });
  });
  it.each([
    { isBlocked: true },
    { isVerified: false },
    { status: 'pending' },
    { ownpilotUserId: 'default' },
    { ownpilotUserId: 'whatsapp:another' },
    { platformUserId: '5511999997777' },
    { platform: 'telegram' },
    { accessExpiresAt: new Date('invalid') },
  ])('denies invalid or inactive identity: %j', async (patch) => {
    Object.assign(user, patch);
    expect(await service.getContext(account.id)).toBeNull();
  });
  it.each(['owner', 'connected'])(
    'excludes the %s phone even if it once had a customer record',
    async (source) => {
      if (source === 'owner') owner.mockResolvedValue(phone);
      else connectedPhones.mockReturnValue([phone]);
      expect(await service.getContext(account.id)).toBeNull();
    }
  );
  it('never reprovisions a retired alias even after administrative reauthorization of that phone', async () => {
    accounts.resolvePhone.mockResolvedValue({ ...resolution, isCurrent: false, retired: true });
    expect(await service.resolvePhone('5511999997777', { provision: true })).toMatchObject({
      retired: true,
    });
    expect(accounts.provision).not.toHaveBeenCalled();
    expect(users.findByPlatform).not.toHaveBeenCalled();
  });
  it('does not create an account during a read-only lookup', async () => {
    accounts.resolvePhone.mockResolvedValue(null);
    expect(await service.resolvePhone(phone)).toBeNull();
    expect(accounts.provision).not.toHaveBeenCalled();
  });
  it('provisions only verified canonical customers, including approved expired records', async () => {
    accounts.resolvePhone.mockResolvedValue(null);
    user.accessExpiresAt = new Date(now.getTime() - 1);
    expect(await service.resolvePhone(phone, { provision: true })).toEqual(resolution);
    expect(accounts.provision).toHaveBeenCalledWith('cu-1', phone);
    accounts.provision.mockClear();
    user.isVerified = false;
    expect(await service.resolvePhone(phone, { provision: true })).toBeNull();
    expect(accounts.provision).not.toHaveBeenCalled();
  });
  it('preserves international channel phone identities instead of inferring Brazilian DDD', async () => {
    accounts.resolvePhone.mockResolvedValue(null);
    await service.resolvePhone('37253049737');
    expect(accounts.resolvePhone).toHaveBeenCalledWith('37253049737');
  });
  it('requires an active alias for the current phone', async () => {
    accounts.resolvePhone.mockResolvedValue({ ...resolution, isCurrent: false, retired: true });
    expect(await service.getContext(account.id)).toBeNull();
  });
});
