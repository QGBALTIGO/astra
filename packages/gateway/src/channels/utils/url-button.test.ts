import { describe, expect, it } from 'vitest';
import { normalizeChannelUrl, renderUrlButtonAsText } from './url-button.js';

describe('URL action text fallback', () => {
  it('renders a label and clickable web URL in the same text message', () => {
    expect(
      renderUrlButtonAsText({
        text: 'Conheça o Astra. 💙',
        urlButton: { label: 'Conhecer o Astra', url: 'https://astra.example/' },
      })
    ).toBe('Conheça o Astra. 💙\n\n*Conhecer o Astra*\nhttps://astra.example/');
  });

  it('does not append a URL already present as a complete link', () => {
    const text = 'Conheça o Astra: https://astra.example';
    expect(
      renderUrlButtonAsText({
        text,
        urlButton: { label: 'Conhecer', url: 'https://astra.example/' },
      })
    ).toBe(text);
    expect(
      renderUrlButtonAsText({
        text: 'Outro link: https://astra.example.evil/',
        urlButton: { label: 'Conhecer', url: 'https://astra.example/' },
      })
    ).toContain('\nhttps://astra.example/');
  });

  it('keeps ordinary text unchanged and sanitizes the fallback label', () => {
    expect(renderUrlButtonAsText({ text: 'Mensagem normal.\n' })).toBe('Mensagem normal.\n');
    expect(
      renderUrlButtonAsText({
        text: '',
        urlButton: { label: '*Conhecer*\n\u202eAstra', url: 'https://astra.example/' },
      })
    ).toBe('*Conhecer Astra*\nhttps://astra.example/');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'ftp://astra.example/',
    '//astra.example/',
    'https://user:password@astra.example/',
    'https://astra.example/\nelsewhere',
    'https://astra.example/\u202eelsewhere',
    'https://astra.example/a b',
  ])('discards an unsafe or unsupported URL before rendering: %j', (url) => {
    expect(normalizeChannelUrl(url)).toBeUndefined();
    expect(renderUrlButtonAsText({ text: 'Olá!', urlButton: { label: 'Conhecer', url } })).toBe(
      'Olá!'
    );
  });

  it('normalizes only valid absolute web URLs and preserves query data', () => {
    expect(normalizeChannelUrl(' https://astra.example/plan?ref=a%20b#about ')).toBe(
      'https://astra.example/plan?ref=a%20b#about'
    );
    expect(normalizeChannelUrl('http://localhost:3000')).toBe('http://localhost:3000/');
  });
});
