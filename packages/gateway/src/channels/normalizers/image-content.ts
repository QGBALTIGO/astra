import type { ImageContent } from '@ownpilot/core/agent';
import type { NormalizedAttachment } from '@ownpilot/core/services';

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Normalizers carry data URIs; provider clients expect raw base64 and add their own prefix. */
export function attachmentImageContent(attachment: NormalizedAttachment): ImageContent | null {
  if (attachment.type !== 'image' || !attachment.data || !attachment.mimeType) return null;
  const mime = attachment.mimeType.toLowerCase();
  if (!IMAGE_MIME.has(mime)) return null;
  let data = attachment.data;
  if (/^data:/i.test(data)) {
    const inline = /^data:(image\/(?:jpeg|png|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(data);
    if (!inline || inline[1]!.toLowerCase() !== mime) return null;
    data = inline[2]!.replace(/\s/g, '');
  }
  return { type: 'image', data, mediaType: mime as ImageContent['mediaType'] };
}
