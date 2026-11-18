/**
 * WhatsApp Channel Normalizer Tests
 */

import { describe, it, expect } from 'vitest';
import { whatsappNormalizer } from './whatsapp.js';

describe('whatsappNormalizer', () => {
  it('turns source links into WhatsApp-readable URLs without duplicated markup', () => {
    const [text] = whatsappNormalizer.normalizeOutgoing(
      'Fonte: [MET Norway](https://api.met.no/) · [https://example.com/a](https://example.com/a).'
    );
    expect(text).toBe('Fonte: MET Norway: https://api.met.no/ · https://example.com/a.');
  });
  it('preserves URL parentheses and separate adjacent links', () => {
    expect(
      whatsappNormalizer.normalizeOutgoing(
        '[A](https://example.com/Foo_(bar))[B](https://example.org/)'
      )[0]
    ).toBe('A: https://example.com/Foo_(bar)B: https://example.org/');
  });
  describe('platform', () => {
    it('has platform = whatsapp', () => {
      expect(whatsappNormalizer.platform).toBe('whatsapp');
    });
  });

  // =========================================================================
  // normalizeIncoming
  // =========================================================================

  describe('normalizeIncoming', () => {
    it('returns plain text unchanged', () => {
      const result = whatsappNormalizer.normalizeIncoming({ text: 'Hello world' });
      expect(result.text).toBe('Hello world');
    });

    it('preserves WhatsApp *bold* formatting as-is', () => {
      const result = whatsappNormalizer.normalizeIncoming({ text: '*bold text*' });
      expect(result.text).toBe('*bold text*');
    });

    it('preserves WhatsApp _italic_ formatting as-is', () => {
      const result = whatsappNormalizer.normalizeIncoming({ text: '_italic text_' });
      expect(result.text).toBe('_italic text_');
    });

    it('preserves WhatsApp ~strikethrough~ formatting as-is', () => {
      const result = whatsappNormalizer.normalizeIncoming({ text: '~strike~' });
      expect(result.text).toBe('~strike~');
    });

    it('returns empty string when text is empty', () => {
      const result = whatsappNormalizer.normalizeIncoming({ text: '' });
      expect(result.text).toBe('');
    });

    it('returns [Attachment] when text is empty and has attachments with data', () => {
      const result = whatsappNormalizer.normalizeIncoming({
        text: '',
        attachments: [{ type: 'image', data: Buffer.from('img'), mimeType: 'image/png' }],
      });
      expect(result.text).toBe('[Attachment]');
    });

    it('converts attachments with data to base64 data URIs', () => {
      const data = Buffer.from('image bytes');
      const result = whatsappNormalizer.normalizeIncoming({
        text: 'see attached',
        attachments: [
          { type: 'image', data, mimeType: 'image/jpeg', filename: 'photo.jpg', size: 11 },
        ],
      });
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments![0].data).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('filters out attachments without data', () => {
      const result = whatsappNormalizer.normalizeIncoming({
        text: 'hi',
        attachments: [{ type: 'image', mimeType: 'image/png' }],
      });
      expect(result.attachments).toBeUndefined();
    });

    it('includes attachment metadata (filename, size)', () => {
      const data = Buffer.from('x');
      const result = whatsappNormalizer.normalizeIncoming({
        text: '',
        attachments: [
          { type: 'file', data, mimeType: 'application/pdf', filename: 'doc.pdf', size: 1 },
        ],
      });
      expect(result.attachments![0].filename).toBe('doc.pdf');
      expect(result.attachments![0].size).toBe(1);
    });

    it('handles undefined attachments gracefully', () => {
      const result = whatsappNormalizer.normalizeIncoming({ text: 'no attachments' });
      expect(result.attachments).toBeUndefined();
    });
  });

  // =========================================================================
  // normalizeOutgoing
  // =========================================================================

  describe('normalizeOutgoing', () => {
    it.each(['***Importante***', '____Importante____', '~~Importante~~'])(
      'normalizes nested emphasis once for both bus and final send boundary: %s',
      (input) => {
        const once = whatsappNormalizer.normalizeOutgoing(input).join('\n\n');
        const twice = whatsappNormalizer.normalizeOutgoing(once).join('\n\n');
        expect(twice).toBe(once);
        expect(once).toMatch(/^[*_~]Importante[*_~]$/);
      }
    );

    it('keeps HTML anchor destinations when converting prose to WhatsApp text', () => {
      const input =
        '<a href="https://example.com/painel?x=1&amp;y=2">Painel</a><br>' +
        "<a href='http://example.com/help'>Ajuda</a><br>" +
        '<a href=https://example.com/account>https://example.com/account</a>';
      const once = whatsappNormalizer.normalizeOutgoing(input).join('\n\n');
      expect(once).toBe(
        'Painel: https://example.com/painel?x=1&y=2\nAjuda: http://example.com/help\nhttps://example.com/account'
      );
      expect(whatsappNormalizer.normalizeOutgoing(once).join('\n\n')).toBe(once);
    });

    it('preserves entity-like strings and formatting characters inside literal URLs', () => {
      const url = 'https://example.com/search?q=one&nbsp;two&name=__literal__&part=**value**';
      const input = '**Veja**<br>' + url + '<br>um&nbsp;texto';
      const once = whatsappNormalizer.normalizeOutgoing(input).join('\n\n');
      expect(once).toBe('*Veja*\n' + url + '\num texto');
      expect(whatsappNormalizer.normalizeOutgoing(once).join('\n\n')).toBe(once);
    });

    it('keeps anchor examples inside code literal and does not emit non-HTTP hrefs', () => {
      const code = '~~~html\n<a href="https://example.com/?q=one&nbsp;two">**Literal**</a>\n~~~';
      const input = code + '\n<a href="javascript:alert(1)">Rótulo</a>';
      const once = whatsappNormalizer.normalizeOutgoing(input).join('\n\n');
      expect(once).toBe(code + '\nRótulo');
      expect(whatsappNormalizer.normalizeOutgoing(once).join('\n\n')).toBe(once);
    });

    it('renders HTML line breaks and ordinary HTML formatting as WhatsApp text', () => {
      const [text] = whatsappNormalizer.normalizeOutgoing(
        '<p>**Finanças**<br>Registre uma despesa.<BR />Veja seus pendentes.</p><p><strong>Lembretes</strong><br/>Avise amanhã.</p>'
      );
      expect(text).toBe(
        '*Finanças*\nRegistre uma despesa.\nVeja seus pendentes.\n\n*Lembretes*\nAvise amanhã.'
      );
      expect(text).not.toMatch(/<[^>]*>|\*\*/);
    });

    it('preserves literal code, existing WhatsApp markup and URLs through repeated normalization', () => {
      const input =
        '*Já formatado*\n**Novo**<br>https://example.com/a__b__?q=**x**\n```\n**literal** <br>\n```\n`**outro** <br>`';
      const once = whatsappNormalizer.normalizeOutgoing(input).join('\n\n');
      const twice = whatsappNormalizer.normalizeOutgoing(once).join('\n\n');
      expect(once).toContain('*Já formatado*\n*Novo*\nhttps://example.com/a__b__?q=**x**');
      expect(once).toContain('```\n**literal** <br>\n```');
      expect(once).toContain('`**outro** <br>`');
      expect(twice).toBe(once);
    });

    it('returns empty array for empty response', () => {
      expect(whatsappNormalizer.normalizeOutgoing('')).toEqual([]);
    });

    it('converts **bold** to WhatsApp *bold*', () => {
      const result = whatsappNormalizer.normalizeOutgoing('**hello**');
      expect(result[0]).toBe('*hello*');
    });

    it('converts __italic__ to WhatsApp _italic_', () => {
      const result = whatsappNormalizer.normalizeOutgoing('__italic__');
      expect(result[0]).toBe('_italic_');
    });

    it('converts ~~strike~~ to WhatsApp ~strike~', () => {
      const result = whatsappNormalizer.normalizeOutgoing('~~strike~~');
      expect(result[0]).toBe('~strike~');
    });

    it('returns plain text unchanged', () => {
      const result = whatsappNormalizer.normalizeOutgoing('Just a message.');
      expect(result[0]).toBe('Just a message.');
    });

    it('returns array with single element for short message', () => {
      const result = whatsappNormalizer.normalizeOutgoing('Short message.');
      expect(result).toHaveLength(1);
    });

    it('strips internal tags', () => {
      const result = whatsappNormalizer.normalizeOutgoing('<context>private</context>Hello');
      expect(result[0]).not.toContain('<context>');
      expect(result[0]).toContain('Hello');
    });

    it('strips <suggestions> internal tags', () => {
      const result = whatsappNormalizer.normalizeOutgoing(
        '<suggestions>hint</suggestions>Response'
      );
      expect(result[0]).not.toContain('<suggestions>');
      expect(result[0]).toContain('Response');
    });

    it('splits long messages at ~4096 chars', () => {
      const longMsg = 'a'.repeat(5000);
      const result = whatsappNormalizer.normalizeOutgoing(longMsg);
      expect(result.length).toBeGreaterThan(1);
      result.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(4096));
    });

    it('converts multiple markdown patterns in one message', () => {
      const result = whatsappNormalizer.normalizeOutgoing('**bold** and ~~strikethrough~~');
      expect(result[0]).toBe('*bold* and ~strikethrough~');
    });

    it('flattens <widget> tags to plain text — never leaks raw XML', () => {
      const response = `Report:\n<widget name="metric_grid" data='{"items":[{"label":"Total","value":"28"}]}' />\nDone.`;
      const result = whatsappNormalizer.normalizeOutgoing(response);
      expect(result[0]).not.toContain('<widget');
      expect(result[0]).not.toContain('&quot;');
      expect(result[0]).toContain('Total');
      expect(result[0]).toContain('*28*'); // WhatsApp-formatted bold
      expect(result[0]).toContain('Done.');
    });
  });
});
