import { describe, expect, it } from 'vitest';
import { parseRelativeReminderRequest } from './relative-reminder.js';

describe('explicit relative reminder requests', () => {
  it('reproduces the exact WhatsApp request from the screenshot', () => {
    expect(parseRelativeReminderRequest('Me lembre daqui 20 segundos pra vê o pc')).toEqual({
      kind: 'valid',
      title: 'vê o pc',
      delaySeconds: 20,
    });
  });

  it.each([
    ['Me lembre em 1 segundo de olhar o PC', 1],
    ['Me avisa daqui um segundo pra olhar o PC', 1],
    ['Lembre-me daqui uns 20 segundos de olhar o PC.', 20],
    ['Pode me lembrar em 20seg para olhar o PC?', 20],
    ['Me lembra daqui a 20s pra olhar o PC', 20],
    ['Me lembre em 1 minuto e 20 segundos de olhar o PC', 80],
    ['Me lembre em 1min20s para olhar o PC', 80],
    ['Me lembre em 1 minuto, e 20 segundos para olhar o PC', 80],
    ['Me lembre em 1 hora e 2 minutos e 3 segundos de olhar o PC', 3_723],
    ['Me lembre em 2h43min para olhar o PC', 9_780],
    ['Me lembre em uma hora para olhar o PC', 3_600],
    ['Me lembre em 0,5 minuto para olhar o PC', 30],
    ['Me lembre em 1.5 horas para olhar o PC', 5_400],
    ['Me lembre em 20 segundos e 1 minuto para olhar o PC', 80],
    ['Me lembre em 1 minuto e 0 segundos para olhar o PC', 60],
    ['Me lembre em 527040 minutos para olhar o PC', 366 * 86_400],
  ])('preserves all units in %s', (text, delaySeconds) => {
    expect(parseRelativeReminderRequest(text)).toEqual({
      kind: 'valid',
      title: 'olhar o PC',
      delaySeconds,
    });
  });

  it.each([
    ['Me lembre daqui 1.000 segundos pra olhar o PC', 1_000],
    ['Me lembre daqui 1.500 minutos pra olhar o PC', 90_000],
    ['Me lembre daqui 1.234,5 minutos pra olhar o PC', 74_070],
    ['Me lembre daqui 1.000.000 segundos pra olhar o PC', 1_000_000],
  ])('does not shorten Brazilian thousands separators in %s', (text, delaySeconds) => {
    expect(parseRelativeReminderRequest(text)).toEqual({
      kind: 'valid',
      title: 'olhar o PC',
      delaySeconds,
    });
  });

  it.each([
    'Me lembre daqui 20 segundos de olhar o PC, mas não agende ainda',
    'Me lembre daqui 20 segundos de olhar o PC mas nao agende ainda',
    'Me lembre daqui 20 segundos de olhar o PC e não mande o aviso',
    'Me lembre daqui 20 segundos de olhar o PC e crie uma tarefa para isso',
    'Me lembre daqui 20 segundos de olhar o PC e adicione uma tarefa para isso',
    'Me lembre daqui 20 segundos de olhar o PC e salve uma nota sobre isso',
    'Me lembre daqui 20 segundos de olhar o PC e também registre uma entrada',
    'Me lembre daqui 20 segundos de olhar o PC; registre uma entrada',
  ])('does not schedule a negated or compound instruction: %s', (text) => {
    expect(parseRelativeReminderRequest(text)).toBeNull();
  });

  it.each(['não esquecer o PC', 'registrar uma entrada', 'criar uma tarefa'])(
    'keeps the legitimate single reminder subject %s',
    (title) => {
      expect(parseRelativeReminderRequest(`Me lembre daqui 20 segundos de ${title}`)).toEqual({
        kind: 'valid',
        title,
        delaySeconds: 20,
      });
    }
  );

  it.each([
    'Me lembre em 0 segundos de olhar o PC',
    'Me lembre em -1 segundo de olhar o PC',
    'Me lembre em 0,5 segundo de olhar o PC',
    'Me lembre em 31622401 segundos de olhar o PC',
    'Me lembre em 99999999999999999999999999999999999999 horas de olhar o PC',
    'Me lembre em 1 minuto e -20 segundos de olhar o PC',
    'Me lembre em 0.500 segundos de olhar o PC',
    'Me lembre em 1.234.56 segundos de olhar o PC',
  ])('identifies an invalid duration without falling back to an invented deadline: %s', (text) => {
    expect(parseRelativeReminderRequest(text)).toMatchObject({ kind: 'invalid' });
  });

  it.each([
    'Me lembre em 20 segundos',
    'Me lembre em 20 segundos de',
    'Daqui 20 segundos',
    'Não me lembre em 20 segundos de olhar o PC',
    'Você consegue me lembrar em 20 segundos de olhar o PC?',
    'Se eu pedir me lembre em 20 segundos de olhar o PC',
    'Explique "Me lembre daqui 20 segundos pra vê o pc"',
    'Me lembre em 1 ou 2 minutos de olhar o PC',
    'Me lembre em 20 segundos ou 1 minuto de olhar o PC',
    'Me lembre em 20 milissegundos de olhar o PC',
    'Me lembre em 20ms de olhar o PC',
    'Me lembre em 1 mês de olhar o PC',
    'Me lembre em 1 minuto às 14h de olhar o PC',
    'Me lembre em 1 minuto e 1 minuto de olhar o PC',
    'Me lembre em 20 segundos de olhar o PC e me lembre em 30 segundos de ligar a luz',
    'Me lembre em 20 segundos de olhar o PC e daqui 30 segundos de ligar a luz',
    'Me lembre em 20 segundos de olhar o PC e registre que ganhei 1 real',
  ])('leaves missing context or ambiguous instructions for the agent: %s', (text) => {
    expect(parseRelativeReminderRequest(text)).toBeNull();
  });

  it('does not invent a title from punctuation or truncate an overlong subject', () => {
    expect(parseRelativeReminderRequest('Me lembre em 20 segundos de !!!')).toMatchObject({
      kind: 'invalid',
    });
    expect(
      parseRelativeReminderRequest(`Me lembre em 20 segundos de ${'a'.repeat(161)}`)
    ).toMatchObject({ kind: 'invalid' });
  });
});
