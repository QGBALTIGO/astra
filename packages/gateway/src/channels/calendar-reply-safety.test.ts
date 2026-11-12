import { describe, expect, it } from 'vitest';
import {
  CHANNEL_UNVERIFIED_REPLY,
  safeChannelResponse,
  type ChannelToolReceipt,
} from './response-safety.js';

const requestText =
  'Marca na minha agenda para amanhã, sexta-feira, 13 de novembro, das 15h às 15h30 de Cuiabá: Revisão do orçamento Limoeiro.';
const context = { timeZone: 'America/Cuiaba', requestText };
const event = {
  id: 'private-calendar-12345678',
  title: 'Revisão do orçamento Limoeiro',
  startTime: '2026-11-13T19:00:00.000Z',
  endTime: '2026-11-13T19:30:00.000Z',
  timezone: 'UTC',
};
const args = { title: event.title, startTime: event.startTime };
function receipt(
  name: string,
  data: unknown,
  params: unknown = {},
  isError = false
): ChannelToolReceipt {
  return {
    name: 'core.' + name,
    content: JSON.stringify(data),
    arguments: JSON.stringify(params),
    isError,
  };
}
const added = receipt('add_calendar_event', { success: true, result: { event } }, args);
const updated = receipt(
  'update_calendar_event',
  { success: true, result: event },
  { eventId: event.id }
);
const deleted = receipt(
  'delete_calendar_event',
  { success: true, result: { message: 'Event deleted.' } },
  { eventId: event.id }
);
const failure = (name: string, params: unknown) =>
  receipt(name, { success: false, error: 'test failure' }, params, true);
const reminder = receipt('schedule_channel_reminder', {
  result: { title: 'Lembrete separado', horarioLocal: '13/11/2026, 14:50', status: 'pending' },
});

