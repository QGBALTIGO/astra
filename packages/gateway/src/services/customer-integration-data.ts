import { customerDayStart, customerLocalDateTime } from './customer-date.js';
import { createHash } from 'node:crypto';
import type { IntegrationItem } from '../db/repositories/customer-integrations.js';
import type { AstraConnectedAppSlug } from '../config/astra-connected-apps.js';

type Row = Record<string, unknown>;
const plain = (v: unknown) =>
  typeof v === 'string'
    ? v
        .replace(/<[^>]*>|[\r\n*_`]/g, ' ')
        .trim()
        .slice(0, 300)
    : '';
function timestamp(v: unknown, timeZone: string): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v)
      ? customerDayStart(v, timeZone)
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(v)
        ? customerLocalDateTime(v, timeZone)
        : new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  } catch {
    return undefined;
  }
}
export function unwrapIntegrationResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') throw new Error('Provider response unavailable');
  const row = value as Row;
  if (row.successful === false || row.success === false || row.error)
    throw new Error('Provider response unsuccessful');
  const data = row.data ?? row.result ?? row;
  if (data && typeof data === 'object') {
    const nested = data as Row;
    if (
      nested.successful === false ||
      nested.success === false ||
      nested.error ||
      ['queued', 'processing', 'pending'].includes(String(nested.execution_status ?? ''))
    )
      throw new Error('Provider result not confirmed');
  }
  return data;
}
export function integrationItems(
  app: AstraConnectedAppSlug,
  value: unknown,
  timeZone: string,
  resource = ''
): { items: IntegrationItem[]; partial: boolean } {
  function rich(input: unknown): string {
    if (typeof input === 'string') return plain(input);
    if (Array.isArray(input)) return input.map(rich).join('');
    if (input && typeof input === 'object') {
      const row = input as Row;
      return rich(row.plain_text ?? (row.text as Row | undefined)?.content ?? row.title);
    }
    return '';
  }
  function list(input: unknown, depth = 0): unknown[] | null {
    if (depth > 5 || !input) return null;
    if (Array.isArray(input)) return input;
    if (typeof input !== 'object') return null;
    const r = input as Row;
    for (const key of [
      'items',
      'events',
      'messages',
      'files',
      'spreadsheets',
      'tasks',
      'results',
      'cards',
      'boards',
      'values',
    ])
      if (Array.isArray(r[key])) return r[key] as unknown[];
    if (typeof r.id === 'string') return [r];
    for (const key of ['data', 'result', 'response_data', 'response']) {
      const found = list(r[key], depth + 1);
      if (found) return found;
    }
    if (app === 'googlesheets' && typeof r.spreadsheetId === 'string') return [r];
    return null;
  }
  const source = list(value);
  if (!source) throw new Error('Provider returned an unsupported data format');
  const items: IntegrationItem[] = [];
  for (const [index, candidate] of source.slice(0, 50).entries()) {
    if (app === 'googlesheets' && Array.isArray(candidate)) {
      if (!resource) throw new Error('Spreadsheet resource identity is required');
      const title = candidate
        .slice(0, 20)
        .map((v) => plain(typeof v === 'number' ? String(v) : v))
        .filter(Boolean)
        .join(' · ');
      if (title)
        items.push({
          id: createHash('sha256')
            .update(resource + ':' + index)
            .digest('hex'),
          title,
          kind: 'sheet',
        });
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as Row;
    const id =
      typeof row.id === 'string'
        ? row.id
        : typeof row.id === 'number'
          ? String(row.id)
          : String(row.fileId ?? row.spreadsheetId ?? row.messageId ?? '');
    if (!id || id.length > 250) continue;
    const start = row.start && typeof row.start === 'object' ? (row.start as Row) : {};
    const end = row.end && typeof row.end === 'object' ? (row.end as Row) : {};
    const due = row.due && typeof row.due === 'object' ? (row.due as Row) : {};
    const headers = ((row.payload as Row | undefined)?.headers ?? row.headers) as Row[] | undefined;
    const subject = Array.isArray(headers)
      ? headers.find((h) => String(h.name).toLowerCase() === 'subject')?.value
      : undefined;
    const properties = row.properties as Row | undefined;
    const notionTitle = properties ? Object.values(properties).map(rich).find(Boolean) : '';
    const title =
      rich(
        row.summary ??
          row.title ??
          row.content ??
          row.name ??
          row.subject ??
          subject ??
          (row.properties as Row | undefined)?.title ??
          (row.spreadsheetId ? (row.properties as Row | undefined)?.title : undefined) ??
          row.snippet
      ) ||
      notionTitle ||
      (app === 'gmail'
        ? 'Mensagem sem assunto'
        : row.status === 'cancelled'
          ? 'Compromisso cancelado'
          : '');
    if (!title) continue;
    const kind: IntegrationItem['kind'] =
      app === 'googlecalendar'
        ? 'event'
        : app === 'todoist'
          ? 'task'
          : app === 'trello'
            ? row.idBoard
              ? 'task'
              : 'board'
            : app === 'gmail'
              ? 'message'
              : app === 'googledrive'
                ? 'file'
                : app === 'notion'
                  ? 'page'
                  : 'sheet';
    const status =
      typeof row.status === 'string'
        ? row.status
        : row.is_completed === true || row.checked === true || row.closed === true
          ? 'completed'
          : 'pending';
    const url = plain(row.htmlLink ?? row.webViewLink ?? row.url);
    items.push({
      id,
      title,
      kind,
      status,
      start: timestamp(start.dateTime ?? start.date ?? row.start_time, timeZone),
      end: timestamp(end.dateTime ?? end.date ?? row.end_time, timeZone),
      allDay: !!start.date,
      due: timestamp(due.datetime ?? due.date ?? row.due, timeZone),
      ...(url.startsWith('https://') ? { url } : {}),
    });
  }
  if (source.length && items.length === 0)
    throw new Error('Provider returned items in an unsupported format');
  return {
    items,
    partial:
      source.length >= 50 ||
      !!(
        value &&
        typeof value === 'object' &&
        ((value as Row).nextPageToken || (value as Row).next_cursor || (value as Row).has_more)
      ),
  };
}
