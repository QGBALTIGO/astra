import { describe, expect, it } from 'vitest';
import { parseChannelCalendarEvent } from './calendar-mutation.js';

const when = new Date('2026-11-12T23:00:00Z');
const literal =
  'Marca na minha agenda para amanhã, sexta-feira, 13 de novembro, das 15h às 15h30 de Cuiabá: Revisão do orçamento Limoeiro.';
const slot = (
  date: string,
  from = '15h',
  end = '15:30',
  zone = 'America/Cuiaba',
  title = 'Revisão do orçamento'
) =>
  'Marque na minha agenda para ' +
  date +
  ', das ' +
  from +
  ' às ' +
  end +
  ' no fuso ' +
  zone +
  ': ' +
  title +
  '.';

describe('Portuguese personal calendar command', () => {
  it('resolves A03 with all three date references in the explicitly requested zone', () => {
    expect(parseChannelCalendarEvent(literal, when)).toEqual({
      action: 'create',
      title: 'Revisão do orçamento Limoeiro',
      timezone: 'America/Cuiaba',
      startTime: '2026-11-13T19:00:00.000Z',
      endTime: '2026-11-13T19:30:00.000Z',
    });
  });
  it.each([
    'Preciso mudar a Revisão do orçamento Acácia de sexta para 16h, mantendo meia hora. Se encontrar esse evento, remarca o mesmo; se não encontrar, me avisa.',
    'Remarque a Revisão do orçamento Acácia de sexta-feira para as 16:00, mantendo 30 minutos.',
    'Reagende o evento “Revisão do orçamento Acácia” de 13/11/2026 pra 16h.',
    'Preciso mudar o horário da Revisão do orçamento Acácia na sexta para 16h.',
    'Mude a reunião da sexta para 16h de Cuiabá, mantendo a mesma duração.',
  ])('recognizes a move of an existing event: %s', (text) => {
    expect(parseChannelCalendarEvent(text, when)).toMatchObject({
      action: 'move',
      localClock: '16:00',
    });
  });
  it.each([
    'Não remarque a reunião de sexta para 16h.',
    'Se eu disser “remarque a reunião de sexta para 16h”, o que acontece?',
    'Remarque a reunião de sexta para 16h e me avise em uma hora.',
    'Remarque a reunião de sexta para 16h. Se não encontrar, crie outra.',
    'Remarque a reunião de sexta para 16h?',
    'Remarque a reunião de sexta para 25h.',
    'Remarque a reunião para 16h.',
  ])('never executes a hypothetical, forbidden, compound or invalid move: %s', (text) => {
    expect(parseChannelCalendarEvent(text, when)).toHaveProperty('reply');
  });
  it('requires a full title, absolute day and named time zone before deletion', () => {
    const del =
      'Exclua da minha agenda o compromisso de 13/11/2026 no fuso de Cuiabá: Revisão do orçamento Limoeiro.';
    expect(parseChannelCalendarEvent(del, when)).toEqual({
      action: 'delete',
      title: 'Revisão do orçamento Limoeiro',
      day: '2026-11-13',
      timezone: 'America/Cuiaba',
    });
    for (const text of [
      del + '?',
      del.replace('13/11/2026', 'amanhã'),
      'Será que você poderia excluir da minha agenda o compromisso de amanhã?',
      del.replace('Limoeiro', 'Limoeiro e pague a conta'),
    ])
      expect(parseChannelCalendarEvent(text, when)).toHaveProperty('reply');
  });
  it.each([
    '13/11/2026',
    '13 de novembro de 2026',
    'amanhã',
    'amanhã, sexta-feira',
    'sexta-feira, 13 de novembro de 2026',
  ])('accepts an unambiguous date %s', (date) => {
    expect(parseChannelCalendarEvent(slot(date), when)).toMatchObject({
      startTime: '2026-11-13T19:00:00.000Z',
    });
  });
  it('uses the original message date across the local midnight and new year', () => {
    const t = new Date('2027-01-01T02:00:00Z');
    expect(parseChannelCalendarEvent(slot('amanhã, 1 de janeiro'), t)).toMatchObject({
      startTime: '2027-01-01T19:00:00.000Z',
    });
  });
  it.each([
    slot('amanhã, 14 de novembro'),
    slot('amanhã, sábado, 13 de novembro'),
    slot('sexta-feira'),
    slot('13 de novembro'),
    slot('31/02/2027'),
    slot('13/11/2026', '24h'),
    slot('13/11/2026', '15h', '15h'),
    slot('13/11/2026', '16h'),
    slot('13/11/2026', '15:65'),
    slot('13/11/2026', '15h', '16h', 'ZZZ'),
    slot('14/03/2027', '02h', '03h', 'America/New_York'),
    slot('07/11/2027', '01h', '02h', 'America/New_York'),
    slot('13/11/2026', '15h', '16h', 'Cuiabá', 'Revisão e me avise'),
    literal + ' E cancele a reunião anterior.',
    literal.replace('Cuiabá', 'Cuiabá ou Brasília'),
  ])('asks for details without creating for %s', (cmd) => {
    expect(parseChannelCalendarEvent(cmd, when)).toHaveProperty('reply');
  });
  it.each([
    'Não ' + literal,
    'Se eu disser “' + literal + '”, o que você faria?',
    literal + '?',
    'Imagine que eu diga ' + literal,
  ])('does not execute a negative, question or hypothetical %s', (cmd) => {
    expect(parseChannelCalendarEvent(cmd, when)).toHaveProperty('reply');
  });
  it.each([
    'O que tenho na agenda?',
    'Me lembre em 2 horas de revisar o orçamento',
    'Quero remarcar minha próxima consulta.',
  ])('keeps unrelated intents with existing handlers', (cmd) => {
    expect(parseChannelCalendarEvent(cmd, when)).toBeNull();
  });
});
