import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { buildWhatsAppCopyCodePayload } from './whatsapp-copy-code.js';
import { buildCustomerOtpMessage } from '../../../services/customer-auth-messages.js';

describe('WhatsApp native copy-code protocol', () => {
  it.each(['login', 'phone_change_old', 'phone_change_new'] as const)(
    'preserves the body and exact clipboard value through the pinned SDK for %s',
    (purpose) => {
      const outgoing = buildCustomerOtpMessage('000123', purpose);
      const payload = buildWhatsAppCopyCodePayload(outgoing.text, outgoing.copyCode);
      const generated = generateWAMessageFromContent(
        '5511999999999@s.whatsapp.net',
        payload.content,
        { userJid: '5511888888888:1@s.whatsapp.net', messageId: 'otp-protocol-test' }
      );
      const decoded = proto.Message.decode(proto.Message.encode(generated.message!).finish());

      expect(generated.key).toMatchObject({
        id: 'otp-protocol-test',
        remoteJid: '5511999999999@s.whatsapp.net',
        fromMe: true,
      });
      expect(decoded.viewOnceMessage).toBeNull();
      expect(decoded.conversation).toBeNull();
      expect(decoded.interactiveMessage?.body?.text).toBe(outgoing.text);
      expect(decoded.interactiveMessage?.nativeFlowMessage?.messageVersion).toBe(1);
      const buttons = decoded.interactiveMessage?.nativeFlowMessage?.buttons;
      expect(buttons).toHaveLength(1);
      expect(buttons?.[0]?.name).toBe('cta_copy');
      expect(JSON.parse(buttons![0]!.buttonParamsJson!)).toEqual({
        display_text: 'Copiar código',
        copy_code: '000123',
      });
      expect(payload.relayOptions.additionalNodes).toEqual([
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
      ]);
      // Only the encrypted message contains the OTP, never the stanza hints.
      expect(JSON.stringify(payload.relayOptions)).not.toContain('000123');
    }
  );

  it.each(['12345', '1234567', '123456\n', '123 45', 'abcdef', '１２３４５６'])(
    'rejects a malformed clipboard value without echoing it: %j',
    (code) => {
      expect(() =>
        buildWhatsAppCopyCodePayload(`Access code: ${code}`, { label: 'Copiar código', code })
      ).toThrow(/^Invalid WhatsApp copy-code message$/);
    }
  );

  it('rejects a button whose code would not be visible in the message', () => {
    expect(() =>
      buildWhatsAppCopyCodePayload('Access code: 654321', {
        label: 'Copiar código',
        code: '000123',
      })
    ).toThrow('Invalid WhatsApp copy-code message');
  });

  it.each(['', ' '.repeat(3), 'x'.repeat(21), 'Copiar\ncódigo'])(
    'rejects an unusable button label: %j',
    (label) => {
      expect(() =>
        buildWhatsAppCopyCodePayload('Access code: 000123', { label, code: '000123' })
      ).toThrow('Invalid WhatsApp copy-code message');
    }
  );

  it('rejects an oversized native body before any split or send', () => {
    expect(() =>
      buildWhatsAppCopyCodePayload('000123' + 'x'.repeat(1019), {
        label: 'Copiar código',
        code: '000123',
      })
    ).toThrow('Invalid WhatsApp copy-code message');
  });
});
