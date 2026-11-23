import { describe, expect, it } from 'vitest';
import { parseAbsoluteReminderRequest } from './absolute-reminder.js';

describe('explicit wall-clock reminders', () => {
  it.each([
    ['Me lembra de cancelar o seguro do gol às 17h', 'cancelar o seguro do gol', 0, '17:00'],
    ['Lembrete as 17h, seguro do gol', 'seguro do gol', 0, '17:00'],
    ['Me lembre de pagar a conta amanhã às 8h30', 'pagar a conta', 1, '08:30'],
    ['Me avisa hoje às 17:15 de ligar para o dentista', 'ligar para o dentista', 0, '17:15'],
    ['Lembrete amanhã às 9h, reunião', 'reunião', 1, '09:00'],
  ])('parses %s without inventing date or subject', (text, title, dayOffset, time) => {
    expect(parseAbsoluteReminderRequest(text)).toEqual({ title, dayOffset, time });
  });

  it.each([
    'Lembrete às 17h',
    'Qual o lembrete às 17h?',
    'Paguei o seguro do gol às 17h',
    'Não me lembre de pagar às 17h',
    'Me lembra de pagar às 25h',
    'Me lembra de pagar às 17h ou às 18h',
    'Me lembra de pagar às 17h e crie uma tarefa',
    'Me lembra de pagar mas não agende às 17h',
    'Me avise se o dólar cair às 17h',
    'Lembrete às 17h, se o dólar cair',
    'Lembrete às 17h, qual o assunto?',
    'Me lembre daqui 20 segundos de olhar o pc',
    'Me lembre de pagar segunda às 17h',
    'Me lembre de pagar às 17h; apague a conta',
  ])('does not execute ambiguous or unrelated requests: %s', (text) => {
    expect(parseAbsoluteReminderRequest(text)).toBeNull();
  });
});
