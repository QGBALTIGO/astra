/**
 * WhatsApp Channel Normalizer
 *
 * Handles WhatsApp-specific message formatting:
 * - Incoming: WhatsApp formatting conversion (*bold*, _italic_)
 * - Outgoing: Internal tag stripping, markdown conversion, message splitting at 4096 chars
 */

import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import type { NormalizedAttachment } from '@ownpilot/core/services';
import type { ChannelNormalizer, NormalizedIncoming } from './types.js';
import { stripInternalTags } from './base.js';
import { splitMessage, PLATFORM_MESSAGE_LIMITS } from '../utils/message-utils.js';
import { flattenChatWidgetsToText } from '../../utils/chat-widgets.js';
import { formatChannelTables } from './channel-table-format.js';

const WHATSAPP_MAX_LENGTH = PLATFORM_MESSAGE_LIMITS.whatsapp ?? 4096;

/**
 * Convert WhatsApp formatting to plain text.
 * WhatsApp uses: *bold*, _italic_, ~strikethrough~, ```monospace```
 */
function normalizeWhatsAppFormatting(text: string): string {
  // WhatsApp formatting is already close to Markdown — keep it as-is
  // The AI will receive plain-ish text and respond in Markdown
  return text;
}

/**
 * Convert standard Markdown to WhatsApp formatting.
 * **bold** → *bold*, __italic__ → _italic_, ~~strike~~ → ~strike~
 */
function markdownToWhatsApp(text: string): string {
  // Format prose only. Examples in code and characters inside URLs are literal,
  // and this function also runs at the final send boundary after bus formatting.
  return text
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g)
    .map((part, index) => {
      if (index % 2) return part;
      const prose = part
        .replace(
          /\[([^\]\n]+)\]\((https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)\)/g,
          (_match, label: string, url: string) => (label === url ? url : `${label}: ${url}`)
        )
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs: string, label: string) => {
          const href = attrs.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
          const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').replace(
            /&amp;|&#0*38;|&#x0*26;/gi,
            '&'
          );
          if (!/^https?:\/\/[^\s<>]+$/i.test(url)) return label;
          return label === url ? url : `${label}: ${url}`;
        })
        .replace(/<br\b[^>]*\/?>/gi, '\n')
        .replace(/<\/(?:p|div)\s*>/gi, '\n\n')
        .replace(/<li\b[^>]*>/gi, '• ')
        .replace(/<\/li\s*>/gi, '\n')
        .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, '**$1**')
        .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*?)?\s*\/?>/gi, '');
      return prose
        .split(/(https?:\/\/[^\s<>]+)/gi)
        .map((piece, urlIndex) =>
          urlIndex % 2
            ? piece
            : piece
                .replace(/&nbsp;|&#160;/gi, ' ')
                .replace(/\*{2,}(.+?)\*{2,}/g, '*$1*')
                .replace(/_{2,}(.+?)_{2,}/g, '_$1_')
                .replace(/~~(.+?)~~/g, '~$1~')
        )
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
    })
    .join('')
    .trim();
}

export const whatsappNormalizer: ChannelNormalizer = {
  platform: 'whatsapp',

  normalizeIncoming(msg: ChannelIncomingMessage): NormalizedIncoming {
    let text = msg.text || '';

    text = normalizeWhatsAppFormatting(text);

    // Convert attachments to base64 data URIs
    const attachments: NormalizedAttachment[] | undefined = msg.attachments
      ?.filter((a) => a.data)
      .map((a) => ({
        type: a.type,
        data: `data:${a.mimeType};base64,${Buffer.from(a.data!).toString('base64')}`,
        mimeType: a.mimeType,
        filename: a.filename,
        size: a.size,
      }));

    return {
      text: text || (attachments?.length ? '[Attachment]' : ''),
      attachments: attachments?.length ? attachments : undefined,
    };
  },

  normalizeOutgoing(response: string): string[] {
    let cleaned = stripInternalTags(response);
    if (!cleaned) return [];

    // Flatten <widget> tags to plain-text markdown — WhatsApp can't render
    // the web UI's visual widgets, and raw XML in messages is broken UX.
    cleaned = formatChannelTables(flattenChatWidgetsToText(cleaned));

    // Convert standard Markdown to WhatsApp formatting
    cleaned = markdownToWhatsApp(cleaned);

    return splitMessage(cleaned, WHATSAPP_MAX_LENGTH);
  },
};
