/** Small, deterministic WhatsApp confirmations built from persisted facts. */
import { stripInternalTags } from './normalizers/base.js';
import { subjectEmoji } from './channel-personalization.js';
import { expenseCategoryLabelPtBr } from '../tools/expense-presentation.js';

export interface AstraMessageField {
  label: string;
  value: string;
}

export interface TransactionConfirmationData {
  type: 'income' | 'expense';
  status?: 'settled' | 'pending';
  amount: number;
  currency?: string;
  description?: string;
  category?: string;
  date?: string;
}

export type TransactionConfirmationAction = 'created' | 'updated' | 'existing';

export interface ReminderConfirmationData {
  title: string;
  horarioLocal: string;
  status?: string;
}

const UUID = '[0-9a-f]{8}[-–—][0-9a-f]{4}[-–—][0-9a-f]{4}[-–—][0-9a-f]{4}[-–—][0-9a-f]{12}';
const RECORD_ID = `(?:${UUID}|(?:exp(?:_ui|_channel)?|task|mem|reminder)_(?:[a-f0-9]{32,64}|${UUID}))`;
const INTERNAL_NAME =
  /\b(?:core(?:\.|__)[a-z_]+|use_tool|batch_use_tool|search_tools|get_tool_help|(?:schedule|reschedule|cancel|list)_channel_reminders?|(?:record|update|delete|list)_transactions?|financial_summary|add_expense|batch_add_expenses|create_memory|search_memories)\b/gi;

/** Do not allow a saved description to create extra fields or show tool protocol. */
function displayText(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = stripInternalTags(value);
  // This is a human-facing field, not an exported tool payload. Keep the other
  // persisted fields instead of presenting a corrupt JSON/argument fragment.
  if (
    /["'](?:tool_name|tool_calls|function_call|arguments)["']\s*:|\b(?:dedupeKey|platformChatId|channelPluginId|remind_at)\s*[:=]/i.test(
      text
    )
  )
    return '';
  text = text
    .replace(
      new RegExp(
        `\\s*\\(?\\b(?:ID|UUID|identificador)(?:\\s+(?:interno|do|da|lembrete|registro|lançamento|tarefa))*\\s*[:#=]?\\s*[\x60*]*${RECORD_ID}[\x60*]*\\)?`,
        'gi'
      ),
      ''
    )
    .replace(
      new RegExp(
        `\\b(?:exp(?:_ui|_channel)?|task|mem|reminder)_(?:[a-f0-9]{32,64}|${UUID})\\b`,
        'gi'
      ),
      ''
    )
    .replace(INTERNAL_NAME, '')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    // Flatten user formatting before applying the application's own markup.
    // Keep underscores inside e-mail/Pix keys and preserve numeric content.
    .replace(/\*+([^*]+)\*+/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=$|\s|[.,!?:;])/g, '$1$2')
    .replace(/~([^~]+)~/g, '$1')
    .replace(/\*/g, '∗')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!;])/g, '$1')
    .trim();
  return text;
}

/** Pass a plain title, optionally starting with one emoji (e.g. "✅ Entrada registrada"). */
export function formatAstraMessage(
  title: string,
  fields: readonly AstraMessageField[],
  footer?: string
): string {
  const heading = displayText(title) || 'Astra';
  const icon = /^(\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*)\s+(.+)$/u.exec(heading);
  const formattedTitle = icon ? `${icon[1]} *${icon[2]}*` : `*${heading}*`;
  const lines = fields.flatMap((field) => {
    const label = displayText(field.label).replace(/[:：]\s*$/, '');
    const value = displayText(field.value);
    return label && value ? [`• *${label}:* ${value}`] : [];
  });
  return [formattedTitle, lines.join('\n'), displayText(footer)].filter(Boolean).join('\n\n');
}

function money(amount: number, currency?: string): string {
  // Invalid/missing values must never turn into a fabricated R$0.00 amount.
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const code = currency === undefined ? 'BRL' : currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return '';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Dates are calendar days from the ledger, never instants in the server timezone. */
function calendarDate(value: string | undefined): string {
  if (!value) return '';
  const brazil = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const day = brazil ? `${brazil[3]}-${brazil[2]}-${brazil[1]}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const instant = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== day) return '';
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

function categoryLabel(category: string | undefined, type: 'income' | 'expense'): string {
  if (!category) return '';
  // A category ID is not a name. Unlike a free-form description, a bare UUID
  // here cannot be a Pix instruction and should simply be omitted.
  if (new RegExp(`^${RECORD_ID}$`, 'i').test(category.trim())) return '';
  if (type === 'income') {
    const labels: Record<string, string> = {
      salary: 'Salário',
      services: 'Serviços',
      sales: 'Vendas',
      investments: 'Rendimentos',
      other: 'Outras entradas',
    };
    return labels[category.trim().toLowerCase()] ?? expenseCategoryLabelPtBr(category);
  }
  return expenseCategoryLabelPtBr(category);
}

export function formatTransactionConfirmation(
  saved: TransactionConfirmationData,
  action: TransactionConfirmationAction = 'created'
): string {
  const pending = saved.status === 'pending';
  const subject = pending
    ? saved.type === 'income'
      ? 'Valor a receber'
      : 'Valor a pagar'
    : saved.type === 'income'
      ? 'Entrada'
      : 'Despesa';
  const verb = action === 'updated' ? 'atualizad' : 'registrad';
  const ending = pending ? 'o' : 'a';
  const title = `${pending ? '⏳' : '✅'} ${subject} ${action === 'existing' ? 'já ' : ''}${verb}${ending}`;
  return formatAstraMessage(title, [
    { label: 'Valor', value: money(saved.amount, saved.currency) },
    { label: 'Descrição', value: saved.description ?? '' },
    { label: 'Categoria', value: categoryLabel(saved.category, saved.type) },
    { label: pending ? 'Vencimento' : 'Data', value: calendarDate(saved.date) },
  ]);
}

export function formatReminderConfirmation(
  saved: ReminderConfirmationData,
  action: 'scheduled' | 'rescheduled' = 'scheduled'
): string {
  let title = '✅ Lembrete registrado';
  if (saved.status === 'pending') {
    title = `✅ Lembrete ${action === 'rescheduled' ? 'reagendado' : 'agendado'}`;
  } else if (saved.status === 'delivered') {
    title = '✅ Lembrete enviado';
  } else if (saved.status === 'cancelled') {
    title = 'ℹ️ Lembrete cancelado';
  } else if (saved.status === 'failed') {
    title = '⚠️ Lembrete não enviado';
  } else if (saved.status === 'sending') {
    title = '⏳ Lembrete em envio';
  }
  return formatAstraMessage(
    title,
    [
      { label: 'Assunto', value: saved.title },
      { label: 'Data e hora', value: saved.horarioLocal },
    ],
    saved.status === 'pending' ? 'Vou avisar você por aqui.' : undefined
  );
}

/** Alerts should land on time even when the writing model is busy. */
export function formatDueReminder(subject: string, firstName?: string | null): string {
  const title = displayText(subject);
  if (!title) return '⏰ Chegou a hora do seu lembrete.';
  const icon = subjectEmoji(title) ?? '⏰';
  return firstName
    ? `${icon} ${firstName}, você pediu para eu te lembrar: ${title}`
    : `${icon} Você pediu para eu te lembrar: ${title}`;
}
