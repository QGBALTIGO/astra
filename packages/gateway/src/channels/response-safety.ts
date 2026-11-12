/** Final channel boundary: model text is not proof of a database write. */
import { stripInternalTags } from './normalizers/base.js';
import {
  formatAstraMessage,
  formatReminderConfirmation,
  formatTransactionConfirmation,
} from './response-presentation.js';
import {
  channelOperations,
  failedChannelOperations,
  isFailedChannelReceipt,
} from './receipt-state.js';

export const CHANNEL_UNVERIFIED_REPLY =
  'Ainda não tenho uma alteração confirmada para mostrar. Se era só uma pergunta, podemos continuar nossa conversa normalmente.';

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
  return formatReminderConfirmation(
    { title: detail, horarioLocal: saved.horarioLocal, status: 'pending' },
    action === 'reagendado' ? 'rescheduled' : 'scheduled'
  );
}

/** The same persisted ledger row must look the same across model/provider paths. */
function transactionConfirmation(receipt: ChannelToolReceipt, ids: Set<string>): string | null {
  const name = normalizeName(receipt.name);
  if (!/^(?:record_transaction|update_transaction|add_expense|update_expense)$/.test(name))
    return null;
  if (!successfulChannelTools([receipt]).has(name)) return null;
  const envelope = object(json(receipt.content));
  const result = object(envelope?.result) ?? envelope;
  const saved = object(result?.transaction) ?? object(result?.expense) ?? result;
  if (
    !saved ||
    typeof saved.amount !== 'number' ||
    !Number.isFinite(saved.amount) ||
    saved.amount <= 0
  )
    return null;
  const savedType = saved.type ?? saved.transactionType ?? saved.transaction_type;
  const type = savedType ?? (name === 'add_expense' ? 'expense' : undefined);
  if (type !== 'income' && type !== 'expense') return null;
  const field = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const clean = cleanIdentifiers(stripInternalTags(value), ids);
    return clean && !INTERNAL_TOOL.test(clean) && !protocol.test(clean) ? clean : undefined;
  };
  return formatTransactionConfirmation(
    {
      type,
      status: saved.status === 'pending' || saved.status === 'settled' ? saved.status : undefined,
      amount: saved.amount,
      currency: field(saved.currency),
      description: field(saved.description),
      category: field(saved.categoryName ?? saved.category),
      date: field(saved.date),
    },
    name.startsWith('update_') ? 'updated' : result?.created === false ? 'existing' : 'created'
  );
}

const calendarWrite =
  /^(?:add_calendar_event|batch_add_calendar_events|update_calendar_event|delete_calendar_event)$/;

function calendarConfirmation(
  receipt: ChannelToolReceipt,
  ids: Set<string>,
  timeZone?: string
): string | null {
  const name = normalizeName(receipt.name);
  if (!calendarWrite.test(name) || isFailedChannelReceipt(receipt)) return null;
  const envelope = object(json(receipt.content));
  const result = object(envelope?.result) ?? envelope;
  if (!result) return null;
  if (name === 'delete_calendar_event') {
    return result.message === 'Event deleted.'
      ? formatAstraMessage('🗑️ Compromisso excluído', [])
      : null;
  }
  const rows = name === 'batch_add_calendar_events' ? result.events : [result.event ?? result];
  if (!Array.isArray(rows) || !rows.length) return null;
  const details: string[] = [];
  for (const value of rows) {
    const row = object(value);
    if (
      !row ||
      typeof row.id !== 'string' ||
      !row.id ||
      typeof row.title !== 'string' ||
      typeof row.startTime !== 'string'
    )
      return null;
    const title = cleanIdentifiers(stripInternalTags(row.title), ids);
    const start = new Date(row.startTime);
    const end = typeof row.endTime === 'string' ? new Date(row.endTime) : null;
    if (
      !title ||
      INTERNAL_TOOL.test(title) ||
      protocol.test(title) ||
      !Number.isFinite(start.getTime()) ||
      (end && !Number.isFinite(end.getTime()))
    )
      return null;
    const allDay = row.allDay === true;
    const storedZone = typeof row.timezone === 'string' && row.timezone ? row.timezone : 'UTC';
    let zone = (allDay ? storedZone : timeZone) || storedZone;
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: 'short',
      timeStyle: allDay ? undefined : 'short',
    };
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat('pt-BR', { ...options, timeZone: zone });
    } catch {
      zone = 'UTC';
      format = new Intl.DateTimeFormat('pt-BR', { ...options, timeZone: zone });
    }
    const fields = [
      { label: 'Assunto', value: title },
      { label: allDay ? 'Dia inteiro' : 'Início', value: format.format(start) },
    ];
    if (end) fields.push({ label: 'Fim', value: format.format(end) });
    if (!allDay) fields.push({ label: 'Fuso horário', value: zone });
    details.push(
      formatAstraMessage(
        name === 'update_calendar_event' ? '✅ Compromisso atualizado' : '✅ Compromisso agendado',
        fields
      )
    );
  }
  return details.join('\n\n');
}

