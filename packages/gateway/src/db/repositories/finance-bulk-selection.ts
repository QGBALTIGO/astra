import { createHash } from 'node:crypto';
import { BaseRepository } from './base.js';
import { validateCustomerFinanceDate } from './customer-finance.js';

export interface FinanceSelectionScope {
  userId: string;
  channelPluginId: string;
  platformChatId: string;
  senderId: string;
}
export interface FinanceSelectionFilter {
  type?: 'income' | 'expense';
  status?: 'pending' | 'settled';
  currency?: string;
  from?: string;
  to?: string;
  search?: string;
  planIds?: string[];
  ids?: string[];
}
interface Target {
  id: string;
  version: string;
}
interface Outcome {
  selected: number;
  deleted: number;
  changed: number;
  protected: number;
  remindersCancelled: number;
  alreadySending: number;
}
interface State {
  phase: 'read' | 'preview' | 'done';
  messageId: string;
  receivedAt: number;
  binding: string;
  filter: FinanceSelectionFilter;
  cutoff: number;
  targets?: Target[];
  protected?: number;
  result?: Outcome;
  consumedBy?: string;
  ambiguous?: boolean;
}
export type FinanceDeletionResult =
  | { kind: 'preview'; count: number; protected: number; filter: FinanceSelectionFilter }
  | { kind: 'done'; result: Outcome }
  | { kind: 'missing' | 'denied' | 'limit' | 'closed' };
const TTL = 10 * 60_000;
const MAX_TARGETS = 5000;
const keyFor = (scope: FinanceSelectionScope) =>
  'channel_finance_selection:' + createHash('sha256').update(JSON.stringify(scope)).digest('hex');
const resultKey = (scope: FinanceSelectionScope, id: string) =>
  keyFor(scope) + ':result:' + createHash('sha256').update(id).digest('hex');
const validOutcome = (value: Outcome | undefined): value is Outcome =>
  !!value &&
  ['selected', 'deleted', 'changed', 'protected', 'remindersCancelled', 'alreadySending'].every(
    (key) => Number.isSafeInteger(value[key as keyof Outcome]) && value[key as keyof Outcome] >= 0
  ) &&
  value.deleted + value.changed === value.selected;
