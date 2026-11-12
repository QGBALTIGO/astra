import type { MessageRelayOptions, proto } from '@whiskeysockets/baileys';
import type { ChannelOutgoingMessage } from '@ownpilot/core/channels';
import { normalizeChannelUrl } from '../../utils/url-button.js';

/**
 * WhatsApp Web's experimental native-flow URL CTA.
 *
 * Do not turn an ambiguous relay failure into a second text send: a socket
 * exception can happen AFTER WhatsApp accepted the interactive message.
 * This payload deliberately keeps the destination URL out of the text body.
 */
export function buildWhatsAppUrlCtaPayload(
  text: string,
  action: NonNullable<ChannelOutgoingMessage['urlButton']>
): {
  body: string;
  content: proto.IMessage;
  relayOptions: Pick<MessageRelayOptions, 'additionalNodes'>;
} {
  const url = normalizeChannelUrl(action?.url);
  const label = typeof action?.label === 'string' ? action.label.trim() : '';
  // Only HTTPS and a short, plain label for this native interactive action.
  // No untrusted protocol nodes, redirects, credentials or URL previews.
  if (
    !url ||
    !url.startsWith('https://') ||
    !label ||
    label.length > 20 ||
    /[\p{Cc}\p{Cf}*_~<>[\]]/u.test(label) ||
    typeof text !== 'string'
  ) {
    throw new Error('Invalid WhatsApp URL CTA');
  }

  const body = text
    // Clients should see the link only in the button, never inside its body.
    .replaceAll(action.url, '')
    .replaceAll(url, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  if (!body || body.length > 1024 || body.includes(url)) {
    throw new Error('Invalid WhatsApp URL CTA body');
  }

  return {
    body,
    content: {
      interactiveMessage: {
        body: { text: body },
        nativeFlowMessage: {
          buttons: [
            {
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({
                display_text: label,
                url,
                merchant_url: url,
              }),
            },
          ],
          messageParamsJson: '{}',
          messageVersion: 1,
        },
      },
    },
    // The same native-flow envelope already used by Astra's copy-code CTA.
    relayOptions: {
      additionalNodes: [
        {
          tag: 'biz',
          attrs: {},
          content: [
            {
              tag: 'interactive',
              attrs: { type: 'native_flow', v: '1' },
              content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
            },
          ],
        },
      ],
    },
  };
}