describe('calendar confirmations at the channel boundary', () => {
  it.each([
    'Agendei a revisão para amanhã às 22h.',
    'Compromisso criado para outro dia.',
    'Pronto!',
  ])('renders the persisted row for %s', (prose) => {
    const reply = safeChannelResponse(prose, [added], context);
    expect(reply).toContain('Compromisso agendado');
    expect(reply).toContain(event.title);
    expect(reply).toContain('13/11/2026, 15:00');
    expect(reply).toContain('13/11/2026, 15:30');
    expect(reply).toContain('America/Cuiaba');
    expect(reply).not.toMatch(/outro dia|22h|private-calendar|avisar|lembrete|sem confirmação/i);
  });
  it.each([
    'Agendei a revisão para amanhã às 15h.',
    'Compromisso criado para amanhã.',
    'Pronto!',
    'Marquei na sua agenda.',
  ])('rejects a claim without a write for %s', (prose) => {
    expect(safeChannelResponse(prose, [], context)).toBe(CHANNEL_UNVERIFIED_REPLY);
    expect(safeChannelResponse(prose, [failure('add_calendar_event', args)], context)).toContain(
      'ainda não está confirmada'
    );
  });
  it.each([
    {},
    { success: true },
    { success: true, result: { event: { title: 'Sem identidade', startTime: event.startTime } } },
    { success: true, result: { event: { ...event, startTime: 'invalid' } } },
  ])('requires an actual saved row', (data) => {
    expect(
      safeChannelResponse('Agendei a reunião.', [receipt('add_calendar_event', data)], context)
    ).toBe(CHANNEL_UNVERIFIED_REPLY);
  });
  it('honors a nested failure even when the outer envelope succeeded', () => {
    const failed = receipt('add_calendar_event', {
      success: true,
      result: { success: false, event },
    });
    expect(safeChannelResponse('Agendei a reunião.', [failed], context)).toContain(
      'ainda não está confirmada'
    );
  });
  it('does not let a reminder authorize a calendar write or vice versa', () => {
    expect(safeChannelResponse('Compromisso criado.', [reminder], context)).toContain(
      'demais partes'
    );
    const reply = safeChannelResponse(
      'Agendei o compromisso. Vou te avisar por aqui.',
      [added],
      context
    );
    expect(reply).toContain(event.title);
    expect(reply).toContain('demais partes');
    expect(reply).not.toContain('Vou te avisar');
    expect(safeChannelResponse('Agendei o lembrete.', [added], context)).toContain('demais partes');
    expect(safeChannelResponse('Agendei o compromisso e um lembrete.', [added], context)).toContain(
      'demais partes'
    );
    const both = safeChannelResponse(
      'Agendei seu compromisso. Vou te avisar.',
      [added, reminder],
      context
    );
    expect(both).toContain(event.title);
    expect(both).toContain('Lembrete separado');
    expect(both).not.toContain('demais partes');
  });
  it('accepts an identified successful retry and still reports distinct or opaque failures', () => {
    expect(
      safeChannelResponse(
        'Agendei a revisão.',
        [failure('add_calendar_event', args), added],
        context
      )
    ).not.toMatch(/duplicidade|sem confirmação/);
    for (const failed of [
      failure('add_calendar_event', { title: 'Outra' }),
      failure('add_calendar_event', {}),
      failure('schedule_channel_reminder', {}),
    ]) {
      const reply = safeChannelResponse(
        'Pronto, só não consegui confirmar o restante.',
        [failed, added],
        context
      );
      expect(reply).toContain(event.title);
      expect(reply).toMatch(/ainda não tenho confirmação/i);
      expect(reply).not.toContain('Pronto');
    }
  });
  it('shows distinct events and the latest state of each event', () => {
    const another = receipt('add_calendar_event', {
      event: { ...event, id: 'other-calendar-12345', title: 'Visita' },
    });
    const reply = safeChannelResponse('Pronto!', [added, added, another, updated], context);
    expect(reply.match(/orçamento Limoeiro/g)).toHaveLength(1);
    expect(reply).toContain('Compromisso atualizado');
    expect(reply).toContain('Visita');
    expect(safeChannelResponse('Pronto!', [added, deleted], context)).toBe(
      '🗑️ *Compromisso excluído*'
    );
    expect(safeChannelResponse('Cancelei o compromisso.', [added], context)).toContain(
      'demais partes'
    );
    expect(safeChannelResponse('Remarquei o compromisso.', [added], context)).toContain(
      'demais partes'
    );
    expect(
      safeChannelResponse(
        'Compromisso cancelado.',
        [receipt('delete_calendar_event', { success: true })],
        context
      )
    ).toBe(CHANNEL_UNVERIFIED_REPLY);
  });
  it('formats a persisted batch, handles all-day dates and daylight saving', () => {
    const other = {
      ...event,
      id: 'winter-12345678',
      title: 'Férias',
      startTime: '2026-12-02T00:00:00Z',
      endTime: undefined,
      allDay: true,
    };
    const batch = receipt('batch_add_calendar_events', { events: [event, other], count: 2 });
    const reply = safeChannelResponse('Agendei os compromissos.', [batch], {
      timeZone: 'America/New_York',
    });
    expect(reply).toContain('13/11/2026, 14:00');
    expect(reply).toContain('02/12/2026');
    expect(reply).toContain('Dia inteiro');
    expect(safeChannelResponse('Agendei a reunião.', [added])).toContain('19:00');
    const fallback = safeChannelResponse('Agendei a reunião.', [added], {
      timeZone: 'Invalid/Test',
    });
    expect(fallback).toContain('19:00');
    expect(fallback).toContain('UTC');
  });
  it('preserves a list heading and negative statements', () => {
    const list = 'Compromissos agendados:\nDentista amanhã.';
    expect(safeChannelResponse(list, [receipt('list_calendar_events', { events: [] })])).toBe(list);
    const read = receipt('list_calendar_events', { events: [event] });
    const status = 'Você tem uma consulta marcada para amanhã. Sua reunião está agendada às 15h.';
    expect(safeChannelResponse(status, [read], { requestText: 'O que tenho na agenda?' })).toBe(
      status
    );
    expect(safeChannelResponse(status + ' Compromisso criado para sexta.', [read])).toBe(
      CHANNEL_UNVERIFIED_REPLY
    );
    expect(safeChannelResponse('O seu compromisso está agendado.', [read], context)).toBe(
      CHANNEL_UNVERIFIED_REPLY
    );
    const suggestion = 'Ter um compromisso agendado ajuda a organizar a semana.';
    expect(safeChannelResponse(suggestion, [])).toBe(suggestion);
    for (const text of [
      'Não marquei a reunião.',
      'A reunião não foi marcada.',
      'Nenhum compromisso foi agendado.',
    ])
      expect(safeChannelResponse(text, [])).toBe(text);
    expect(safeChannelResponse('Pronto!', [], { requestText: 'Como funciona a agenda?' })).toBe(
      'Pronto!'
    );
  });
});