const calendarNoun = /\b(?:agenda|evento|compromisso|consulta|reuniao)s?\b/;
const positiveCalendarClaims = [
  {
    action: 'add_calendar_event',
    first: /\b(?:agendei|marquei|criei|adicionei|inclui)\b/,
    passive:
      /\b(?:evento|compromisso|consulta|reuniao)s?\s+(?:(?:foi|foram|esta|estao)\s+)?(?:agendad|marcad|criad|confirmad)[oa]s?\b/,
  },
  {
    action: 'update_calendar_event',
    first: /\b(?:reagendei|remarquei|mudei|atualizei|alterei)\b/,
    passive:
      /\b(?:evento|compromisso|consulta|reuniao)s?\s+(?:(?:foi|foram|esta|estao)\s+)?(?:reagendad|remarcad|atualizad|alterad)[oa]s?\b/,
  },
  {
    action: 'delete_calendar_event',
    first: /\b(?:cancelei|exclui|removi)\b/,
    passive:
      /\b(?:evento|compromisso|consulta|reuniao)s?\s+(?:(?:foi|foram|esta|estao)\s+)?(?:cancelad|excluid|removid)[oa]s?\b/,
  },
];

function taskConfirmation(receipt: ChannelToolReceipt, ids: Set<string>): string | null {
  const name = normalizeName(receipt.name);
  if (
    !/^(?:add|update|complete|delete)_task$/.test(name) ||
    !successfulChannelTools([receipt]).has(name)
  )
    return null;
  const envelope = object(json(receipt.content));
  const result = object(envelope?.result) ?? envelope;
  const task = object(result?.task) ?? result;
  const title =
    typeof task?.title === 'string' ? cleanIdentifiers(stripInternalTags(task.title), ids) : '';
  if (title && (INTERNAL_TOOL.test(title) || protocol.test(title))) return null;
  if (!title && name === 'add_task') return null;
  const labels: Record<string, string> = {
    add_task: '✅ Tarefa criada',
    update_task: '✅ Tarefa atualizada',
    complete_task: '✅ Tarefa concluída',
    delete_task: '🗑️ Tarefa excluída',
  };
  return formatAstraMessage(labels[name]!, title ? [{ label: 'Tarefa', value: title }] : []);
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

export function safeChannelResponse(
  text: string,
  receipts: ChannelToolReceipt[],
  context: { timeZone?: string; requestText?: string } = {}
): string {
  const ids = internalIds(receipts);
  const calendar = new Map<ChannelToolReceipt, string | null>();
  for (const receipt of receipts) {
    if (calendarWrite.test(normalizeName(receipt.name))) {
      calendar.set(receipt, calendarConfirmation(receipt, ids, context.timeZone));
    }
  }
  const confirmedCalendar = new Set(
    [...calendar].filter(([, detail]) => detail).map(([r]) => normalizeName(r.name))
  );
  if (confirmedCalendar.has('batch_add_calendar_events'))
    confirmedCalendar.add('add_calendar_event');
  const stripped = stripInternalTags(text);
  const clean = cleanIdentifiers(stripped, ids);
  const removedIdentifiers = clean !== stripped;
  const tools = successfulChannelTools(receipts);
  const has = (...names: string[]) => names.some((name) => tools.has(name));
  const lower = clean
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[*_~`]/g, '')
    .toLowerCase();
  // Negate the action itself, not the entire sentence: "Não se preocupe, criei"
  // is still a success claim, and a failed action cannot excuse another claim.
  // Legacy error prose can be echoed by the model from prior chat turns.
  // Never show the obsolete error banner to WhatsApp users again.
  const legacyErrorBanner =
    /(?:^|\n)[^\p{L}\p{N}]{0,12}nao consegui confirmar (?:o pedido|a execucao)\b/u.test(lower);
  const statements = lower
    .split(/[.!?\n]+/)
    .map((sentence) =>
      sentence
        .replace(
          /\b(?:nao|nunca)\s+(?:(?:re)?agendei|remarquei|mudei|salvei|guardei|memorizei|criei|registrei|lancei|corrigi|alterei|atualizei|exclui|removi|vou\s+(?:te\s+)?(?:avisar|lembrar))\b/g,
          ''
        )
        .replace(
          /\bnao\s+(?:(?:foi|foram|esta|estao)\s+)?(?:salv[oa]s?|registrad[oa]s?|recebid[oa]s?|pag[oa]s?|confirmad[oa]s?)\b/g,
          ''
        )
    );
  const normalizedRequest =
    context.requestText
      ?.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase() ?? '';
  const requestedCalendarWrite =
    calendarNoun.test(normalizedRequest) &&
    /\b(?:marca|marque|agenda|agende|cria|crie|adiciona|adicione|remarca|remarque|reagende|cancela|cancele|exclua|remova)\s+(?:(?:na|no|um|uma|meu|minha|o|a|esse|essa|este|esta|para)\s+)+/.test(
      normalizedRequest
    );
  const bareCalendarWrite =
    requestedCalendarWrite && /^(?:pronto|feito|tudo certo|ok)[.!\s]*$/.test(lower.trim());
  let unsupported =
    (bareCalendarWrite && !confirmedCalendar.size) ||
    [...calendar].some(([receipt, detail]) => !isFailedChannelReceipt(receipt) && !detail);
  let claimsCalendarWrite = false;
  for (const raw of statements) {
    const sentence = raw
      .replace(/\b(?:nao|nunca)\s+(?:marquei|remarquei|mudei|adicionei|inclui|cancelei)\b/g, '')
      .replace(
        /\b(?:nenhum|nenhuma)\s+(?:evento|compromisso|consulta|reuniao)\s+(?:(?:foi|esta)\s+)?(?:agendad|marcad|criad|remarcad|cancelad|alterad)[oa]\b/g,
        ''
      );
    const listHeading =
      has('list_calendar_events') &&
      /^\s*(?:eventos|compromissos|consultas|reunioes)\s+agendad[oa]s\s*:?\s*$/.test(sentence);
    if (listHeading) continue;
    // A scheduled appointment can be an existing item or an example. Remove only
    // that phrase, so another asserted write in the same sentence still counts.
    let actionStatement = sentence.replace(
      /\b(?:ter|prefere|quer|com|sem)\s+(?:um|uma)\s+(?:evento|compromisso|consulta|reuniao)\s+(?:agendad|marcad)[oa]\b/g,
      ''
    );
    if (has('list_calendar_events') && !requestedCalendarWrite) {
      actionStatement = actionStatement
        .replace(
          /\b(?:tem|ha|encontrei)\s+(?:um|uma)\s+(?:evento|compromisso|consulta|reuniao)\s+(?:agendad|marcad)[oa]\b/g,
          ''
        )
        .replace(
          /\b(?:evento|compromisso|consulta|reuniao)s?\s+(?:esta|estao)\s+(?:agendad|marcad|confirmad)[oa]s?\b/g,
          ''
        );
    }
    const reminderObject = /\b(?:re)?agendei\s+(?:(?:o|um|seu|meu|esse|este)\s+)*lembrete\b/.test(
      sentence
    );
    if (
      /\b(?:re)?agendei\b[^.!?]*\be\s+(?:(?:o|um|seu|meu)\s+)*lembrete\b/.test(sentence) &&
      !has('schedule_channel_reminder', 'reschedule_channel_reminder')
    )
      unsupported = true;
    for (const rule of positiveCalendarClaims) {
      const ambiguous =
        rule.action === 'add_calendar_event'
          ? /\bagendei\b/.test(sentence)
          : rule.action === 'update_calendar_event' && /\breagendei\b/.test(sentence);
      const matchingReminder =
        rule.action === 'add_calendar_event'
          ? has('schedule_channel_reminder')
          : has('reschedule_channel_reminder');
      if (
        (calendarNoun.test(sentence) && rule.first.test(sentence) && !reminderObject) ||
        rule.passive.test(actionStatement) ||
        (ambiguous && !/\blembrete/.test(sentence) && !matchingReminder)
      ) {
        claimsCalendarWrite = true;
        if (!confirmedCalendar.has(rule.action)) unsupported = true;
      }
    }
  }
  for (const sentence of statements) {
    // Only a complete denial is exempt; any other sentence still needs its own receipt.
    if (
      /^\s*nenhum lembrete foi (?:agendado|reagendado|criado|salvo)(?: de verdade)?\s*$/.test(
        sentence
      )
    )
      continue;
    if (
      /\b(?:remarquei|mudei|alterei|atualizei)\s+(?:(?:[oa]s?|suas?|seus?|minha|meu|essa|esse)\s+)*(?:(?:horario|data|dia)\s+d[ao]\s+)?(?:consultas?|dentista|reunioes|reuniao|compromissos?|eventos?|agenda)\b/.test(
        sentence
      ) &&
      !has('update_calendar_event')
    )
      unsupported = true;
    if (
      /\b(?:lembretes?\s+(?:(?:e\s+tarefas?|foi|foram|esta|estao)\s+)*(?:(?:re)?agendad[oa]s?|criad[oa]s?|salv[oa]s?)|(?:re)?agendei\s+(?:(?:o|um|seu|meu|esse|este)\s+)*lembrete|voce sera avisado|vou (?:te )?(?:avisar|lembrar))\b/.test(
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
      /\b(?:registrei|lancei|confirmei|salvei|registrad[oa]|lancad[oa]|salv[oa])\b/.test(
        sentence
      ) &&
      /\b(?:entrada|saida|despesa|receita|recebimento|lancamento|valor)\b/.test(sentence) &&
      !has('record_transaction', 'add_expense', 'batch_add_expenses', 'record_financing_payment') &&
      !(
        !/\b(?:registrei|lancei|confirmei|salvei)\b/.test(sentence) &&
        has('list_transactions', 'financial_summary', 'list_expenses', 'expense_summary')
      )
    )
      unsupported = true;
    if (
      /\b(?:entrada|saida|despesa|receita|recebimento|lancamento|valor)\b/.test(sentence) &&
      /\b(?:recebid[oa]|pag[oa])\b/.test(sentence) &&
      !has(
        'record_transaction',
        'update_transaction',
        'add_expense',
        'batch_add_expenses',
        'record_financing_payment',
        'list_transactions',
        'financial_summary',
        'list_expenses',
        'expense_summary'
      )
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
  const failures = failedChannelOperations(receipts);
  const unresolvedFailures = new Set(failures);
  const operations = channelOperations(receipts).filter(
    (receipt) => !isFailedChannelReceipt(receipt) || unresolvedFailures.has(receipt)
  );
  const failureAcknowledged =
    failures.length === 0 ||
    /\b(?:nao consegui|nao foi possivel|nao pude|falhou|falharam|nao (?:foi|foram) (?:salv|criad|agendad|registrad)[oa]s?|erro ao)\b/.test(
      lower
    );
  const confirmations = operations.map(
    (receipt) =>
      calendar.get(receipt) ??
      transactionConfirmation(receipt, ids) ??
      reminderConfirmation([receipt]) ??
      taskConfirmation(receipt, ids)
  );
  // Format known action results without another model call. Only replace the
  // complete reply when every operation is represented, so an unrelated query
  // or a partial failure is never lost behind one successful confirmation.
  if (
    confirmations.length &&
    confirmations.every((confirmation) => confirmation !== null) &&
    !unsupported &&
    failures.length === 0
  )
    return confirmations.join('\n\n');
  const bareAcknowledgement =
    /^(?:pronto|feito|certo|ok|(?:a\s+|o\s+)?(?:entrada|despesa|lancamento|tarefa|lembrete)\s+(?:foi\s+)?(?:atualizad[oa]|registrad[oa]|salv[oa]|corrigid[oa]|agendad[oa]|criad[oa]))[.!\s]*$/.test(
      lower.replace(/^[^\p{L}\p{N}]+/u, '')
    );
  if (
    !unsupported &&
    !failures.length &&
    bareAcknowledgement &&
    confirmations.some(Boolean) &&
    operations.every(
      (receipt, index) =>
        confirmations[index] || /^(?:list_|search_|get_)/.test(normalizeName(receipt.name))
    )
  )
    return confirmations.filter(Boolean).join('\n\n');
  const requireCalendarEvidence =
    confirmedCalendar.size > 0 && (claimsCalendarWrite || failures.length > 0);
  const onlyReminder =
    operations.length === 1 &&
    /^(?:schedule|reschedule)_channel_reminder$/.test(normalizeName(operations[0]!.name));
  // A single reminder acknowledgement always uses its persisted local time,
  // even if the model's otherwise clean text repeats a wrong offset or hour.
  const reminder = onlyReminder ? reminderConfirmation(receipts) : null;
  const otherWrites = [...tools].some((name) =>
    /^(?:add_|batch_add_|create_|batch_create_|record_|update_|delete_|cancel_)/.test(name)
  );
  if (reminder && !unsupported && !otherWrites && failures.length === 0) return reminder;
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
        return formatAstraMessage(
          '✅ Lembrete já enviado',
          [],
          'Esse lembrete já foi enviado. Não criei outro aviso.'
        );
      if (saved?.status === 'cancelled')
        return formatAstraMessage(
          'ℹ️ Lembrete cancelado',
          [],
          'Esse lembrete já estava cancelado. Não criei outro aviso.'
        );
    }
  }
  if (
    !protocol.test(text) &&
    !internalTool &&
    clean &&
    !unsupported &&
    !removedIdentifiers &&
    !requireCalendarEvidence &&
    failureAcknowledged &&
    !legacyErrorBanner
  )
    return clean;
  // Lists and compound reminder requests often contain an ID beside a useful
  // amount/title. Keep the complete answer, including any partial-failure notice,
  // instead of discarding operations solely for an ID decoration.
  if (
    removedIdentifiers &&
    clean &&
    !unsupported &&
    !requireCalendarEvidence &&
    failureAcknowledged &&
    !internalTool &&
    !protocol.test(text) &&
    !legacyErrorBanner &&
    ((!onlyReminder && has('schedule_channel_reminder', 'reschedule_channel_reminder')) ||
      ![...tools].some((name) =>
        /^(?:schedule_|reschedule_|add_|batch_add_|create_|batch_create_|record_|update_|delete_|cancel_)/.test(
          name
        )
      ))
  ) {
    return clean;
  }
  const detailedTools = new Set(
    operations
      .filter((_, index) => confirmations[index] !== null)
      .map((receipt) => normalizeName(receipt.name))
  );
  const confirmed: string[] = [];
  const summarize = (detail: string, ...names: string[]): void => {
    if (has(...names) && !names.some((name) => detailedTools.has(name))) confirmed.push(detail);
  };
  summarize('um lembrete salvo', 'schedule_channel_reminder', 'reschedule_channel_reminder');
  summarize(
    'um lançamento financeiro salvo',
    'record_transaction',
    'add_expense',
    'batch_add_expenses'
  );
  summarize('a atualização do lançamento financeiro', 'update_transaction', 'update_expense');
  summarize('a exclusão do lançamento financeiro', 'delete_transaction', 'delete_expense');
  summarize('uma tarefa salva', 'add_task', 'batch_add_tasks');
  summarize('a tarefa concluída', 'complete_task');
  summarize('a tarefa atualizada', 'update_task');
  summarize('a exclusão da tarefa', 'delete_task');
  summarize('a informação salva na memória', 'create_memory', 'batch_create_memories');
  summarize('o cancelamento do lembrete', 'cancel_channel_reminder');
  const details = confirmations.filter(
    (confirmation): confirmation is string => confirmation !== null
  );
  if (confirmed.length || details.length) {
    const needsReview = unsupported || protocol.test(text) || failures.length > 0;
    // If only a subset has enough saved details, retain a truthful summary of
    // the other successful operations instead of dropping them for appearance.
    const summary = confirmed.length
      ? formatAstraMessage(needsReview ? '✅ Parte concluída' : '✅ Atualização concluída', [
          { label: 'Confirmado', value: confirmed.join(' e ') },
        ])
      : '';
    const failedLabels: Record<string, string> = {
      add_calendar_event: confirmedCalendar.has('add_calendar_event')
        ? 'outra tentativa de criar um compromisso'
        : 'a criação do compromisso',
      batch_add_calendar_events: 'a criação dos compromissos',
      update_calendar_event: 'a alteração do compromisso',
      delete_calendar_event: 'a exclusão do compromisso',
      schedule_channel_reminder: 'o agendamento do lembrete',
      reschedule_channel_reminder: 'a alteração do lembrete',
      cancel_channel_reminder: 'o cancelamento do lembrete',
      add_task: 'a criação da tarefa',
      complete_task: 'a conclusão da tarefa',
      update_task: 'a alteração da tarefa',
      delete_task: 'a exclusão da tarefa',
      record_transaction: 'o registro financeiro',
      update_transaction: 'a correção do lançamento',
      delete_transaction: 'a exclusão do lançamento',
      create_memory: 'o salvamento da informação',
    };
    const pending = [
      ...new Set(
        failures.map((receipt) => failedLabels[normalizeName(receipt.name)] ?? 'uma das etapas')
      ),
    ];
    const notice = needsReview
      ? `Sobre ${pending.length ? pending.join(' e ') : 'as demais partes do pedido'}, ainda não tenho confirmação. Confira os registros antes de repetir, para evitar duplicidade.`
      : '';
    return [...details, summary, notice].filter(Boolean).join('\n\n');
  }
  return failures.length
    ? 'Essa alteração ainda não está confirmada. Confira seus registros antes de pedir novamente, para evitar duplicidade.'
    : CHANNEL_UNVERIFIED_REPLY;
}
