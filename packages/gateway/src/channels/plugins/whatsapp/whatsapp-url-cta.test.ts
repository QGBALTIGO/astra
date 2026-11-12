import { describe, expect, it } from 'vitest';
import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { buildWhatsAppUrlCtaPayload } from './whatsapp-url-cta.js';

const URL = 'https://astra-gateway-production.up.railway.app/cliente/transacoes';
const label = 'Acompanhar no painel';
const text = '✅ *Entrada registrada*\n\n• *Valor:* R$ 1,00\n• *Data:* 12/11/2026';

describe('Native WhatsApp CTA URL with pinned Baileys SDK', () => {
  it('encodes a single clickable cta_url button without exposing the URL as text', () => {
    const payload = buildWhatsAppUrlCtaPayload(text, { label, url: URL });
    const generated = generateWAMessageFromContent(
      '5511999999999@s.whatsapp.net',
      payload.content,
      { userJid: '5511888888888:1@s.whatsapp.net', messageId: 'cta-protocol-test' }
    );
    const decoded = proto.Message.decode(proto.Message.encode(generated.message!).finish());
    expect(generated.key).toMatchObject({
      id: 'cta-protocol-test',
      remoteJid: '5511999999999@s.whatsapp.net',
      fromMe: true,
    });
    expect(decoded.interactiveMessage?.body?.text).toBe(text);
    expect(decoded.interactiveMessage?.body?.text).not.toContain(URL);
    expect(decoded.conversation).toBeNull();
    expect(decoded.extendedTextMessage).toBeNull();
    expect(decoded.interactiveMessage?.nativeFlowMessage?.messageVersion).toBe(1);
    expect(decoded.interactiveMessage?.nativeFlowMessage?.messageParamsJson).toBe('{}');
    const buttons = decoded.interactiveMessage?.nativeFlowMessage?.buttons;
    expect(buttons).toHaveLength(1);
    expect(buttons?.[0]?.name).toBe('cta_url');
    expect(JSON.parse(buttons![0]!.buttonParamsJson!)).toEqual({
      display_text: label,
      url: URL,
      merchant_url: URL,
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
    expect(JSON.stringify(payload.relayOptions)).not.toContain(URL);
  });

  it('removes a duplicate raw CTA URL from the displayed message before encoding', () => {
    const payload = buildWhatsAppUrlCtaPayload(text + '\n\n' + label + '\n' + URL, {
      label,
      url: URL,
    });
    expect(payload.body).toContain('Entrada registrada');
    expect(payload.body).not.toContain(URL);
    expect(JSON.stringify(payload.content.interactiveMessage?.nativeFlowMessage)).toContain(URL);
  });

  it.each([
    'javascript:alert(1)',
    'ftp://unsafe.example',
    'http://example.com',
    'https://user:pass@example.com/',
    'https://example.com/\nsecret',
    'https://example.com/\u202eevil',
  ])('rejects unsafe CTA destinations before sending: %j', (url) => {
    expect(() => buildWhatsAppUrlCtaPayload(text, { label, url })).toThrow(
      'Invalid WhatsApp URL CTA'
    );
  });

  it.each([
    '',
    ' '.repeat(4),
    'More than twenty characters',
    'Botão\nmalicioso',
    '*Acessar*',
    'Botão\u202E',
  ])('rejects invalid labels: %j', (value) => {
    expect(() => buildWhatsAppUrlCtaPayload(text, { label: value, url: URL })).toThrow(
      'Invalid WhatsApp URL CTA'
    );
  });
  it('refuses an empty or oversized body (never silently switches to an exposed link)', () => {
    expect(() => buildWhatsAppUrlCtaPayload('', { label, url: URL })).toThrow(
      'Invalid WhatsApp URL CTA body'
    );
    expect(() => buildWhatsAppUrlCtaPayload('x'.repeat(1025), { label, url: URL })).toThrow(
      'Invalid WhatsApp URL CTA body'
    );
  });
});
