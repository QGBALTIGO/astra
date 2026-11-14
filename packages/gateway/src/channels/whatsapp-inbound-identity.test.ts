import { describe, it, expect, vi } from 'vitest';
import type { ChannelIncomingMessage, ChannelPluginAPI } from '@ownpilot/core/channels';
import type { ChannelUserEntity } from '../db/repositories/channels/users.js';
import { resolveInboundWhatsAppSpelling } from './whatsapp-inbound-identity.js';
const full = '5581999990101',
  short = '558199990101';
function fixture() {
  const user = {
    platform: 'whatsapp',
    platformUserId: full,
    ownpilotUserId: 'whatsapp:' + full,
    isVerified: true,
    status: 'active',
    isBlocked: false,
    accessSource: 'manual',
  } as ChannelUserEntity;
  const message = {
    platform: 'whatsapp',
    sender: { platform: 'whatsapp', platformUserId: short },
    platformChatId: short,
    text: 'Olá',
    id: 'identity-test',
    metadata: { fromMe: false, isGroup: false },
  } as ChannelIncomingMessage;
  const verify = vi.fn().mockResolvedValue(short);
  return {
    user,
    message,
    verify,
    d: {
      findUser: vi.fn(async (p: string) => (p === full ? user : null)),
      resolvePhone: vi.fn().mockResolvedValue(null),
      owner: vi.fn().mockResolvedValue('5511999990102'),
      api: {
        getStatus: () => 'connected',
        resolveWhatsAppRecipient: verify,
      } as unknown as ChannelPluginAPI,
    },
  };
}
describe('inbound WhatsApp ninth digit', () => {
  it('routes to the existing grant while preserving the actual reply address', async () => {
    const { message, d } = fixture();
    const result = await resolveInboundWhatsAppSpelling(message, d);
    expect(result.sender.platformUserId).toBe(full);
    expect(result.platformChatId).toBe(short);
    expect(result.id).toBe(message.id);
  });
  it.each([null, '5599999999999'])(
    'does not trust an ambiguous or unrelated provider result: %s',
    async (value) => {
      const { message, d, verify } = fixture();
      verify.mockResolvedValue(value);
      expect(await resolveInboundWhatsAppSpelling(message, d)).toBe(message);
    }
  );
  it.each([
    { isBlocked: true },
    { isVerified: true },
    { accessSource: 'manual' },
    { ownpilotUserId: 'default' },
  ])('preserves the exact existing restriction or identity: %j', async (changes) => {
    const { message, d, user, verify } = fixture();
    d.findUser.mockImplementation(async (p) =>
      p === short ? { ...user, ...changes, platformUserId: short } : user
    );
    expect(await resolveInboundWhatsAppSpelling(message, d)).toBe(message);
    expect(verify).not.toHaveBeenCalled();
  });
  it('never combines an established phone account with the other spelling', async () => {
    const { message, d, verify } = fixture();
    d.resolvePhone.mockResolvedValue({ accountId: 'existing', isCurrent: true, retired: false });
    expect(await resolveInboundWhatsAppSpelling(message, d)).toBe(message);
    expect(verify).not.toHaveBeenCalled();
  });
  it('keeps foreign numbers exact without a Brazilian lookup', async () => {
    const { message, d, verify } = fixture();
    message.sender.platformUserId = '244927000001';
    expect(await resolveInboundWhatsAppSpelling(message, d)).toBe(message);
    expect(verify).not.toHaveBeenCalled();
  });
});
