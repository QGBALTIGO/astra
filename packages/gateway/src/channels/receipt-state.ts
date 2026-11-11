/** Pure receipt accounting; never infer a write or retry from model prose. */
import type { ChannelToolReceipt } from './response-safety.js';

const META_TOOLS = new Set([
  'use_tool',
  'batch_use_tool',
  'search_tools',
  'get_tool_help',
  'inspect_tool_source',
]);

function toolName(name: string): string {
  return name.replace(/__/g, '.').replace(/^core\./, '');
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function resultObjects(receipt: ChannelToolReceipt): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let entry = object(parse(receipt.content));
  // Executors normally return the payload directly; adapters may wrap it in
  // { success, result }. Only follow that envelope, never arbitrary row data.
  for (let depth = 0; entry && depth < 4; depth++) {
    result.push(entry);
    entry = object(entry.result);
  }
  return result;
}

export function isFailedChannelReceipt(receipt: ChannelToolReceipt): boolean {
  return (
    receipt.isError ||
    resultObjects(receipt).some(
      (entry) => entry.success === false || entry.isError === true || Boolean(entry.error)
    )
  );
}

interface EntityRule {
  kind: string;
  resultKeys: readonly string[];
  targetKeys?: readonly string[];
}

const ENTITY_RULES: Readonly<Record<string, EntityRule>> = {
  record_transaction: { kind: 'transaction', resultKeys: ['transaction', 'expense'] },
  add_expense: { kind: 'transaction', resultKeys: ['expense', 'transaction'] },
  update_transaction: {
    kind: 'transaction',
    resultKeys: ['transaction', 'expense'],
    targetKeys: ['transaction_id'],
  },
  delete_transaction: {
    kind: 'transaction',
    resultKeys: ['transaction', 'expense'],
    targetKeys: ['transaction_id'],
  },
  update_expense: {
    kind: 'transaction',
    resultKeys: ['expense', 'transaction'],
    targetKeys: ['expenseId'],
  },
  delete_expense: {
    kind: 'transaction',
    resultKeys: ['expense', 'transaction'],
    targetKeys: ['expenseId'],
  },
  schedule_channel_reminder: { kind: 'reminder', resultKeys: ['reminder'] },
  reschedule_channel_reminder: {
    kind: 'reminder',
    resultKeys: ['reminder'],
    targetKeys: ['reminder_id'],
  },
  cancel_channel_reminder: {
    kind: 'reminder',
    resultKeys: ['reminder'],
    targetKeys: ['reminder_id'],
  },
  add_task: { kind: 'task', resultKeys: ['task'] },
  update_task: { kind: 'task', resultKeys: ['task'], targetKeys: ['taskId'] },
  complete_task: { kind: 'task', resultKeys: ['task'], targetKeys: ['taskId'] },
  delete_task: { kind: 'task', resultKeys: ['task'], targetKeys: ['taskId'] },
  add_calendar_event: { kind: 'calendar_event', resultKeys: ['event'] },
  update_calendar_event: {
    kind: 'calendar_event',
    resultKeys: ['event'],
    targetKeys: ['eventId'],
  },
  delete_calendar_event: {
    kind: 'calendar_event',
    resultKeys: ['event'],
    targetKeys: ['eventId'],
  },
  create_memory: { kind: 'memory', resultKeys: ['memory'] },
  update_memory: { kind: 'memory', resultKeys: ['memory'], targetKeys: ['memoryId', 'memory_id'] },
  delete_memory: { kind: 'memory', resultKeys: ['memory'], targetKeys: ['memoryId', 'memory_id'] },
};

function id(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function persistedId(receipt: ChannelToolReceipt, rule: EntityRule): string | null {
  const entries = resultObjects(receipt);
  // Prefer the actual saved entity over IDs on an outer request envelope.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    for (const key of rule.resultKeys) {
      const found = id(object(entry[key])?.id);
      if (found) return found;
    }
    const found = id(entry.id);
    if (found) return found;
  }
  return null;
}

function argumentTarget(receipt: ChannelToolReceipt, rule: EntityRule): string | null {
  if (!rule.targetKeys) return null;
  const args = object(parse(receipt.arguments));
  if (!args) return null;
  for (const key of rule.targetKeys) {
    const found = id(args[key]);
    if (found) return found;
  }
  return null;
}

function entityKey(receipt: ChannelToolReceipt): string | null {
  const rule = ENTITY_RULES[toolName(receipt.name)];
  if (!rule) return null;
  const entityId = persistedId(receipt, rule) ?? argumentTarget(receipt, rule);
  return entityId ? JSON.stringify([rule.kind, entityId]) : null;
}

/** Keep the latest saved state, while a failed later attempt never erases it. */
export function channelOperations(receipts: readonly ChannelToolReceipt[]): ChannelToolReceipt[] {
  const operations = receipts.filter((receipt) => !META_TOOLS.has(toolName(receipt.name)));
  const latest = new Map<string, number>();
  const superseded = new Set<number>();
  for (const [index, receipt] of operations.entries()) {
    if (isFailedChannelReceipt(receipt)) continue;
    const key = entityKey(receipt);
    if (!key) continue;
    const earlier = latest.get(key);
    if (earlier !== undefined) superseded.add(earlier);
    latest.set(key, index);
  }
  return operations.filter((_receipt, index) => !superseded.has(index));
}

function stableJson(value: unknown, depth = 0): string | null {
  if (depth > 20) return null;
  if (Array.isArray(value)) {
    const items = value.map((item) => stableJson(item, depth + 1));
    return items.some((item) => item === null) ? null : `[${items.join(',')}]`;
  }
  const entry = object(value);
  if (entry) {
    const parts: string[] = [];
    for (const key of Object.keys(entry).sort()) {
      const child = stableJson(entry[key], depth + 1);
      if (child === null) return null;
      parts.push(`${JSON.stringify(key)}:${child}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? null;
}

function argumentFingerprint(receipt: ChannelToolReceipt): string | null {
  const args = object(parse(receipt.arguments));
  return args && Object.keys(args).length > 0 ? stableJson(args) : null;
}

function explicitTarget(receipt: ChannelToolReceipt): string | null {
  const rule = ENTITY_RULES[toolName(receipt.name)];
  if (!rule?.targetKeys) return null;
  const target = argumentTarget(receipt, rule) ?? persistedId(receipt, rule);
  return target ? JSON.stringify([rule.kind, target]) : null;
}

/** A different successful request must never hide an earlier uncompleted one. */
export function failedChannelOperations(
  receipts: readonly ChannelToolReceipt[]
): ChannelToolReceipt[] {
  const operations = receipts
    .filter((receipt) => !META_TOOLS.has(toolName(receipt.name)))
    .map((receipt) => ({
      receipt,
      name: toolName(receipt.name),
      failed: isFailedChannelReceipt(receipt),
      args: argumentFingerprint(receipt),
      target: explicitTarget(receipt),
    }));
  return operations
    .filter(
      (entry, index) =>
        entry.failed &&
        !operations
          .slice(index + 1)
          .some(
            (later) =>
              !later.failed &&
              later.name === entry.name &&
              ((entry.args !== null && later.args === entry.args) ||
                (entry.target !== null && later.target === entry.target))
          )
    )
    .map((entry) => entry.receipt);
}
