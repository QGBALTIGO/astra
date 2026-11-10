import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelUserEntity } from '../db/repositories/channels/users.js';

vi.mock('../db/repositories/channels/users.js', () => ({ channelUsersRepo: {} }));
vi.mock('../services/customer-identity.js', () => ({
  resolveCustomerPhone: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/pairing-service.js', () => ({ getOwnerUserId: vi.fn() }));

import {
  ChannelAccessError,
  ChannelAccessService,
  channelUserAccessStatus,
  isChannelUserAccessActive,
  normalizeWhatsAppAccessPhone,
} from './channel-access-service.js';

const NOW = new Date('2026-11-10T12:00:00Z');
const PHONE = '5511999991234';
function user(overrides: Partial<ChannelUserEntity> = {}): ChannelUserEntity {
  return {
    id: 'customer-1',
    ownpilotUserId: `whatsapp:${PHONE}`,
    platform: 'whatsapp',
    platformUserId: PHONE,
    isVerified: true,
    isBlocked: false,
    status: 'active',
    metadata: {},
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

describe('normalizeWhatsAppAccessPhone', () => {
  it.each([
    ['(11) 99999-1234', PHONE],
    ['55 11 99999-1234', PHONE],
    ['+55 (11) 99999-1234', PHONE],
    ['11 3333-1234', '551133331234'],
    ['(21) 8877-1234', '552188771234'],
    ['+1 (202) 555-0123', '12025550123'],
    ['+44 20 7946 0958', '442079460958'],
  ])('normalizes %s without altering subscriber digits', (input, expected) => {
    expect(normalizeWhatsAppAccessPhone(input)).toBe(expected);
  });

  it.each([
    '',
    '119999',
    '2025550123',
    '442079460958',
    '+0012025550123',
    '+123456789',
    '+1234567890123456',
    '5510999991234',
    '1112345678',
    '11899991234',
    '5511999991234@s.whatsapp.net',
    '1234567890123@lid',
    '+55 11 99999-1234 ramal 2',
    '55+11999991234',
    '++5511999991234',
    '<script>11999991234</script>',
  ])('rejects an ambiguous or invalid identity: %s', (input) => {
    expect(() => normalizeWhatsAppAccessPhone(input)).toThrow(ChannelAccessError);
  });
});

describe('channel access status', () => {
  it('preserves verified active legacy users with no access fields as unlimited', () => {
    expect(isChannelUserAccessActive(user(), NOW)).toBe(true);
    expect(channelUserAccessStatus(user({ accessExpiresAt: null, accessSource: null }), NOW)).toBe(
      'active'
    );
  });

  it.each([
    [{ isBlocked: true }, 'blocked'],
    [{ isVerified: false }, 'pending'],
    [{ status: 'pending' }, 'pending'],
    [{ status: 'unexpected' }, 'pending'],
    [{ status: undefined }, 'pending'],
    [{ isVerified: false, accessSource: 'manual' }, 'revoked'],
    [{ isVerified: false, accessSource: 'cakto' }, 'revoked'],
    [{ accessExpiresAt: new Date('2026-11-10T12:00:00Z') }, 'expired'],
    [{ accessExpiresAt: new Date('2026-11-09T12:00:00Z') }, 'expired'],
    [{ accessExpiresAt: new Date('invalid') }, 'expired'],
    [{ accessExpiresAt: new Date('2026-11-10T12:00:00.001Z') }, 'active'],
  ])('computes %j as %s', (overrides, expected) => {
    const record = user(overrides as Partial<ChannelUserEntity>);
    expect(channelUserAccessStatus(record, NOW)).toBe(expected);
    expect(isChannelUserAccessActive(record, NOW)).toBe(expected === 'active');
  });
});

describe('ChannelAccessService', () => {
  const repo = {
    findByPlatform: vi.fn(),
    getById: vi.fn(),
    grantWhatsAppAccess: vi.fn(),
    renewWhatsAppAccess: vi.fn(),
    revokeWhatsAppAccess: vi.fn(),
  };
  const ownerLookup = vi.fn();
  let service: ChannelAccessService;

  beforeEach(() => {
    vi.resetAllMocks();
    repo.findByPlatform.mockResolvedValue(null);
    repo.getById.mockResolvedValue(user());
    repo.grantWhatsAppAccess.mockResolvedValue(user());
    repo.renewWhatsAppAccess.mockResolvedValue(user());
    repo.revokeWhatsAppAccess.mockResolvedValue(
      user({ isVerified: false, accessSource: 'manual' })
    );
    ownerLookup.mockResolvedValue(null);
    service = new ChannelAccessService(repo, ownerLookup, () => NOW);
  });

  it('preauthorizes the canonical number for 30 days by default with a server clock', async () => {
    await service.grantWhatsAppAccess({ phoneNumber: '(11) 99999-1234', displayName: '  Ana  ' });
    expect(repo.findByPlatform).toHaveBeenCalledWith('whatsapp', PHONE);
    expect(repo.grantWhatsAppAccess).toHaveBeenCalledWith({
      phoneNumber: PHONE,
      displayName: 'Ana',
      grantedAt: NOW,
      expiresAt: new Date('2026-12-10T12:00:00Z'),
      source: 'manual',
    });
  });

  it('grants unlimited access only for explicit null and supports a trusted future source', async () => {
    await service.grantWhatsAppAccess({ phoneNumber: PHONE, durationDays: null }, 'cakto');
    expect(repo.grantWhatsAppAccess).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: null, source: 'cakto' })
    );
  });

  it('honors a finite selection when reauthorizing an unlimited grant that was revoked', async () => {
    repo.findByPlatform.mockResolvedValue(
      user({
        isVerified: false,
        accessExpiresAt: null,
        accessSource: 'manual',
      })
    );
    await service.grantWhatsAppAccess({ phoneNumber: PHONE, durationDays: 30 });
    expect(repo.grantWhatsAppAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: new Date('2026-12-10T12:00:00Z'),
        source: 'manual',
      })
    );
  });

  it.each([0, -1, 367, 1.5, Infinity, NaN, '30'])(
    'rejects invalid grant duration %s',
    async (durationDays) => {
      await expect(
        service.grantWhatsAppAccess({ phoneNumber: PHONE, durationDays: durationDays as number })
      ).rejects.toMatchObject({ status: 400 });
      expect(repo.grantWhatsAppAccess).not.toHaveBeenCalled();
    }
  );

  it('refuses an untrusted source and an invalid display name before writing', async () => {
    await expect(
      service.grantWhatsAppAccess({ phoneNumber: PHONE }, 'webhook' as 'manual')
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.grantWhatsAppAccess({ phoneNumber: PHONE, displayName: 'x'.repeat(121) })
    ).rejects.toMatchObject({ status: 400 });
    expect(repo.grantWhatsAppAccess).not.toHaveBeenCalled();
  });

  it.each(['default', 'whatsapp:another-person', 'another-owner'])(
    'never transfers existing %s records into a customer grant',
    async (ownpilotUserId) => {
      repo.findByPlatform.mockResolvedValue(user({ ownpilotUserId }));
      await expect(service.grantWhatsAppAccess({ phoneNumber: PHONE })).rejects.toMatchObject({
        status: 409,
      });
      expect(repo.grantWhatsAppAccess).not.toHaveBeenCalled();
    }
  );

  it('protects the claimed transport owner even when they retain a canonical guest scope', async () => {
    ownerLookup.mockResolvedValue(PHONE);
    await expect(service.grantWhatsAppAccess({ phoneNumber: PHONE })).rejects.toMatchObject({
      status: 409,
    });
    await expect(service.renewWhatsAppAccess('customer-1')).rejects.toMatchObject({ status: 409 });
    await expect(service.revokeWhatsAppAccess('customer-1')).rejects.toMatchObject({ status: 409 });
    expect(repo.grantWhatsAppAccess).not.toHaveBeenCalled();
    expect(repo.renewWhatsAppAccess).not.toHaveBeenCalled();
    expect(repo.revokeWhatsAppAccess).not.toHaveBeenCalled();
  });

  it('fails safely if a conflicting owner identity appears during the atomic insert', async () => {
    repo.grantWhatsAppAccess.mockResolvedValue(null);
    await expect(service.grantWhatsAppAccess({ phoneNumber: PHONE })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('requires an explicit unblock before granting an existing blocked number', async () => {
    repo.findByPlatform.mockResolvedValue(user({ isBlocked: true }));
    await expect(service.grantWhatsAppAccess({ phoneNumber: PHONE })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Desbloqueie'),
    });
    expect(repo.grantWhatsAppAccess).not.toHaveBeenCalled();
  });

  it('reports the required unblock when a block races the grant after its initial read', async () => {
    repo.findByPlatform
      .mockResolvedValueOnce(user({ isBlocked: false }))
      .mockResolvedValueOnce(user({ isBlocked: true }));
    repo.grantWhatsAppAccess.mockResolvedValue(null);
    await expect(service.grantWhatsAppAccess({ phoneNumber: PHONE })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Desbloqueie'),
    });
    expect(repo.grantWhatsAppAccess).toHaveBeenCalledOnce();
    expect(repo.findByPlatform).toHaveBeenCalledTimes(2);
  });

  it('delegates renewal to an atomic database extension with explicit source and default 30 days', async () => {
    const renewed = user({ accessExpiresAt: new Date('2027-01-01T12:00:00Z') });
    repo.renewWhatsAppAccess.mockResolvedValue(renewed);
    await expect(service.renewWhatsAppAccess('customer-1')).resolves.toEqual(renewed);
    expect(repo.renewWhatsAppAccess).toHaveBeenCalledWith('customer-1', 30, 'manual', NOW);
  });

  it('rejects null renewal duration instead of clearing expiry', async () => {
    await expect(
      service.renewWhatsAppAccess('customer-1', null as unknown as number)
    ).rejects.toMatchObject({ status: 400 });
    expect(repo.renewWhatsAppAccess).not.toHaveBeenCalled();
  });

  it('requires an explicit unblock before renewing a blocked number', async () => {
    repo.getById.mockResolvedValue(user({ isBlocked: true }));
    await expect(service.renewWhatsAppAccess('customer-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Desbloqueie'),
    });
    expect(repo.renewWhatsAppAccess).not.toHaveBeenCalled();
  });

  it('reports the required unblock when a block wins the renewal row lock', async () => {
    repo.getById.mockResolvedValueOnce(user()).mockResolvedValueOnce(user({ isBlocked: true }));
    repo.renewWhatsAppAccess.mockResolvedValue(null);
    await expect(service.renewWhatsAppAccess('customer-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Desbloqueie'),
    });
    expect(repo.renewWhatsAppAccess).toHaveBeenCalledOnce();
  });

  it('revokes existing access without deleting customer data', async () => {
    const result = await service.revokeWhatsAppAccess('customer-1');
    expect(result.isVerified).toBe(false);
    expect(repo.revokeWhatsAppAccess).toHaveBeenCalledWith('customer-1');
  });

  it('reports a missing user and propagates failed writes without claiming success', async () => {
    repo.getById.mockResolvedValue(null);
    await expect(service.renewWhatsAppAccess('missing')).rejects.toMatchObject({ status: 404 });
    await expect(service.revokeWhatsAppAccess('missing')).rejects.toMatchObject({ status: 404 });
    repo.grantWhatsAppAccess.mockRejectedValue(new Error('database offline'));
    await expect(service.grantWhatsAppAccess({ phoneNumber: PHONE })).rejects.toThrow(
      'database offline'
    );
  });
});
