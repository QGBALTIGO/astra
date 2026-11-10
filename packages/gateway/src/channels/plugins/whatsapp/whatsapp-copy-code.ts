import type { MessageRelayOptions, proto } from '@whiskeysockets/baileys';
import type { ChannelOutgoingMessage } from '@ownpilot/core/channels';

/**
 * Use the native-flow envelope used by Orion's production QR bridge. Keep the
 * action and relay hints fixed here; callers cannot supply arbitrary protocol
 * nodes, callbacks or button JSON. This action copies only the six OTP digits.
 */
export function buildWhatsAppCopyCodePayload(
  text: string,
  action: NonNullable<ChannelOutgoingMessage['copyCode']>
): { content: proto.IMessage; relayOptions: Pick<MessageRelayOptions, 'additionalNodes'> } {
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 1024 ||
    typeof action.code !== 'string' ||
    action.code.length !== 6 ||
    !/^\d{6}$/.test(action.code) ||
    !text.includes(action.code) ||
    typeof action.label !== 'string' ||
    !action.label.trim() ||
    action.label.length > 20 ||
    /[\u0000-\u001f\u007f]/u.test(action.label)
  ) {
    // Never include the invalid payload or code in an exception or log.
    throw new Error('Invalid WhatsApp copy-code message');
  }

  return {
    content: {
      interactiveMessage: {
        body: { text },
        nativeFlowMessage: {
          buttons: [
            {
              name: 'cta_copy',
              buttonParamsJson: JSON.stringify({
                display_text: action.label,
                copy_code: action.code,
              }),
            },
          ],
          messageVersion: 1,
        },
      },
    },
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
