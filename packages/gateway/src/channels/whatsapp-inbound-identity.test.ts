import { describe, it, expect, vi } from 'vitest';
import type { ChannelIncomingMessage, ChannelPluginAPI } from '@ownpilot/core/channels';
import type { ChannelUserEntity } from '../db/repositories/channels/users.js';
import {
  inboundChannelAssetScope,
  resolveInboundWhatsAppSpelling,
} from './whatsapp-inbound-identity.js';
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
    channelPluginId: 'channel.whatsapp',
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
  it('keeps the existing grant and durable chat in one canonical scope', async () => {
    const { message, d } = fixture();
    const result = await resolveInboundWhatsAppSpelling(message, d);
    expect(result.sender.platformUserId).toBe(full);
    expect(result.platformChatId).toBe(full);
    expect(result.id).toBe(message.id);
  });
  it('preserves the verified original asset scope through local metadata clones', async () => {
    const { message, d } = fixture();
    const resolved = await resolveInboundWhatsAppSpelling(message, d);
    const cloned = { ...resolved, metadata: { ...resolved.metadata, astraRecentReceipts: [] } };
    expect(inboundChannelAssetScope(cloned)).toEqual({
      id: message.id,
      channelPluginId: message.channelPluginId,
      platform: message.platform,
      platformChatId: short,
    });
    expect(inboundChannelAssetScope(JSON.parse(JSON.stringify(cloned)))).toEqual({
      id: message.id,
      channelPluginId: message.channelPluginId,
      platform: message.platform,
      platformChatId: full,
    });
  });
  it('does not accept an original scope claimed through metadata', () => {
    const { message } = fixture();
    message.metadata = {
      originalPlatformChatId: 'another-customer',
      verifiedAssetScope: { platformChatId: 'another-customer' },
    };
    expect(inboundChannelAssetScope(message).platformChatId).toBe(short);
  });
  it.each(['id', 'channelPluginId', 'platformChatId'] as const)(
    'does not reuse verified provenance after the canonical %s changes',
    async (field) => {
      const { message, d } = fixture();
      const resolved = await resolveInboundWhatsAppSpelling(message, d);
      const changed = { ...resolved, [field]: 'another-scope' };
      expect(inboundChannelAssetScope(changed)[field]).toBe('another-scope');
      expect(inboundChannelAssetScope(changed).platformChatId).not.toBe(short);
    }
  );
  it('does not reuse verified asset provenance after the sender changes', async () => {
    const { message, d } = fixture();
    const resolved = await resolveInboundWhatsAppSpelling(message, d);
    expect(
      inboundChannelAssetScope({
        ...resolved,
        sender: { ...resolved.sender, platformUserId: 'another-sender' },
      }).platformChatId
    ).toBe(full);
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
