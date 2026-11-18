/** Transport-owned proof for one directly received private audio message. */
import { createHash } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { inboundChannelAssetScope } from '../../whatsapp-inbound-identity.js';

const DIRECT_AUDIO = Symbol('verified direct WhatsApp audio');
type AudioProof = {
  id: string;
  plugin: string;
  chat: string;
  attachment: string;
};
type ProvenAudio = ChannelIncomingMessage & { [DIRECT_AUDIO]?: Readonly<AudioProof> };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function forwarded(context: unknown): boolean {
  if (context === undefined || context === null) return false;
  const value = object(context);
  if (!value) return true;
  return (
    (value.isForwarded !== undefined &&
      value.isForwarded !== null &&
      value.isForwarded !== false) ||
    (value.forwardingScore !== undefined &&
      value.forwardingScore !== null &&
      value.forwardingScore !== 0) ||
    Object.entries(value).some(([key, entry]) => /^forwarded/i.test(key) && entry != null)
  );
}

function directlyReceivedAudio(content: unknown): boolean {
  let current = object(content);
  // Inspect the original envelope, including wrapper contexts, not normalized
  // metadata. A quoted message's own forwarding state does not describe this audio.
  for (let depth = 0; current && depth < 8; depth++) {
    if (
      forwarded(current) ||
      forwarded(current.contextInfo) ||
      forwarded(current.messageContextInfo)
    )
      return false;
    const audio = object(current.audioMessage);
    if (audio) return !forwarded(audio) && !forwarded(audio.contextInfo);
    const wrapper = [
      'ephemeralMessage',
      'viewOnceMessage',
      'viewOnceMessageV2',
      'viewOnceMessageV2Extension',
      'documentWithCaptionMessage',
    ]
      .map((key) => object(current![key]))
      .find(Boolean);
    if (!wrapper || forwarded(wrapper) || forwarded(wrapper.contextInfo)) return false;
    current = object(wrapper.message);
  }
  return false;
}

function attachmentIdentity(message: ChannelIncomingMessage): string | undefined {
  if (message.attachments?.length !== 1) return;
  const audio = message.attachments[0]!;
  if (audio.type !== 'audio' || !audio.mimeType.startsWith('audio/')) return;
  if (audio.assetId) return JSON.stringify(['asset', audio.assetId, audio.mimeType]);
  if (audio.data?.length)
    return JSON.stringify([
      'inline',
      createHash('sha256').update(audio.data).digest('hex'),
      audio.mimeType,
    ]);
  return;
}

/** Called only by the verified Baileys ingress; source.key.remoteJid is its resolved DM JID. */
export function markDirectWhatsAppAudio(message: ChannelIncomingMessage, source: WAMessage): void {
  delete (message as ProvenAudio)[DIRECT_AUDIO];
  const jid = source.key.remoteJid;
  const phone =
    typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')
      ? jid.split('@')[0]!.split(':')[0]
      : undefined;
  const attachment = attachmentIdentity(message);
  if (
    !source.key.id ||
    source.key.fromMe !== false ||
    !phone ||
    !/^[1-9]\d{9,14}$/u.test(phone) ||
    message.platform !== 'whatsapp' ||
    !message.channelPluginId ||
    message.id !== `${message.channelPluginId}:${source.key.id}` ||
    message.platformChatId !== phone ||
    message.sender.platformUserId !== phone ||
    message.sender.platform !== 'whatsapp' ||
    message.metadata?.fromMe !== false ||
    message.metadata.isGroup !== false ||
    !attachment ||
    forwarded(source) ||
    !directlyReceivedAudio(source.message)
  )
    return;
  (message as ProvenAudio)[DIRECT_AUDIO] = Object.freeze({
    id: message.id,
    plugin: message.channelPluginId,
    chat: phone,
    attachment,
  });
}

/** JSON/metadata cannot mint this proof; only the verified alias resolver may change its chat spelling. */
export function isDirectUserAudio(message: ChannelIncomingMessage): boolean {
  const proof = (message as ProvenAudio)[DIRECT_AUDIO];
  if (
    !proof ||
    message.platform !== 'whatsapp' ||
    message.sender.platform !== 'whatsapp' ||
    message.metadata?.fromMe !== false ||
    message.metadata.isGroup !== false ||
    message.sender.platformUserId !== message.platformChatId
  )
    return false;
  const original = inboundChannelAssetScope(message);
  return (
    original.id === proof.id &&
    original.channelPluginId === proof.plugin &&
    original.platform === 'whatsapp' &&
    original.platformChatId === proof.chat &&
    attachmentIdentity(message) === proof.attachment
  );
}
