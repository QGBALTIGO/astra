import { describe, expect, it } from 'vitest';
import type { ChannelToolReceipt } from './response-safety.js';
import {
  channelOperations,
  failedChannelOperations,
  isFailedChannelReceipt,
} from './receipt-state.js';

function receipt(
  name: string,
  payload: unknown,
  args: Record<string, unknown> | string = '',
  isError = false
): ChannelToolReceipt {
  return {
    name,
    content: JSON.stringify(payload),
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    isError,
  };
}
const transaction = (id: string, amount = 20) =>
  receipt('core.record_transaction', { transaction: { id, type: 'expense', amount } });
const reminder = (id: string, status = 'pending') =>
  receipt('core.schedule_channel_reminder', { id, title: 'Codex', status });
const failed = (name: string, args: Record<string, unknown> | string = '') =>
  receipt(name, { success: false, error: 'operation failed' }, args, true);

describe('channel operation identity and ordering', () => {
  it('excludes wrappers and discovery instead of counting their nested calls twice', () => {
    const saved = transaction('transaction-a');
    expect(
      channelOperations([
        receipt('search_tools', {}),
        receipt('core.get_tool_help', {}),
        receipt('inspect_tool_source', {}),
        receipt('use_tool', { result: saved }),
        saved,
        receipt('core__batch_use_tool', { results: [saved] }),
      ])
    ).toEqual([saved]);
  });

  it('shows only the last success for one real saved transaction', () => {
    const first = transaction('transaction-a');
    const retried = transaction('transaction-a');
    expect(channelOperations([first, retried])).toEqual([retried]);
  });

  it('keeps two distinct transactions with identical amount and description', () => {
    const first = transaction('transaction-a');
    const second = transaction('transaction-b');
    expect(channelOperations([first, second])).toEqual([first, second]);
  });

  it('preserves the latest update and the original order of surviving receipts', () => {
    const first = transaction('transaction-a');
    const other = reminder('reminder-b');
    const updated = receipt('core.update_transaction', {
      success: true,
      result: { transaction: { id: 'transaction-a', type: 'income', amount: 770 } },
    });
    expect(channelOperations([first, other, updated])).toEqual([other, updated]);
  });

  it('recognizes legacy expenses and the typed ledger as the same entity', () => {
    const legacy = receipt('core.add_expense', { id: 'transaction-a', amount: 20 });
    const updated = receipt('core__update_transaction', {
      transaction: { id: 'transaction-a', type: 'income', amount: 20 },
    });
    expect(channelOperations([legacy, updated])).toEqual([updated]);
  });

  it('does not collide when a reminder and transaction happen to use the same ID', () => {
    const money = transaction('shared-id');
    const alert = reminder('shared-id');
    expect(channelOperations([money, alert])).toEqual([money, alert]);
  });

  it('keeps a saved state when a subsequent change to that record fails', () => {
    const saved = transaction('transaction-a');
    const rejected = failed('core.update_transaction', { transaction_id: 'transaction-a' });
    expect(channelOperations([saved, rejected])).toEqual([saved, rejected]);
    expect(failedChannelOperations([saved, rejected])).toEqual([rejected]);
  });

  it('does not discard a failure of another operation beside a successful write', () => {
    const saved = transaction('transaction-a');
    const rejected = failed('core.schedule_channel_reminder');
    expect(channelOperations([saved, rejected])).toEqual([saved, rejected]);
    expect(failedChannelOperations([saved, rejected])).toEqual([rejected]);
  });

  it('preserves terminal reminder states rather than treating them as another pending save', () => {
    const scheduled = reminder('reminder-a');
    const delivered = reminder('reminder-a', 'delivered');
    expect(channelOperations([scheduled, delivered])).toEqual([delivered]);
    expect(isFailedChannelReceipt(delivered)).toBe(false);
  });

  it('tracks explicit successful deletion after creation even when the reply omits the ID', () => {
    const created = receipt('core.add_task', { task: { id: 'task-a', title: 'Cobrar' } });
    const deleted = receipt('core.delete_task', { message: 'Task deleted.' }, { taskId: 'task-a' });
    expect(channelOperations([created, deleted])).toEqual([deleted]);
  });

  it('does not invent an identity or deduplicate unknown/read-only results', () => {
    const noId = receipt('core.record_transaction', { transaction: { amount: 20 } });
    const query = receipt('core.list_transactions', { id: 'query-id', transactions: [] });
    expect(channelOperations([noId, noId, query, query])).toEqual([noId, noId, query, query]);
  });

  it('does not mutate the received records or their order', () => {
    const first = Object.freeze(transaction('transaction-a'));
    const second = Object.freeze(transaction('transaction-a', 50));
    const original = Object.freeze([first, second]);
    expect(channelOperations(original)).toEqual([second]);
    expect(original).toEqual([first, second]);
  });
});

