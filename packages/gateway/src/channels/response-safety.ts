/** Final channel boundary: model text is not proof of a database write. */
import { stripInternalTags } from './normalizers/base.js';

export interface ChannelToolReceipt {
  name: string;
  arguments: string;
  content: string;
  isError: boolean;
}
const protocol =
  /<\/?(?:tool_call|tool_calls|function_call|function_calls|arg_key|arg_value)(?:\s|>)|["'](?:tool_name|tool_calls|function_call)["']\s*:/i;
const normalizeName = (value: string) => value.replace(/__/g, '.').replace(/^core\./, '');
const INTERNAL_UUID =
  /\b[0-9a-f]{8}[-–—][0-9a-f]{4}[-–—][0-9a-f]{4}[-–—][0-9a-f]{4}[-–—][0-9a-f]{12}\b/gi;
const INTERNAL_TOOL =
  /\b(?:core(?:\.|__)[a-z_]+|use_tool|batch_use_tool|search_tools|get_tool_help|schedule_channel_reminder|reschedule_channel_reminder|record_transaction|update_transaction|delete_transaction)\b/i;
function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** IDs remain available to tools for edits; they are never useful confirmation text. */
function internalIds(receipts: ChannelToolReceipt[]): Set<string> {
  const ids = new Set<string>();
  function visit(value: unknown, depth: number): void {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(?:id|uuid|\w+_id|\w+Id|dedupeKey)$/i.test(key) &&
        typeof entry === 'string' &&
        entry.length >= 8
      ) {
        ids.add(entry);
      } else if (typeof entry === 'object') {
        visit(entry, depth + 1);
      }
    }
  }
  for (const receipt of receipts) visit(json(receipt.content), 0);
  return ids;
}

