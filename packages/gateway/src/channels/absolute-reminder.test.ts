import { describe, expect, it } from 'vitest';
import {
  parseAbsoluteReminderRequest,
  resolveAbsoluteReminderLocalDateTime,
} from './absolute-reminder.js';

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
  it('checks 18,432 combinations of commands, subjects, hours, formats and day offsets', () => {
    const commands = [
      'Me lembra',
      'Me lembre',
      'Me avisa',
      'Me avise',
      'Lembre-me',
      'Pode me lembrar',
      'Astra, me lembre',
      'Por favor, me lembra',
    ];
    const subjects = [
      'cancelar o seguro do gol',
      'pagar a conta',
      'enviar e-mail ao contador',
      'comprar pão',
    ];
    for (const command of commands) {
      for (const title of subjects) {
        for (let hour = 0; hour < 24; hour++) {
          const hh = String(hour).padStart(2, '0');
          const clocks = [
            [hour + 'h', hh + ':00'],
            [hour + 'h30', hh + ':30'],
            [hour + ':15', hh + ':15'],
            [String(hour), hh + ':00'],
          ];
          for (const [clock, time] of clocks) {
            for (const [date, dayOffset] of [
              ['hoje', 0],
              ['amanhã', 1],
              ['depois de amanhã', 2],
            ]) {
              for (const phrase of [
                command + ' de ' + title + ' ' + date + ' às ' + clock,
                command + ' ' + date + ' às ' + clock + ' de ' + title,
              ]) {
                expect(parseAbsoluteReminderRequest(phrase), phrase).toEqual({
                  title,
                  dayOffset,
                  time,
                });
              }
            }
          }
        }
      }
    }
  });

  it.each([
    ['Me lembre de pagar às 17h amanhã', '17:00', 1],
    ['Me lembre de pagar às 17', '17:00', 0],
    ['Me lembre de pagar 17h', '17:00', 0],
    ['Me lembre de pagar ao meio-dia', '12:00', 0],
    ['Me lembre de pagar à meia-noite', '00:00', 0],
    ['Lembrete: pagar amanhã às 9h', '09:00', 1],
    ['Me lembre de pagar depois de amanhã às 8 horas', '08:00', 2],
  ])('supports a different explicit clock or date position: %s', (text, time, dayOffset) => {
    expect(parseAbsoluteReminderRequest(text)).toMatchObject({ title: 'pagar', time, dayOffset });
  });

  it.each([
    ['Me lembre de pagar dia 25/11 às 17h', '2026-11-25T17:00'],
    ['Me lembre de pagar às 17h dia 25/11/2027', '2027-11-25T17:00'],
    ['Me lembre de pagar dia 28 às 9h', '2026-11-28T09:00'],
    ['Me lembre de pagar amanhã às 17h', '2026-11-24T17:00'],
    ['Me lembre de pagar dia 31/11 às 17h', null],
    ['Me lembre de pagar dia 29/02/2027 às 17h', null],
  ])('resolves explicit dates without rollover: %s', (text, expected) => {
    const parsed = parseAbsoluteReminderRequest(text);
    expect(parsed).not.toBeNull();
    expect(
      resolveAbsoluteReminderLocalDateTime(
        parsed!,
        new Date('2026-11-24T01:00:00Z'),
        'America/Campo_Grande'
      )
    ).toBe(expected);
  });

  it.each([
    'Me lembre de pagar todo dia às 17h',
    'Me lembre de pagar às 17h amanhã hoje',
    'Me lembre de pagar dia 25/11 às 17h dia 26/11',
    'Me lembre de pagar às 17h e às 18h',
    'Me lembre de pagar às 17h e envie um e-mail',
    'Me lembre de pagar às 17h da tarde',
  ])('does not silently reinterpret an ambiguous or recurring request: %s', (text) => {
    expect(parseAbsoluteReminderRequest(text)).toBeNull();
  });
});