describe('receipt failure signals', () => {
  it('respects isError even if the returned data claims success', () => {
    expect(isFailedChannelReceipt(receipt('core.add_task', { success: true }, '', true))).toBe(
      true
    );
  });
  it.each([
    { success: false },
    { isError: true },
    { error: 'not found' },
    { success: true, result: { success: false, error: 'write failed' } },
  ])('recognizes a failed executor envelope %j', (content) => {
    expect(isFailedChannelReceipt(receipt('core.update_transaction', content))).toBe(true);
  });
  it.each([
    { success: true, result: { transaction: { id: 'transaction-a' } } },
    { id: 'reminder-a', status: 'cancelled' },
    { id: 'reminder-a', status: 'delivered' },
    { reminders: [{ id: 'old-reminder', error: 'an old delivery failed' }] },
    [{ error: 'an old row error, not the current lookup' }],
  ])('does not confuse a successful query or terminal state with execution failure', (content) => {
    expect(isFailedChannelReceipt(receipt('core.list_channel_reminders', content))).toBe(false);
  });
  it('supports plain-text successful legacy tools without guessing from text', () => {
    const result = receipt('core.delete_task', {});
    result.content = 'Task deleted.';
    expect(isFailedChannelReceipt(result)).toBe(false);
  });
});

describe('only verified retries recover earlier failures', () => {
  it('recognizes a retry with semantically identical JSON despite key order and whitespace', () => {
    const args = {
      description: 'Café',
      amount: 20,
      options: { tags: ['a', 'b'], type: 'expense' },
    };
    const rejected = failed('core.record_transaction', args);
    const saved = receipt(
      'core__record_transaction',
      { transaction: { id: 'transaction-a' } },
      ' { "options": {"type":"expense", "tags":["a","b"]}, "amount":20, "description":"Café" } '
    );
    expect(failedChannelOperations([rejected, saved])).toEqual([]);
    // The state helper retains failures; the presentation can use this separate
    // recovery view to distinguish a recovered retry from a partial failure.
    expect(channelOperations([rejected, saved])).toEqual([rejected, saved]);
  });

  it('does not let an unrelated successful creation hide a failed one', () => {
    const rejected = failed('core.record_transaction', { description: 'Café', amount: 20 });
    const saved = receipt(
      'core.record_transaction',
      { transaction: { id: 'pizza' } },
      { description: 'Pizza', amount: 81 }
    );
    expect(failedChannelOperations([rejected, saved])).toEqual([rejected]);
  });

  it.each(['', '{}', 'not JSON', '[]', 'null'])(
    'does not infer recovery from missing, empty or malformed arguments: %s',
    (args) => {
      const rejected = failed('core.record_transaction', args);
      const saved = receipt(
        'core.record_transaction',
        { transaction: { id: 'transaction-a' } },
        args
      );
      expect(failedChannelOperations([rejected, saved])).toEqual([rejected]);
    }
  );

  it('preserves array order and scalar types when comparing arguments', () => {
    const rejected = failed('core.record_transaction', { amount: 20, tags: ['a', 'b'] });
    const stringAmount = receipt('core.record_transaction', {}, { amount: '20', tags: ['a', 'b'] });
    const reversed = receipt('core.record_transaction', {}, { amount: 20, tags: ['b', 'a'] });
    expect(failedChannelOperations([rejected, stringAmount, reversed])).toEqual([rejected]);
  });

  it('requires the same normalized tool, not just matching arguments or IDs', () => {
    const rejected = failed('core.update_transaction', {
      transaction_id: 'transaction-a',
      amount: 20,
    });
    const deleted = receipt(
      'core.delete_transaction',
      { id: 'transaction-a' },
      { transaction_id: 'transaction-a', amount: 20 }
    );
    expect(failedChannelOperations([rejected, deleted])).toEqual([rejected]);
  });

  it('recognizes a later successful update of the same explicit target', () => {
    const rejected = failed('core.update_transaction', {
      transaction_id: 'transaction-a',
      amount: 20,
    });
    const saved = receipt('core.update_transaction', {
      transaction: { id: 'transaction-a', amount: 30 },
    });
    expect(failedChannelOperations([rejected, saved])).toEqual([]);
  });

  it('recognizes an explicit reminder target after a successful reschedule', () => {
    const rejected = failed('core.reschedule_channel_reminder', {
      reminder_id: 'reminder-a',
      delay_minutes: 40,
    });
    const saved = receipt('core.reschedule_channel_reminder', {
      id: 'reminder-a',
      status: 'pending',
    });
    expect(failedChannelOperations([rejected, saved])).toEqual([]);
  });

  it('does not recover an update from a success on a different explicit target', () => {
    const rejected = failed('core.update_transaction', { transaction_id: 'transaction-a' });
    const saved = receipt('core.update_transaction', { transaction: { id: 'transaction-b' } });
    expect(failedChannelOperations([rejected, saved])).toEqual([rejected]);
  });

  it('does not use arbitrary caller-supplied IDs as target keys for creation', () => {
    const rejected = failed('core.record_transaction', { transaction_id: 'made-up', amount: 20 });
    const saved = receipt(
      'core.record_transaction',
      { transaction: { id: 'made-up' } },
      { transaction_id: 'made-up', amount: 30 }
    );
    expect(failedChannelOperations([rejected, saved])).toEqual([rejected]);
  });

  it('requires the recovery to occur after the failure', () => {
    const args = { description: 'Café', amount: 20 };
    const saved = receipt(
      'core.record_transaction',
      { transaction: { id: 'transaction-a' } },
      args
    );
    const rejected = failed('core.record_transaction', args);
    expect(failedChannelOperations([saved, rejected])).toEqual([rejected]);
  });

  it('does not recover an error with a second failed attempt or a meta wrapper', () => {
    const args = { description: 'Café', amount: 20 };
    const first = failed('core.record_transaction', args);
    const second = failed('core.record_transaction', args);
    expect(
      failedChannelOperations([first, receipt('use_tool', { success: true }, args), second])
    ).toEqual([first, second]);
  });
});
