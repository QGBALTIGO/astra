import { describe, expect, it, vi } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { ChannelIncomingMessage, ChannelPluginAPI } from '@ownpilot/core/channels';
import type { ChannelUserEntity } from '../../../db/repositories/channels/users.js';
import { resolveInboundWhatsAppSpelling } from '../../whatsapp-inbound-identity.js';
import { isDirectUserAudio, markDirectWhatsAppAudio } from './whatsapp-audio-provenance.js';

const short = '558199990101';
const full = '5581999990101';
function fixture(contextInfo?: Record<string, unknown>) {
  const message: ChannelIncomingMessage = {
    id: 'channel.whatsapp:direct-voice',
    channelPluginId: 'channel.whatsapp',
    platform: 'whatsapp',
    platformChatId: short,
    sender: { platform: 'whatsapp', platformUserId: short },
    text: '[Attachment]',
    timestamp: new Date(),
    attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: new Uint8Array([1, 2, 3]) }],
    metadata: { fromMe: false, isGroup: false },
  };
  const source = {
    key: { id: 'direct-voice', remoteJid: short + '@s.whatsapp.net', fromMe: false },
    message: { audioMessage: { mimetype: 'audio/ogg', contextInfo } },
  } as WAMessage;
  return { message, source };
}

describe('transport provenance for direct WhatsApp audio', () => {
  it('keeps a directly received audio proof across server-side message spreads', () => {
    const { message, source } = fixture({ isForwarded: false, forwardingScore: 0 });
    markDirectWhatsAppAudio(message, source);
    expect(isDirectUserAudio(message)).toBe(true);
    expect(isDirectUserAudio({ ...message, metadata: { ...message.metadata, extra: true } })).toBe(
      true
    );
  });
  it.each([
    { isForwarded: true },
    { forwardingScore: 1 },
    { forwardingScore: '0' },
    { forwardedFrom: 'another-message' },
    { forwardedNewsletterMessageInfo: {} },
    { forwardedAiBotMessageInfo: {} },
  ])('rejects forwarding information from the original audio context: %j', (context) => {
    const { message, source } = fixture(context);
    message.metadata = { ...message.metadata, isForwarded: false, directUserAudio: true };
    markDirectWhatsAppAudio(message, source);
    expect(isDirectUserAudio(message)).toBe(false);
  });
  it('checks wrappers while not treating a quoted message as the origin of new audio', () => {
    const { message, source } = fixture({
      quotedMessage: { audioMessage: { contextInfo: { isForwarded: true } } },
    });
    source.message = { ephemeralMessage: { message: source.message } };
    markDirectWhatsAppAudio(message, source);
    expect(isDirectUserAudio(message)).toBe(true);
    const wrapper = source.message.ephemeralMessage as unknown as Record<string, unknown>;
    wrapper.contextInfo = { forwardingScore: 2 };
    markDirectWhatsAppAudio(message, source);
    expect(isDirectUserAudio(message)).toBe(false);
  });
  it.each([true, undefined])('requires explicit incoming origin, not fromMe=%s', (fromMe) => {
    const { message, source } = fixture();
    source.key.fromMe = fromMe;
    markDirectWhatsAppAudio(message, source);
    expect(isDirectUserAudio(message)).toBe(false);
  });
  it('rejects a group, non-audio content or missing platform message id', () => {
    for (const change of [
      (source: WAMessage) => {
        source.key.remoteJid = 'group@g.us';
      },
      (source: WAMessage) => {
        source.message = { imageMessage: { mimetype: 'image/png' } };
      },
      (source: WAMessage) => {
        source.key.id = '';
      },
    ]) {
      const { message, source } = fixture();
      change(source);
      markDirectWhatsAppAudio(message, source);
      expect(isDirectUserAudio(message)).toBe(false);
    }
  });
  it('cannot mint proof through caller metadata or a JSON round-trip', () => {
    const { message, source } = fixture();
    message.metadata = {
      ...message.metadata,
      directUserAudio: true,
      isDirectUserAudio: true,
      verifiedDirectAudio: { id: message.id, plugin: message.channelPluginId, chat: short },
    };
    expect(isDirectUserAudio(message)).toBe(false);
    markDirectWhatsAppAudio(message, source);
    expect(isDirectUserAudio(JSON.parse(JSON.stringify(message)))).toBe(false);
  });
  it.each(['id', 'channelPluginId', 'platformChatId'] as const)(
    'rejects reuse after its %s scope changes',
    (field) => {
      const { message, source } = fixture();
      markDirectWhatsAppAudio(message, source);
      expect(isDirectUserAudio({ ...message, [field]: 'foreign-scope' })).toBe(false);
    }
  );
  it('binds proof to the sender and to the actual inline audio', () => {
    const { message, source } = fixture();
    markDirectWhatsAppAudio(message, source);
    expect(
      isDirectUserAudio({ ...message, sender: { ...message.sender, platformUserId: full } })
    ).toBe(false);
    expect(
      isDirectUserAudio({
        ...message,
        attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: new Uint8Array([4]) }],
      })
    ).toBe(false);
  });
  it('binds persisted audio by asset id without retaining a download buffer', () => {
    const { message, source } = fixture();
    message.attachments = [
      {
        type: 'audio',
        mimeType: 'audio/ogg',
        assetId: 'trusted-asset',
        path: '/private/audio.ogg',
      },
    ];
    markDirectWhatsAppAudio(message, source);
    expect(isDirectUserAudio(message)).toBe(true);
    expect(
      isDirectUserAudio({
        ...message,
        attachments: [{ ...message.attachments[0]!, assetId: 'other-asset' }],
      })
    ).toBe(false);
  });
  it('keeps proof through a verified Brazilian alias but rejects an unverified alias copy', async () => {
    const { message, source } = fixture();
    markDirectWhatsAppAudio(message, source);
    const user = {
      platform: 'whatsapp',
      platformUserId: full,
      ownpilotUserId: 'whatsapp:' + full,
      isVerified: true,
      status: 'active',
      isBlocked: false,
      accessSource: 'manual',
    } as ChannelUserEntity;
    const resolved = await resolveInboundWhatsAppSpelling(message, {
      findUser: vi.fn(async (phone: string) => (phone === full ? user : null)),
      resolvePhone: vi.fn().mockResolvedValue(null),
      owner: vi.fn().mockResolvedValue('5511999990102'),
      api: {
        getStatus: () => 'connected',
        resolveWhatsAppRecipient: async () => short,
      } as unknown as ChannelPluginAPI,
    });
    expect(resolved.platformChatId).toBe(full);
    expect(isDirectUserAudio({ ...resolved })).toBe(true);
    expect(isDirectUserAudio({ ...resolved, id: 'another-message' })).toBe(false);
    expect(
      isDirectUserAudio({
        ...message,
        platformChatId: full,
        sender: { ...message.sender, platformUserId: full },
      })
    ).toBe(false);
  });
});