function validFilter(filter: FinanceSelectionFilter): boolean {
  try {
    if (
      !filter ||
      typeof filter !== 'object' ||
      (filter.type !== undefined && !['income', 'expense'].includes(filter.type)) ||
      (filter.status !== undefined && !['pending', 'settled'].includes(filter.status)) ||
      (filter.currency !== undefined && !/^[A-Z]{3}$/u.test(filter.currency)) ||
      (filter.search !== undefined &&
        (typeof filter.search !== 'string' || filter.search.length > 160)) ||
      [filter.planIds, filter.ids].some(
        (ids) =>
          ids !== undefined &&
          (!Array.isArray(ids) ||
            ids.length > MAX_TARGETS ||
            ids.some((id) => typeof id !== 'string' || !id))
      )
    )
      return false;
    if (filter.from) validateCustomerFinanceDate(filter.from);
    if (filter.to) validateCustomerFinanceDate(filter.to);
    return !(filter.from && filter.to && filter.from > filter.to);
  } catch {
    return false;
  }
}
function decode(value: string | undefined): State | null {
  try {
    const state = JSON.parse(value ?? 'null') as State;
    return state &&
      ['read', 'preview', 'done'].includes(state.phase) &&
      typeof state.binding === 'string' &&
      typeof state.messageId === 'string' &&
      Number.isFinite(state.receivedAt) &&
      Number.isFinite(state.cutoff) &&
      validFilter(state.filter) &&
      (!state.targets ||
        (Array.isArray(state.targets) &&
          state.targets.length <= MAX_TARGETS &&
          state.targets.every(
            (target) =>
              typeof target.id === 'string' &&
              typeof target.version === 'string' &&
              /^\d+$/u.test(target.version)
          )))
      ? state
      : null;
  } catch {
    return null;
  }
}
export class FinanceBulkSelectionRepository extends BaseRepository {
  async hasPreview(scope: FinanceSelectionScope, binding: string): Promise<boolean> {
    const state = decode(
      (
        await this.queryOne<{ value: string }>('SELECT value FROM system_settings WHERE key=$1', [
          keyFor(scope),
        ])
      )?.value
    );
    return (
      !!state &&
      state.phase === 'preview' &&
      state.binding === binding &&
      Date.now() - state.receivedAt <= TTL &&
      state.receivedAt <= Date.now() + 5000
    );
  }
  async invalidateRead(scope: FinanceSelectionScope, messageId: string, at: Date, binding: string) {
    if (await this.hasPreview(scope, binding)) return;
    await this.remember(scope, {}, messageId, at, binding);
    await this.execute(
      `UPDATE system_settings SET value=jsonb_set(value::jsonb,'{ambiguous}','true')::text
       WHERE key=$1 AND value::jsonb->>'messageId'=$2 AND value::jsonb->>'binding'=$3`,
      [keyFor(scope), messageId, binding]
    );
  }
  async remember(
    scope: FinanceSelectionScope,
    filter: FinanceSelectionFilter,
    messageId: string,
    at: Date,
    binding: string
  ) {
    if (
      !validFilter(filter) ||
      !messageId ||
      !Number.isFinite(at.getTime()) ||
      Date.now() - at.getTime() > TTL ||
      at.getTime() > Date.now() + 5000
    )
      return;
    const state: State = {
      phase: 'read',
      messageId,
      receivedAt: at.getTime(),
      binding,
      filter,
      cutoff: Math.min(at.getTime(), Date.now()),
    };
    await this.execute(
      `INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=
       CASE WHEN (system_settings.value::jsonb->>'receivedAt')::numeric=$3
        AND ((system_settings.value::jsonb->'filter') IS DISTINCT FROM (EXCLUDED.value::jsonb->'filter')
         OR system_settings.value::jsonb->>'ambiguous'='true')
        THEN jsonb_set(EXCLUDED.value::jsonb,'{ambiguous}','true')::text ELSE EXCLUDED.value END
      WHERE (system_settings.value::jsonb->>'receivedAt')::numeric <= $3`,
      [keyFor(scope), JSON.stringify(state), state.receivedAt]
    );
  }
  private async incoming(
    scope: FinanceSelectionScope,
    current: string,
    previous?: string
  ): Promise<boolean> {
    const rows = await this.query<{ id: string }>(
      `SELECT id FROM channel_messages WHERE channel_id=$1 AND sender_id=$2
      AND direction='inbound' ORDER BY created_at DESC,id DESC LIMIT 2`,
      [scope.channelPluginId, scope.senderId]
    );
    return rows[0]?.id === current && (!previous || rows[1]?.id === previous);
  }
  private async save(scope: FinanceSelectionScope, state: State) {
    await this.execute(
      `INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
      [keyFor(scope), JSON.stringify(state)]
    );
  }
  async prepare(
    scope: FinanceSelectionScope,
    messageId: string,
    at: Date,
    binding: string,
    global: boolean,
    allowed: () => Promise<boolean>
  ): Promise<FinanceDeletionResult> {
    return this.transaction(async () => {
      await this.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [
        'customer-finance:' + scope.userId,
      ]);
      const prior = decode(
        (
          await this.queryOne<{ value: string }>(
            'SELECT value FROM system_settings WHERE key=$1 FOR UPDATE',
            [keyFor(scope)]
          )
        )?.value
      );
      if (prior?.phase === 'done' && prior.messageId === messageId) return { kind: 'closed' };
      if (!(await allowed())) return { kind: 'denied' };
      const fresh = (state: State) =>
        state.binding === binding &&
        at.getTime() >= state.receivedAt &&
        Date.now() - state.receivedAt <= TTL;
      if (prior?.phase === 'preview' && prior.messageId === messageId && fresh(prior))
        return {
          kind: 'preview',
          count: prior.targets?.length ?? 0,
          protected: prior.protected ?? 0,
          filter: prior.filter,
        };
      if (!global && (!prior || !fresh(prior) || prior.phase === 'done' || prior.ambiguous))
        return { kind: 'missing' };
      if (
        !(await this.incoming(
          scope,
          messageId,
          global || prior?.messageId === messageId ? undefined : prior!.messageId
        ))
      )
        return { kind: 'missing' };
      const filter = global ? {} : prior!.filter;
      const cutoff = global ? Math.min(at.getTime(), Date.now()) : prior!.cutoff;
      const params: unknown[] = [scope.userId, new Date(cutoff)];
      const clauses = [
        "e.user_id=$1 AND e.status='pending' AND e.deleted_at IS NULL AND e.created_at <= $2",
      ];
      if (filter.status === 'settled') clauses.push('FALSE');
      const add = (sql: string, value: unknown) => {
        params.push(value);
        clauses.push(sql.replace('?', '$' + params.length));
      };
      if (filter.type) add('e.transaction_type=?', filter.type);
      if (filter.currency) add('e.currency=?', filter.currency);
      if (filter.from) add('e.date>=?', filter.from);
      if (filter.to) add('e.date<=?', filter.to);
      if (filter.search)
        add("e.description ILIKE ? ESCAPE '\\'", '%' + this.escapeLike(filter.search) + '%');
      if (filter.planIds)
        add(
          'EXISTS (SELECT 1 FROM customer_receivable_items i JOIN customer_receivable_plans p ON p.id=i.plan_id WHERE p.user_id=e.user_id AND i.transaction_id=e.id AND p.id=ANY(?::text[]))',
          filter.planIds
        );
      if (filter.ids) add('e.id=ANY(?::text[])', filter.ids);
      const rows = await this.query<{ id: string; version: string; protected: boolean }>(
        `SELECT e.id,e.xmin::text AS version,
        (EXISTS(SELECT 1 FROM finance_obligation_payments f WHERE f.user_id=e.user_id AND f.expense_id=e.id)
         OR EXISTS(SELECT 1 FROM customer_planning_requests p WHERE p.user_id=e.user_id AND p.transaction_id=e.id)) AS protected
        FROM expenses e WHERE ${clauses.join(' AND ')} ORDER BY e.id LIMIT ${MAX_TARGETS + 1} FOR UPDATE OF e`,
        params
      );
      if (rows.length > MAX_TARGETS) return { kind: 'limit' };
      if (!(await allowed())) return { kind: 'denied' };
      const targets = rows
        .filter((row) => !row.protected)
        .map(({ id, version }) => ({ id, version }));
      const protectedCount = rows.length - targets.length;
      await this.save(scope, {
        phase: 'preview',
        messageId,
        receivedAt: at.getTime(),
        binding,
        filter,
        cutoff,
        targets,
        protected: protectedCount,
      });
      return { kind: 'preview', count: targets.length, protected: protectedCount, filter };
    });
  }
  async confirm(
    scope: FinanceSelectionScope,
    messageId: string,
    at: Date,
    binding: string,
    allowed: () => Promise<boolean>
  ): Promise<FinanceDeletionResult> {
    return this.transaction(async () => {
      await this.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [
        'customer-finance:' + scope.userId,
      ]);
      const replay = await this.queryOne<{ value: string }>(
        'SELECT value FROM system_settings WHERE key=$1',
        [resultKey(scope, messageId)]
      );
      if (replay) {
        let saved: { binding: string; result: Outcome } | null = null;
        try {
          saved = JSON.parse(replay.value);
        } catch {
          /* refuse corrupt receipt */
        }
        if (!(await allowed())) return { kind: 'denied' };
        return saved?.binding === binding && validOutcome(saved.result)
          ? { kind: 'done', result: saved.result }
          : { kind: 'closed' };
      }
      const state = decode(
        (
          await this.queryOne<{ value: string }>(
            'SELECT value FROM system_settings WHERE key=$1 FOR UPDATE',
            [keyFor(scope)]
          )
        )?.value
      );
      if (
        !state ||
        state.binding !== binding ||
        Date.now() - state.receivedAt > TTL ||
        at.getTime() < state.receivedAt
      )
        return { kind: 'missing' };
      if (!(await allowed())) return { kind: 'denied' };
      if (state.phase === 'done')
        return state.consumedBy === messageId && validOutcome(state.result)
          ? { kind: 'done', result: state.result }
          : { kind: 'closed' };
      if (
        state.phase !== 'preview' ||
        !state.targets ||
        !(await this.incoming(scope, messageId, state.messageId))
      )
        return { kind: 'missing' };
      const candidates = await this.query<{ id: string }>(
        `SELECT e.id FROM expenses e
        JOIN jsonb_to_recordset($2::jsonb) AS selected(id text,version text) ON selected.id=e.id AND selected.version=e.xmin::text
        WHERE e.user_id=$1 AND e.status='pending' AND e.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM finance_obligation_payments f WHERE f.user_id=e.user_id AND f.expense_id=e.id)
        AND NOT EXISTS(SELECT 1 FROM customer_planning_requests p WHERE p.user_id=e.user_id AND p.transaction_id=e.id)
        FOR UPDATE OF e`,
        [scope.userId, JSON.stringify(state.targets)]
      );
      if (!(await allowed())) return { kind: 'denied' };
      const ids = candidates.map((row) => row.id);
      const deleted = await this.query<{ id: string }>(
        `UPDATE expenses SET deleted_at=NOW(),updated_at=NOW()
        WHERE user_id=$1 AND id=ANY($2::text[]) AND status='pending' AND deleted_at IS NULL RETURNING id`,
        [scope.userId, ids]
      );
      const removed = deleted.map((row) => row.id);
      const mirror = `EXISTS(SELECT 1 FROM customer_receivable_items i JOIN customer_receivable_plans p ON p.id=i.plan_id
        WHERE p.user_id=r.user_id AND i.reminder_id=r.id AND i.transaction_id=ANY($2::text[]))`;
      const reminders = await this.query<{ id: string }>(
        `UPDATE channel_reminders r SET status='cancelled',updated_at=NOW()
        WHERE r.user_id=$1 AND r.status='pending' AND ${mirror} RETURNING r.id`,
        [scope.userId, removed]
      );
      const sending = await this.queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM channel_reminders r WHERE r.user_id=$1 AND r.status='sending' AND ${mirror}`,
        [scope.userId, removed]
      );
      // This is still inside the transaction: loss of access rolls back all changes.
      if (!(await allowed())) throw new Error('FINANCE_ACCESS_CHANGED');
      const result: Outcome = {
        selected: state.targets.length,
        deleted: removed.length,
        changed: state.targets.length - removed.length,
        protected: state.protected ?? 0,
        remindersCancelled: reminders.length,
        alreadySending: Number(sending?.count ?? 0),
      };
      state.phase = 'done';
      state.consumedBy = messageId;
      state.result = result;
      await this.save(scope, state);
      await this.execute('INSERT INTO system_settings(key,value) VALUES($1,$2)', [
        resultKey(scope, messageId),
        JSON.stringify({ binding, result }),
      ]);
      return { kind: 'done', result };
    });
  }
  async cancel(scope: FinanceSelectionScope, binding: string): Promise<boolean> {
    return this.transaction(async () => {
      const state = decode(
        (
          await this.queryOne<{ value: string }>(
            'SELECT value FROM system_settings WHERE key=$1 FOR UPDATE',
            [keyFor(scope)]
          )
        )?.value
      );
      if (
        !state ||
        state.phase !== 'preview' ||
        state.binding !== binding ||
        Date.now() - state.receivedAt > TTL
      )
        return false;
      await this.execute('DELETE FROM system_settings WHERE key=$1', [keyFor(scope)]);
      return true;
    });
  }
}
export const financeBulkSelectionRepo = new FinanceBulkSelectionRepository();
