import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CustomerChallenge,
  CustomerAuthRepository,
} from '../db/repositories/customer-auth.js';
import type { CustomerAccount } from '../db/repositories/customer-accounts.js';

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('@ownpilot/core/channels', () => ({ getChannelService: vi.fn() }));
vi.mock('../db/repositories/customer-accounts.js', () => ({ customerAccountsRepo: {} }));
vi.mock('../db/repositories/customer-auth.js', () => ({ customerAuthRepo: {} }));
vi.mock('./customer-identity.js', () => ({ getCustomerIdentityService: () => ({}) }));
vi.mock('./log.js', () => ({ getLog: () => ({ warn: logWarn }) }));
import { CustomerAuthService, customerSessionHash, CUSTOMER_OTP_MESSAGE } from './customer-auth.js';

const now = new Date('2026-11-10T12:00:00Z');
const phone = '5567999998888';
describe('CustomerAuthService', () => {
  const auth = {
    reserveChallenge: vi.fn(),
    consumeChallenge: vi.fn(),
    createSession: vi.fn(),
    findSession: vi.fn(),
    touchSession: vi.fn(),
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOthers: vi.fn(),
    isSessionActive: vi.fn(),
    claimDeliveries: vi.fn(),
    beginDelivery: vi.fn(),
    finishDelivery: vi.fn(),
    deferDelivery: vi.fn(),
  };
  const accounts = {
    getById: vi.fn(),
    isPhoneAvailable: vi.fn(),
    changePhone: vi.fn(),
    updateProfile: vi.fn(),
  };
  const identity = { resolvePhone: vi.fn(), getContext: vi.fn(), isOwnerPhone: vi.fn() };
  const api = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendMessage: vi.fn(),
    getStatus: vi.fn(),
    getPlatform: vi.fn(),
    getBotInfo: vi.fn(),
  };
  const channels = { listChannels: vi.fn(), getChannel: vi.fn() };
  let service: CustomerAuthService;
  let account: CustomerAccount;
  let status: 'active' | 'expired';
  let challenges: Map<string, CustomerChallenge>;
  let generatedCode: string;
  const context = () => ({
    account,
    customer: {
      accountId: account.id,
      dataUserId: account.dataUserId,
      phoneNumber: account.phoneNumber,
      displayName: account.displayName,
      timeZone: account.timeZone,
      currency: 'BRL' as const,
      theme: account.theme,
      hideAmounts: account.hideAmounts,
      access: { status, canWrite: status === 'active', expiresAt: null },
    },
  });
  beforeEach(() => {
    vi.resetAllMocks();
    account = {
      id: 'account-1',
      channelUserId: 'cu-1',
      dataUserId: `whatsapp:${phone}`,
      phoneNumber: phone,
      displayName: 'Ana',
      timeZone: 'America/Campo_Grande',
      currency: 'BRL',
      theme: 'system',
      hideAmounts: false,
      authVersion: 1,
    };
    status = 'active';
    generatedCode = '123456';
    challenges = new Map();
    auth.reserveChallenge.mockImplementation(async (input) => {
      challenges.set(input.id, {
        ...input,
        attempts: 0,
        consumedAt: null,
        invalidatedAt: null,
        leaseToken: null,
      });
      return { accepted: true, retryAfter: 60 };
    });
    auth.consumeChallenge.mockImplementation(async (input) => {
      const found = challenges.get(input.id);
      if (
        !found ||
        found.consumedAt ||
        found.purpose !== input.purpose ||
        found.codeHash !== input.codeHash ||
        (input.accountId && found.accountId !== input.accountId) ||
        (input.sessionId && found.boundSessionId !== input.sessionId)
      )
        return null;
      found.consumedAt = now;
      return found;
    });
    auth.createSession.mockResolvedValue(true);
    auth.touchSession.mockResolvedValue(undefined);
    auth.isSessionActive.mockResolvedValue(true);
    auth.claimDeliveries.mockImplementation(async () =>
      [...challenges.values()]
        .filter((challenge) => !challenge.consumedAt)
        .map((challenge) => ({ ...challenge, leaseToken: 'delivery-lease' }))
    );
    auth.beginDelivery.mockResolvedValue(true);
    auth.finishDelivery.mockResolvedValue(undefined);
    auth.deferDelivery.mockResolvedValue(undefined);
    identity.resolvePhone.mockImplementation(async () => ({
      accountId: account.id,
      dataUserId: account.dataUserId,
      phoneNumber: account.phoneNumber,
      isCurrent: true,
      retired: false,
    }));
    identity.getContext.mockImplementation(async () => context());
    identity.isOwnerPhone.mockResolvedValue(false);
    accounts.isPhoneAvailable.mockResolvedValue(true);
    accounts.updateProfile.mockImplementation(async (_id, patch) => Object.assign(account, patch));
    accounts.changePhone.mockImplementation(async (input) => {
      account = { ...account, phoneNumber: input.newPhone, authVersion: account.authVersion + 1 };
      return account;
    });
    api.getStatus.mockReturnValue('connected');
    api.getPlatform.mockReturnValue('whatsapp');
    api.getBotInfo.mockReturnValue({ username: '5567999991111' });
    api.sendMessage.mockResolvedValue('mock-delivery-id');
    channels.listChannels.mockReturnValue([
      {
        pluginId: 'channel.whatsapp',
        platform: 'whatsapp',
        status: 'connected',
        name: 'Synthetic',
      },
    ]);
    channels.getChannel.mockReturnValue(api);
    service = new CustomerAuthService({
      accounts,
      auth: auth as unknown as CustomerAuthRepository,
      identity,
      channels: () => channels,
      secret: () => 'synthetic-test-secret-'.repeat(4),
      now: () => now,
      code: () => generatedCode,
    });
  });

  it('returns the same generic envelope for known and unknown phones without synchronous delivery', async () => {
    const known = await service.requestCode('(67) 99999-8888', 'test-ip');
    const stored = challenges.get(known.challengeId)!;
    expect(known).toMatchObject({ expiresIn: 300, retryAfter: 60, message: CUSTOMER_OTP_MESSAGE });
    expect(stored.phoneNumber).toBe(phone);
    expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.codeCiphertext).not.toContain('123456');
    expect(stored.ipHash).not.toContain('test-ip');
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(300_000);
    identity.resolvePhone.mockResolvedValue(null);
    const unknown = await service.requestCode('(11) 99999-7777', 'test-ip');
    expect({ ...unknown, challengeId: known.challengeId }).toEqual(known);
    expect(challenges.get(unknown.challengeId)?.accountId).toBeNull();
    expect(challenges.get(unknown.challengeId)?.codeCiphertext).toBeNull();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('does not reattach a retired alias to its historical data', async () => {
    identity.resolvePhone.mockResolvedValue({
      isCurrent: false,
      retired: true,
      accountId: 'old-account',
    });
    const result = await service.requestCode(phone, 'ip');
    expect(challenges.get(result.challengeId)?.accountId).toBeNull();
    expect(identity.getContext).not.toHaveBeenCalled();
  });
  it('returns a generic throttling error without issuing or sending another code', async () => {
    auth.reserveChallenge.mockResolvedValue({ accepted: false, retryAfter: 900 });
    await expect(service.requestCode(phone, 'ip')).rejects.toMatchObject({
      status: 429,
      retryAfter: 900,
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('issues one dedicated session only after a valid one-use code, never returning the token through customer data', async () => {
    const challenge = await service.requestCode(phone, 'ip');
    await expect(
      service.verifyCode(challenge.challengeId, '999999', 'Chrome/1')
    ).rejects.toMatchObject({ status: 401 });
    const result = await service.verifyCode(challenge.challengeId, '123456', 'Chrome/1 Windows');
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.customer).toEqual(context().customer);
    const session = auth.createSession.mock.calls[0]![3];
    expect(session.tokenHash).toBe(customerSessionHash(result.token));
    expect(session.label).toBe('Chrome · Windows');
    expect(session.tokenHash).not.toBe(result.token);
    await expect(service.verifyCode(challenge.challengeId, '123456', '')).rejects.toMatchObject({
      status: 401,
    });
    expect(auth.createSession).toHaveBeenCalledOnce();
  });
  it.each(['revoked', 'changed phone', 'changed version'])(
    'rejects a valid challenge after %s',
    async (change) => {
      const challenge = await service.requestCode(phone, 'ip');
      if (change === 'revoked') identity.getContext.mockResolvedValue(null);
      if (change === 'changed phone') account.phoneNumber = '5511999997777';
      if (change === 'changed version') account.authVersion++;
      await expect(service.verifyCode(challenge.challengeId, '123456', '')).rejects.toMatchObject({
        status: 401,
      });
      expect(auth.createSession).not.toHaveBeenCalled();
    }
  );
  it('permits expired read access and preferences while refusing a phone transfer', async () => {
    status = 'expired';
    const challenge = await service.requestCode(phone, 'ip');
    expect(
      (await service.verifyCode(challenge.challengeId, '123456', '')).customer.access.canWrite
    ).toBe(false);
    expect(
      (await service.updateProfile(account.id, { theme: 'dark', hideAmounts: true })).theme
    ).toBe('dark');
    await expect(
      service.requestPhoneChange(account.id, 'session-1', '(11) 99999-7777', 'ip')
    ).rejects.toMatchObject({ status: 403 });
  });
  it('rechecks account permission and session version on every browser request without owner fallback', async () => {
    const token = 'a'.repeat(43);
    auth.findSession.mockResolvedValue({
      id: 'session-1',
      accountId: account.id,
      accountVersion: 1,
    });
    expect((await service.authenticate(token))?.customer.dataUserId).toBe(account.dataUserId);
    identity.getContext.mockResolvedValue(null);
    expect(await service.authenticate(token)).toBeNull();
    expect(await service.authenticate('owner-admin-token')).toBeNull();
    expect(auth.findSession).toHaveBeenCalledTimes(2);
  });
  it('requires possession of the old phone before issuing the new-phone code and rotates sessions on completion', async () => {
    const old = await service.requestPhoneChange(account.id, 'session-1', '(11) 99999-7777', 'ip');
    expect(challenges.get(old.challengeId)).toMatchObject({
      purpose: 'phone_change_old',
      phoneNumber: phone,
      targetPhone: '5511999997777',
    });
    await expect(
      service.confirmNewPhone(account.id, 'session-1', old.challengeId, '123456', '')
    ).rejects.toMatchObject({ status: 401 });
    const next = await service.confirmOldPhone(
      account.id,
      'session-1',
      old.challengeId,
      '123456',
      'ip'
    );
    expect(challenges.get(next.challengeId)).toMatchObject({
      purpose: 'phone_change_new',
      phoneNumber: '5511999997777',
      oldProofId: old.challengeId,
    });
    const result = await service.confirmNewPhone(
      account.id,
      'session-1',
      next.challengeId,
      '123456',
      'Safari/1 iPhone'
    );
    expect(result.customer.phoneNumber).toBe('5511999997777');
    expect(result.customer.dataUserId).toBe(`whatsapp:${phone}`);
    expect(accounts.changePhone).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: account.id,
        expectedPhone: phone,
        expectedVersion: 1,
        newPhone: '5511999997777',
        whatsAppPluginIds: ['channel.whatsapp'],
        session: expect.objectContaining({ tokenHash: customerSessionHash(result.token) }),
      })
    );
  });
  it.each(['unavailable', 'owner', 'revoked session'])(
    'refuses a phone-change request for %s',
    async (reason) => {
      if (reason === 'unavailable') accounts.isPhoneAvailable.mockResolvedValue(false);
      if (reason === 'owner') identity.isOwnerPhone.mockResolvedValue(true);
      if (reason === 'revoked session') auth.isSessionActive.mockResolvedValue(false);
      await expect(
        service.requestPhoneChange(account.id, 'session-1', '(11) 99999-7777', 'ip')
      ).rejects.toBeInstanceOf(Error);
      expect(auth.reserveChallenge).not.toHaveBeenCalled();
    }
  );
  it('delivers the queued encrypted OTP only after durable reservation and a fresh authorization check', async () => {
    const challenge = await service.requestCode(phone, 'ip');
    await service.dispatchOtps();
    expect(auth.beginDelivery).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenNthCalledWith(1, {
      platformChatId: phone,
      text: expect.stringContaining('*123456*'),
      sendBefore: challenges.get(challenge.challengeId)!.expiresAt,
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, {
      platformChatId: phone,
      text: expect.stringContaining('*123456*'),
      copyCode: { label: 'Copiar código', code: '123456' },
      sendBefore: challenges.get(challenge.challengeId)!.expiresAt,
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(auth.finishDelivery).toHaveBeenCalledWith(expect.any(String), 'delivery-lease', 'sent');
  });
  it('keeps a leading-zero OTP intact in encrypted storage and native copy action', async () => {
    generatedCode = '000123';
    const challenge = await service.requestCode(phone, 'ip');
    expect(JSON.stringify(challenge)).not.toContain(generatedCode);
    expect(challenges.get(challenge.challengeId)?.codeCiphertext).not.toContain(generatedCode);
    await service.dispatchOtps();
    expect(api.sendMessage).toHaveBeenNthCalledWith(1, {
      platformChatId: phone,
      text: expect.stringContaining('\n\n*000123*\n\n'),
      sendBefore: new Date(now.getTime() + 300_000),
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, {
      platformChatId: phone,
      text: expect.stringContaining('*000123*'),
      copyCode: { label: 'Copiar código', code: '000123' },
      sendBefore: new Date(now.getTime() + 300_000),
    });
    expect(logWarn).not.toHaveBeenCalled();
  });
  it('uses the matching instructions and recipient for both phone-change verifications', async () => {
    const old = await service.requestPhoneChange(account.id, 'session-1', '(11) 99999-7777', 'ip');
    await service.dispatchOtps();
    expect(api.sendMessage).toHaveBeenNthCalledWith(1, {
      platformChatId: phone,
      text: expect.stringContaining('solicitação para alterar o número de WhatsApp'),
      sendBefore: challenges.get(old.challengeId)!.expiresAt,
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, {
      platformChatId: phone,
      text: expect.stringContaining('*123456*'),
      copyCode: { label: 'Copiar código', code: '123456' },
      sendBefore: challenges.get(old.challengeId)!.expiresAt,
    });
    const next = await service.confirmOldPhone(
      account.id,
      'session-1',
      old.challengeId,
      '123456',
      'ip'
    );
    await service.dispatchOtps();
    expect(api.sendMessage).toHaveBeenNthCalledWith(3, {
      platformChatId: '5511999997777',
      text: expect.stringContaining('solicitação para confirmar seu novo número de WhatsApp'),
      sendBefore: challenges.get(next.challengeId)!.expiresAt,
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(4, {
      platformChatId: '5511999997777',
      text: expect.stringContaining('*123456*'),
      copyCode: { label: 'Copiar código', code: '123456' },
      sendBefore: challenges.get(next.challengeId)!.expiresAt,
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(4);
  });
  it.each(['revoked', 'no identity', 'offline'])('does not send an OTP when %s', async (reason) => {
    await service.requestCode(phone, 'ip');
    if (reason === 'revoked') identity.getContext.mockResolvedValue(null);
    if (reason === 'no identity') api.getBotInfo.mockReturnValue(null);
    if (reason === 'offline') api.getStatus.mockReturnValue('disconnected');
    await service.dispatchOtps();
    expect(api.sendMessage).not.toHaveBeenCalled();
    if (reason !== 'revoked') expect(auth.claimDeliveries).not.toHaveBeenCalled();
  });
  it.each(['transport', 'receipt'])(
    'never retries or exposes the OTP after an ambiguous %s failure',
    async (stage) => {
      await service.requestCode(phone, 'ip');
      const error = new Error('Uncertain delivery of sensitive code 123456');
      if (stage === 'transport') api.sendMessage.mockRejectedValueOnce(error);
      else auth.finishDelivery.mockRejectedValueOnce(error);
      await service.dispatchOtps();
      expect(api.sendMessage).toHaveBeenCalledOnce();
      expect(auth.finishDelivery).toHaveBeenCalledWith(
        expect.any(String),
        'delivery-lease',
        'failed'
      );
      expect(auth.deferDelivery).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledExactlyOnceWith('Customer code delivery was not confirmed', {
        transportInvoked: true,
      });
    }
  );
  it('keeps a valid text OTP when its optional copy button fails', async () => {
    await service.requestCode(phone, 'ip');
    api.sendMessage
      .mockResolvedValueOnce('text-transport-id')
      .mockRejectedValueOnce(new Error('native-flow unavailable'));
    await service.dispatchOtps();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(auth.finishDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      'delivery-lease',
      'sent'
    );
    expect(logWarn).toHaveBeenCalledExactlyOnceWith(
      'Optional customer code copy button unavailable'
    );
  });

  it('does not send a copy button if the initial text transport was not acknowledged', async () => {
    await service.requestCode(phone, 'ip');
    api.sendMessage.mockResolvedValueOnce('');
    await service.dispatchOtps();
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(auth.finishDelivery).toHaveBeenCalledWith(expect.any(String), 'delivery-lease', 'failed');
    expect(auth.deferDelivery).not.toHaveBeenCalled();
  });

  it('does not send a copy button after access is revoked between the two transports', async () => {
    await service.requestCode(phone, 'ip');
    api.sendMessage.mockImplementationOnce(async () => {
      identity.getContext.mockResolvedValue(null);
      return 'text-transport-id';
    });
    await service.dispatchOtps();
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(auth.finishDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      'delivery-lease',
      'sent'
    );
  });
  it('does not dispatch a second copy while the first OTP is still sending', async () => {
    await service.requestCode(phone, 'ip');
    let completeSend!: (messageId: string) => void;
    api.sendMessage.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        completeSend = resolve;
      })
    );
    const firstDispatch = service.dispatchOtps();
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    await service.dispatchOtps();
    expect(auth.claimDeliveries).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledOnce();
    completeSend('mock-delivery-id');
    await firstDispatch;
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(auth.finishDelivery).toHaveBeenCalledWith(expect.any(String), 'delivery-lease', 'sent');
  });
  it('cancels delivery when permission changes after beginDelivery', async () => {
    await service.requestCode(phone, 'ip');
    auth.beginDelivery.mockImplementation(async () => {
      identity.getContext.mockResolvedValue(null);
      return true;
    });
    await service.dispatchOtps();
    expect(auth.finishDelivery).toHaveBeenCalledWith(
      expect.any(String),
      'delivery-lease',
      'cancelled'
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
