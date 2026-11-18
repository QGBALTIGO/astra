import { describe, expect, it } from 'vitest';
import { hasChannelEmailSubject, isChannelEmailRequest } from './email-intent.js';

describe('current email subjects and bounded continuations', () => {
  const emailHistory = 'Seus e-mails do Gmail estão conectados à conta Google.';
  it.each([
    'Quais os últimos gmais importantes que recebi',
    'Quais os últimos e-mails importantes que recebi',
    'Mostre os gmails recebidos hoje',
    'Meus e‑mails recebidos',
    'Minha caixa de entrada',
    'Liste os e mails importantes',
  ])('recognizes the explicit email subject: %s', (text) => {
    expect(hasChannelEmailSubject(text)).toBe(true);
    expect(isChannelEmailRequest(text)).toBe(true);
  });
  it.each([
    'E os últimos recebidos?',
    'Só os importantes',
    'Mostre os mais recentes',
    'Quais os últimos que recebi?',
  ])('inherits email only for an elliptical continuation: %s', (text) => {
    expect(isChannelEmailRequest(text, emailHistory)).toBe(true);
    expect(isChannelEmailRequest(text)).toBe(false);
  });
  it.each([
    'Qual o último jogo do Flamengo?',
    'Me indica filmes recentes',
    'Quanto recebi hoje?',
    'Mostre as entradas recebidas',
    'Quero uma receita de frango',
    'Quais os e-mails que recebi e quanto gastei hoje?',
    'Gastei 25 reais com Gmail',
  ])('does not reinterpret a new or explicit financial subject as mail: %s', (text) => {
    expect(isChannelEmailRequest(text, emailHistory)).toBe(false);
  });
});
