import type { ChannelToolReceipt } from './response-safety.js';
import { channelOperations } from './receipt-state.js';
import { isChannelEmailRequest } from './email-intent.js';
import { formatAstraMessage } from './response-presentation.js';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const plain = (value: unknown, max = 180): string =>
  typeof value === 'string'
    ? value
        .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*?)?\s*\/?>|[\r\n*_`\u0000-\u001f]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

/** A read can be an intermediate step of a write; never finish those requests here. */
export function isEmailReadOnlyRequest(text: string): boolean {
  if (!isChannelEmailRequest(text)) return false;
  const input = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return !/\b(?:envie|enviar|mande|mandar|responda|responder|encaminhe|encaminhar|registre|registrar|anote|anotar|crie|criar|salve|salvar|agende|agendar|marque|marcar|exclua|excluir|apague|apagar|remova|remover|arquive|arquivar|altere|alterar|atualize|atualizar|pague|pagar)\b/.test(
    input
  );
}

/** Metadata is enough for a simple list, never for reading or summarizing a body. */
export function isSimpleEmailListRequest(text: string): boolean {
  if (!isEmailReadOnlyRequest(text)) return false;
  const input = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\be[-\u2010-\u2015]?mails\b/g, 'emails')
    .trim()
    .replace(/^astra[,!\s]+/, '')
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // This shortcut is optional: recognize only a complete list request, rather
  // than trying to enumerate every way to ask for bodies, attachments or actions.
  return /^(?:(?:me )?(?:mostr[ae]|list[ae])|quais(?: (?:sao|foram))?) (?:(?:(?:os|meus|os meus) )?(?:(?:ultimos|recentes|novos) )?(?:emails|gmail|gmails|gmais)(?: (?:mais )?importantes| recentes| recebidos)?(?: que (?:eu )?recebi)?|(?:a |minha )?caixa de entrada)$/.test(
    input
  );
}

function unwrap(value: unknown): Record<string, unknown> | null {
  for (let depth = 0; depth < 5; depth++) {
    const entry = object(value);
    if (
      !entry ||
      entry.success === false ||
      entry.successful === false ||
      entry.isError === true ||
      entry.error
    )
      return null;
    if (!Object.hasOwn(entry, 'result')) return entry;
    value = entry.result;
  }
  return null;
}

function messages(
  value: unknown,
  depth = 0
): { rows: unknown[]; list: boolean; more: boolean } | null {
  if (depth > 5) return null;
  if (Array.isArray(value)) return { rows: value, list: true, more: false };
  const entry = object(value);
  if (
    !entry ||
    entry.success === false ||
    entry.successful === false ||
    entry.isError === true ||
    entry.error
  )
    return null;
  const more = Boolean(entry.nextPageToken || entry.next_page_token || entry.has_more);
  for (const key of ['messages', 'emails', 'items'])
    if (Array.isArray(entry[key])) return { rows: entry[key], list: true, more };
  if (typeof entry.id === 'string' || typeof entry.messageId === 'string')
    return { rows: [entry], list: false, more };
  for (const key of ['data', 'result', 'response_data', 'response']) {
    const nested = messages(entry[key], depth + 1);
    if (nested) return { ...nested, more: more || nested.more };
  }
  return null;
}

function header(row: Record<string, unknown>, name: string): unknown {
  const headers = object(row.payload)?.headers ?? row.headers;
  return Array.isArray(headers)
    ? headers.map(object).find((item) => String(item?.name).toLowerCase() === name)?.value
    : undefined;
}

function sender(value: unknown): string {
  const mailbox = object(value);
  if (!mailbox) return plain(value);
  return [plain(mailbox.name), plain(mailbox.email ?? mailbox.address)].filter(Boolean).join(' · ');
}

function receivedAt(row: Record<string, unknown>, timeZone: string): string | undefined {
  const raw =
    row.internalDate ?? row.receivedAt ?? row.messageTimestamp ?? row.date ?? header(row, 'date');
  const milliseconds =
    row.internalDate !== undefined && /^\d{12,16}$/.test(String(raw))
      ? Number(raw)
      : typeof raw === 'string' && /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)\b/i.test(raw)
        ? Date.parse(raw)
        : NaN;
  if (!Number.isFinite(milliseconds)) return;
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(milliseconds));
  } catch {
    return;
  }
}

/** Present only metadata actually returned by Gmail; never infer importance or account totals. */
export function verifiedEmailReadReply(
  receipts: readonly ChannelToolReceipt[],
  context: { requestText?: string; timeZone?: string } = {},
  completeListOnly = false
): string | undefined {
  if (!isEmailReadOnlyRequest(context.requestText ?? '')) return;
  if (completeListOnly && !isSimpleEmailListRequest(context.requestText ?? '')) return;
  const operations = channelOperations(receipts);
  const allowed = new Set([
    'connected_apps_status',
    'search_connected_actions',
    'run_connected_action',
  ]);
  const name = (receipt: ChannelToolReceipt) =>
    receipt.name.replace(/__/g, '.').replace(/^core\./, '');
  if (operations.some((receipt) => !allowed.has(name(receipt)))) return;
  const reads = operations.filter((receipt) => name(receipt) === 'run_connected_action');
  if (!reads.length) return;
  const entries = new Map<string, Record<string, unknown>>();
  const pendingIds = new Set<string>();
  const scopeIds = new Set<string>();
  let readCount = 0,
    invalidRows = 0,
    more = false,
    lastWasList = false,
    hasList = false;
  for (const receipt of reads) {
    if (receipt.isError) return;
    let envelope: Record<string, unknown> | null;
    try {
      envelope = unwrap(JSON.parse(receipt.content));
    } catch {
      return;
    }
    if (envelope?.source !== 'Gmail' || !envelope.untrustedExternalData) return;
    const found = messages(envelope.untrustedExternalData);
    if (!found) return;
    readCount++;
    lastWasList = found.list;
    if (found.list) {
      // A later list is a new query/page, not evidence that earlier rows still match.
      entries.clear();
      pendingIds.clear();
      scopeIds.clear();
      invalidRows = 0;
      hasList = true;
      more = found.more;
    }
    for (const raw of found.rows) {
      const row = object(raw);
      const id = row?.id ?? row?.messageId;
      const subject = row?.subject ?? (row ? header(row, 'subject') : undefined);
      if (!row || typeof id !== 'string') {
        invalidRows++;
        continue;
      }
      if (found.list) scopeIds.add(id);
      else if (hasList && !scopeIds.has(id)) continue;
      if (typeof subject !== 'string') {
        if (!entries.has(id)) pendingIds.add(id);
        continue;
      }
      pendingIds.delete(id);
      entries.set(id, { ...row, subject });
    }
  }
  const unresolved = invalidRows + pendingIds.size;
  if (completeListOnly && (!lastWasList || unresolved > 0)) return;
  if (!entries.size)
    return unresolved === 0 && readCount > 0
      ? formatAstraMessage('📬 E-mails encontrados', [], 'Nenhum e-mail encontrado nesta consulta.')
      : undefined;
  const timeZone = context.timeZone ?? 'UTC';
  const lines = [...entries.values()].map((row) => {
    const from = sender(row.from ?? row.sender ?? header(row, 'from'));
    const when = receivedAt(row, timeZone);
    return formatAstraMessage('📩 ' + (plain(row.subject) || '(sem assunto)'), [
      ...(from ? [{ label: 'De', value: from }] : []),
      ...(when ? [{ label: 'Recebido em', value: when }] : []),
    ]);
  });
  return (
    '*E-mails encontrados*\n\n' +
    lines.join('\n\n') +
    `\n\n${entries.size} e-mail${entries.size === 1 ? '' : 's'} com detalhes disponíveis nesta consulta.` +
    (more ? '\nHá mais resultados além desta página.' : '') +
    (unresolved ? '\nAlguns resultados ainda não têm assunto ou remetente disponíveis.' : '') +
    (!isSimpleEmailListRequest(context.requestText ?? '')
      ? '\nConsegui consultar estes dados, mas não concluí a leitura ou análise solicitada.'
      : '')
  );
}