function cleanIdentifiers(text: string, ids: Set<string>): string {
  let clean = text;
  // Include labelled IDs from earlier turns. A UUID in a reminder's subject can
  // be a legitimate Pix key: only an adjacent internal-ID label proves otherwise.
  const labelledId = new RegExp(
    `\\b(?:ID|UUID|identificador|refer[eê]ncia|c[oó]digo)(?:\\s+(?:interno|d[oa]|lembrete|registro|tarefa|lan[çc]amento|transa[çc][ãa]o|é|e))*\\s*[:#=-]?\\s*[\x60*]*(${INTERNAL_UUID.source}|exp_ui_[a-f0-9]{64})`,
    'gi'
  );
  for (const match of text.matchAll(labelledId)) ids.add(match[1]!);
  if (ids.size === 0) return text;
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean
      .replace(
        new RegExp(
          `\\s*\\(\\s*(?:(?:ID|UUID|identificador)(?:\\s+interno)?\\s*[:#=]?\\s*)?[\x60*]*${escaped}[\x60*]*\\s*\\)`,
          'gi'
        ),
        ''
      )
      .replace(
        new RegExp(
          `(?:\\b(?:ID|UUID|identificador)(?:\\s+interno)?\\s*[:#=]?\\s*)?[\x60*]*${escaped}[\x60*]*`,
          'gi'
        ),
        ''
      );
  }
  return clean
    .replace(
      /^[ \t]*(?:O[ \t]+)?(?:ID|UUID|identificador|refer[eê]ncia|c[oó]digo)(?:[ \t]+(?:interno|d[oa]|lembrete|registro|tarefa|lan[çc]amento|é|e))*[ \t]*[:#=.]?[ \t]*$/gim,
      ''
    )
    .replace(/[ \t]+([,.!;])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function reminderConfirmation(receipts: ChannelToolReceipt[]): string | null {
  const confirmed = successfulChannelTools(receipts);
  const matches = receipts.filter((receipt) => {
    const name = normalizeName(receipt.name);
    return (
      confirmed.has(name) &&
      /^(?:schedule|reschedule)_channel_reminder$/.test(name) &&
      !receipt.isError
    );
  });
  const receipt = matches.at(-1);
  if (!receipt) return null;
  const envelope = object(json(receipt.content));
  if (!envelope || envelope.success === false || envelope.error || envelope.isError) return null;
  const saved = object(envelope.result) ?? envelope;
  if (typeof saved.title !== 'string' || typeof saved.horarioLocal !== 'string') return null;
  // Values come from the persisted row, including idempotent retries. Avoid
  // promising delivery when the tool found an already delivered/cancelled row.
  if (saved.status !== 'pending') return null;
  const action =
    normalizeName(receipt.name) === 'reschedule_channel_reminder' ? 'reagendado' : 'agendado';
  const detail = cleanIdentifiers(stripInternalTags(saved.title), internalIds(receipts));
  if (!detail || INTERNAL_TOOL.test(detail) || protocol.test(detail)) return null;
  return `Lembrete ${action}: ${detail}.\nData e hora: ${saved.horarioLocal}.`;
}

/** Resolve native and meta-tool receipts, including partial batch failures. */
export function successfulChannelTools(receipts: ChannelToolReceipt[]): Set<string> {
  const names = new Set<string>();
  for (const receipt of receipts) {
    const result = json(receipt.content);
    const data = object(result);
    if (receipt.isError || data?.success === false || data?.isError === true || data?.error)
      continue;
    const name = normalizeName(receipt.name);
    const saved = object(data?.result) ?? data;
    if (
      /^(?:schedule|reschedule)_channel_reminder$/.test(name) &&
      saved?.status &&
      saved.status !== 'pending'
    )
      continue;
    if (name !== 'batch_use_tool' && name !== 'use_tool') names.add(name);
  }
  return names;
}

export function safeChannelResponse(text: string, receipts: ChannelToolReceipt[]): string {
  const stripped = stripInternalTags(text);
  const clean = cleanIdentifiers(stripped, internalIds(receipts));
  const removedIdentifiers = clean !== stripped;
  const tools = successfulChannelTools(receipts);
  const has = (...names: string[]) => names.some((name) => tools.has(name));
  const lower = clean
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  // Negate the action itself, not the entire sentence: "Não se preocupe, criei"
  // is still a success claim, and a failed action cannot excuse another claim.
  const statements = lower
    .split(/[.!?\n]+/)
    .map((sentence) =>
      sentence.replace(
        /\b(?:nao|nunca)\s+(?:(?:re)?agendei|salvei|guardei|memorizei|criei|registrei|lancei|corrigi|alterei|atualizei|exclui|removi|vou\s+(?:te\s+)?(?:avisar|lembrar))\b/g,
        ''
      )
    );
  let unsupported = false;
  for (const sentence of statements) {
    if (
      /\b(?:lembretes?\s+(?:(?:e\s+tarefas?|foi|foram|esta|estao)\s+)*(?:(?:re)?agendad[oa]s?|criad[oa]s?|salv[oa]s?)|(?:re)?agendei|voce sera avisado|vou (?:te )?(?:avisar|lembrar))\b/.test(
        sentence
      ) &&
      !has('schedule_channel_reminder', 'reschedule_channel_reminder') &&
      !(has('list_channel_reminders') && /^\s*lembretes?\s+agendados?\s*:?\s*$/.test(sentence))
    )
      unsupported = true;
    if (/\blembrete\s+cancelado\b/.test(sentence) && !has('cancel_channel_reminder'))
      unsupported = true;
    if (
      /\b(?:salvei|guardei|memorizei)\b.*\b(?:nome|memoria|informacao)|\b(?:nome|informacao)\b.*\b(?:salvo|salva|guardado|guardada)\b/.test(
        sentence
      ) &&
      !has('create_memory', 'batch_create_memories')
    )
      unsupported = true;
    if (
      /\b(?:tarefas?\s+(?:(?:e\s+lembretes?|foi|foram)\s+)*(?:criad[oa]s?|registrad[oa]s?)|criei (?:uma |a )?tarefa)\b/.test(
        sentence
      ) &&
      !has('add_task', 'batch_add_tasks')
    )
      unsupported = true;
    if (
      /\b(?:registrei|lancei|registrad[oa]|lancad[oa])\b/.test(sentence) &&
      /\b(?:entrada|saida|despesa|receita|recebimento|lancamento|valor)\b/.test(sentence) &&
      !has('record_transaction', 'add_expense', 'batch_add_expenses', 'record_financing_payment')
    )
      unsupported = true;
    if (
      /\b(?:corrigi|alterei|atualizei|corrigid[oa]|atualizad[oa])\b/.test(sentence) &&
      /\b(?:entrada|saida|despesa|receita|recebimento|lancamento|valor)\b/.test(sentence) &&
      !has('update_transaction', 'update_expense')
    )
      unsupported = true;
    if (
      /\b(?:exclui|removi|excluid[oa]|removid[oa])\b/.test(sentence) &&
      /\b(?:entrada|saida|despesa|receita|recebimento|lancamento|registro)\b/.test(sentence) &&
      !has('delete_transaction', 'delete_expense')
    )
      unsupported = true;
  }
  const internalTool = INTERNAL_TOOL.test(clean);
  // A reminder-only acknowledgement must not replace the result of a compound
  // request. Count actual operations, including failed ones and repeated calls
  // to the same tool; discovery/wrapper receipts do not represent extra work.
  const operations = receipts.filter(
    (receipt) =>
      !/^(?:use_tool|batch_use_tool|search_tools|get_tool_help)$/.test(normalizeName(receipt.name))
  );
  const onlyReminder =
    operations.length === 1 &&
    /^(?:schedule|reschedule)_channel_reminder$/.test(normalizeName(operations[0]!.name));
  // A single reminder acknowledgement always uses its persisted local time,
  // even if the model's otherwise clean text repeats a wrong offset or hour.
  const reminder = onlyReminder ? reminderConfirmation(receipts) : null;
  const otherWrites = [...tools].some((name) =>
    /^(?:add_|batch_add_|create_|batch_create_|record_|update_|delete_|cancel_)/.test(name)
  );
  if (reminder && !unsupported && !otherWrites) return reminder;
  if (onlyReminder && !otherWrites) {
    for (const receipt of receipts) {
      if (
        receipt.isError ||
        !/^(?:schedule|reschedule)_channel_reminder$/.test(normalizeName(receipt.name))
      )
        continue;
      const envelope = object(json(receipt.content));
      if (envelope?.success === false || envelope?.error || envelope?.isError) continue;
      const saved = object(envelope?.result) ?? envelope;
      if (saved?.status === 'delivered')
        return 'Esse lembrete já foi enviado. Não criei outro aviso.';
      if (saved?.status === 'cancelled')
        return 'Esse lembrete já estava cancelado. Não criei outro aviso.';
    }
  }
  if (!protocol.test(text) && !internalTool && clean && !unsupported && !removedIdentifiers)
    return clean;
  // Lists and compound reminder requests often contain an ID beside a useful
  // amount/title. Keep the complete answer, including any partial-failure notice,
  // instead of discarding operations solely for an ID decoration.
  if (
    removedIdentifiers &&
    clean &&
    !unsupported &&
    !internalTool &&
    !protocol.test(text) &&
    ((!onlyReminder && has('schedule_channel_reminder', 'reschedule_channel_reminder')) ||
      ![...tools].some((name) =>
        /^(?:schedule_|reschedule_|add_|batch_add_|create_|batch_create_|record_|update_|delete_|cancel_)/.test(
          name
        )
      ))
  ) {
    return clean;
  }
  const confirmed: string[] = [];
  if (has('schedule_channel_reminder', 'reschedule_channel_reminder'))
    confirmed.push('um lembrete salvo');
  if (has('record_transaction', 'add_expense', 'batch_add_expenses'))
    confirmed.push('um lançamento financeiro salvo');
  if (has('update_transaction', 'update_expense'))
    confirmed.push('a atualização do lançamento financeiro');
  if (has('delete_transaction', 'delete_expense'))
    confirmed.push('a exclusão do lançamento financeiro');
  if (has('add_task', 'batch_add_tasks')) confirmed.push('uma tarefa salva');
  if (has('create_memory', 'batch_create_memories'))
    confirmed.push('a informação salva na memória');
  if (has('cancel_channel_reminder')) confirmed.push('o cancelamento do lembrete');
  return confirmed.length
    ? `Confirmei ${confirmed.join(' e ')}.${unsupported || protocol.test(text) ? ' Não consegui confirmar as demais partes da resposta. Confira os registros antes de repetir o pedido.' : ''}`
    : 'Não consegui confirmar a execução desse pedido. Não vou informar que ficou pronto sem verificar. Confira seus registros antes de tentar novamente; para um lembrete, informe o assunto e o horário.';
}
