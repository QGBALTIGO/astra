import { describe, it, expect } from 'vitest';
import { newsCards, isRadarNewsCard } from './news-cards.js';
import { buildWhatsAppUrlCtaPayload } from '../../channels/plugins/whatsapp/whatsapp-url-cta.js';
describe('news article cards', () => {
  it('rejects a long or Unicode-expanded URL before it can trigger the WhatsApp raw-link fallback', () => {
    expect(
      isRadarNewsCard({
        text: 'x'.repeat(500),
        urlButton: { label: 'Ler matéria', url: 'https://pt.globalvoices.org/' + 'a'.repeat(560) },
      })
    ).toBe(false);
    expect(
      newsCards(
        [
          {
            id: 'unicode',
            title: 'Matéria',
            url: 'https://pt.globalvoices.org/' + 'á'.repeat(180),
          },
        ],
        'Mundo'
      )
    ).toEqual([]);
  });
  it('keeps headlines, dates and attribution in short cards, placing each original URL only in its native button', () => {
    const cards = newsCards(
      [1, 2, 3].map((n) => ({
        id: String(n),
        title: `Matéria ${n}`,
        text: 'Publicado em 16/11/2026 · Global Voices · CC BY 3.0',
        url: `https://pt.globalvoices.org/2026/11/16/materia-${n}/`,
      })),
      'Mundo'
    );
    expect(cards).toHaveLength(3);
    for (const [i, card] of cards.entries()) {
      expect(card.text).toContain(`Matéria ${i + 1}`);
      expect(card.text).toContain('16/11/2026');
      expect(card.text).toContain('Global Voices · CC BY 3.0');
      expect(card.text).not.toMatch(/https?:|www\./);
      const payload = buildWhatsAppUrlCtaPayload(card.text, card.urlButton);
      expect(payload.body).not.toContain(card.urlButton.url);
      const buttons = payload.content.interactiveMessage?.nativeFlowMessage?.buttons;
      expect(buttons).toHaveLength(1);
      expect(JSON.parse(buttons![0]!.buttonParamsJson!)).toMatchObject({
        display_text: 'Ler matéria',
        url: card.urlButton.url,
      });
    }
  });
  it('bounds long headlines and deduplicates articles without adding an oversized text-link fallback', () => {
    const item = {
      id: 'a',
      title: 'Uma notícia '.repeat(200),
      url: 'https://pt.globalvoices.org/' + 'a'.repeat(540),
    };
    const cards = newsCards([item, item], 'Assunto '.repeat(80));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text.length + cards[0]!.urlButton.url.length + 20).toBeLessThan(1024);
  });
  it.each([
    'http://pt.globalvoices.org/a',
    'https://evil.test/a',
    'https://pt.globalvoices.org.evil.test/a',
    'https://user:pass@pt.globalvoices.org/a',
    'javascript:alert(1)',
  ])('rejects unsafe article actions: %s', (url) => {
    expect(newsCards([{ id: 'a', title: 'Matéria', url }], 'Mundo')).toEqual([]);
    expect(isRadarNewsCard({ text: '📰 Matéria', urlButton: { label: 'Ler matéria', url } })).toBe(
      false
    );
  });
});
