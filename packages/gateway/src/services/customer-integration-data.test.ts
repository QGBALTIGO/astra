import { describe, it, expect } from 'vitest';
import { integrationItems, unwrapIntegrationResult } from './customer-integration-data.js';
const tz = 'America/Cuiaba';
describe('real provider data shapes', () => {
  it('keeps Google local event time in the client zone', () => {
    const result = integrationItems(
      'googlecalendar',
      {
        items: [
          {
            id: 'event',
            summary: 'Café',
            start: { dateTime: '2026-11-14T09:00:00' },
            end: { dateTime: '2026-11-14T10:00:00' },
          },
        ],
      },
      tz
    );
    expect(result.items[0]).toMatchObject({
      title: 'Café',
      start: '2026-11-14T13:00:00.000Z',
      end: '2026-11-14T14:00:00.000Z',
    });
  });
  it('retains explicit provider UTC offsets', () =>
    expect(
      integrationItems(
        'googlecalendar',
        {
          items: [{ id: 'a', summary: 'Visita', start: { dateTime: '2026-11-14T09:00:00-03:00' } }],
        },
        tz
      ).items[0]?.start
    ).toBe('2026-11-14T12:00:00.000Z'));
  it('preserves all-day dates in the local day', () =>
    expect(
      integrationItems(
        'googlecalendar',
        { items: [{ id: 'a', summary: 'Folga', start: { date: '2026-11-14' } }] },
        tz
      ).items[0]
    ).toMatchObject({ allDay: true, start: '2026-11-14T04:00:00.000Z' }));
  it('accepts cancellation tombstones without a title', () =>
    expect(
      integrationItems('googlecalendar', { items: [{ id: 'a', status: 'cancelled' }] }, tz).items[0]
        ?.status
    ).toBe('cancelled'));
  it('extracts Gmail subjects from MIME headers', () =>
    expect(
      integrationItems(
        'gmail',
        {
          messages: [
            { id: 'mail', payload: { headers: [{ name: 'Subject', value: 'Reunião de amanhã' }] } },
          ],
        },
        tz
      ).items[0]?.title
    ).toBe('Reunião de amanhã'));
  it('reads Drive metadata without downloading files', () =>
    expect(
      integrationItems(
        'googledrive',
        { files: [{ id: 'file', name: 'Lista', webViewLink: 'https://drive.google.com/test' }] },
        tz
      ).items[0]?.kind
    ).toBe('file'));
  it('uses stable sheet row IDs scoped to resource/range', () => {
    const first = integrationItems(
      'googlesheets',
      {
        values: [
          ['Café', 8],
          ['Pizza', 30],
        ],
      },
      tz,
      'sheet-a:A1:B2'
    );
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.title).toBe('Café · 8');
    expect(first.items[0]?.id).not.toBe(
      integrationItems('googlesheets', { values: [['Café', 8]] }, tz, 'sheet-b:A1:B2').items[0]?.id
    );
  });
  it('extracts Notion rich title properties', () =>
    expect(
      integrationItems(
        'notion',
        {
          results: [
            {
              id: 'page',
              properties: { Name: { type: 'title', title: [{ plain_text: 'Ideias da loja' }] } },
            },
          ],
        },
        tz
      ).items[0]?.title
    ).toBe('Ideias da loja'));
  it('reads Todoist due dates and completion', () =>
    expect(
      integrationItems(
        'todoist',
        {
          results: [
            { id: 'task', content: 'Comprar pão', due: { date: '2026-11-14' }, is_completed: true },
          ],
        },
        tz
      ).items[0]
    ).toMatchObject({ kind: 'task', status: 'completed', due: '2026-11-14T04:00:00.000Z' }));
  it('distinguishes Trello cards from boards', () =>
    expect(
      integrationItems(
        'trello',
        [{ id: 'card', name: 'Estoque', idBoard: 'board', closed: false }],
        tz
      ).items[0]?.kind
    ).toBe('task'));
  it('marks provider pagination as partial', () =>
    expect(
      integrationItems('googlecalendar', { items: [], nextPageToken: 'next' }, tz).partial
    ).toBe(true));
  it('does not call unsupported payloads empty success', () =>
    expect(() => integrationItems('notion', { results: [{ unexpected: true }] }, tz)).toThrow());
  it.each([
    { successful: false },
    { data: { error: 'failure' } },
    { success: false },
    { data: { execution_status: 'queued' } },
  ])('refuses unconfirmed provider results %#', (row) =>
    expect(() => unwrapIntegrationResult(row)).toThrow()
  );
});
