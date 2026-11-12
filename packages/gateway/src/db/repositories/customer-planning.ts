/** Private personal planning records. No automatic financial transactions are created. */
import { createHash, randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import { customerMoneyCents, validateCustomerFinanceDate } from './customer-finance.js';

export type PlanKind = 'goal' | 'budget' | 'installment' | 'subscription';

export interface CustomerPlanInput {
  kind: PlanKind;
  title: string;
  amount: number;
  progress?: number;
  categoryId?: string | null;
  installmentsTotal?: number | null;
  installmentsPaid?: number | null;
  nextDueDate?: string | null;
  notes?: string | null;
}

export interface CustomerPlan extends CustomerPlanInput {
  id: string;
  progress: number;
  categoryId: string | null;
  installmentsTotal: number | null;
  installmentsPaid: number | null;
  nextDueDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SubscriptionChange =
  | { action: 'create'; title: string; amount: number; nextDueDate: string }
  | { action: 'update'; title: string; amount?: number; nextDueDate?: string }
  | { action: 'remove'; title: string };

export type SubscriptionResult =
  | { status: 'created' | 'updated' | 'exists' | 'removed'; plan: CustomerPlan }
  | { status: 'ambiguous'; plans: CustomerPlan[] }
  | { status: 'missing' | 'replay' | 'conflict' | 'limit' | 'inactive' };

export function subscriptionTitleKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/gu, ' ')
    .trim();
}

interface PlanRow {
  id: string;
  kind: PlanKind;
  title: string;
  amount_cents: string | number;
  progress_cents: string | number;
  category_id: string | null;
  installments_total: number | null;
  installments_paid: number | null;
  next_due_date: string | null;
  notes: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

// PostgreSQL DATE is a civil day. Returning it as text avoids pg translating local
// midnight to a JavaScript instant (which can fall on the previous UTC day).
const PLAN_FIELDS =
  'id, kind, title, amount_cents, progress_cents, category_id, installments_total, installments_paid, ' +
  "to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, notes, created_at, updated_at";

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function map(row: PlanRow): CustomerPlan {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    amount: Number(row.amount_cents) / 100,
    progress: Number(row.progress_cents) / 100,
    categoryId: row.category_id,
    installmentsTotal: row.installments_total,
    installmentsPaid: row.installments_paid,
    nextDueDate: row.next_due_date,
    notes: row.notes,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function validate(input: CustomerPlanInput): Required<CustomerPlanInput> {
  const amount = customerMoneyCents(input.amount);
  const rawProgress = input.progress ?? 0;
  const progress = Math.round(rawProgress * 100);
  if (
    !Number.isFinite(rawProgress) ||
    !Number.isSafeInteger(progress) ||
    progress < 0 ||
    progress > 999_999_999_999 ||
    progress / 100 !== rawProgress
  ) {
    throw new Error('Valor guardado inválido.');
  }
  const categoryId = input.categoryId?.trim() || null;
  const installmentsTotal = input.installmentsTotal ?? null;
  const installmentsPaid = input.installmentsPaid ?? null;
  if (
    !['goal', 'budget', 'installment', 'subscription'].includes(input.kind) ||
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.trim().length > 120 ||
    /[\u0000-\u001f]/.test(input.title)
  ) {
    throw new Error('Dados do planejamento inválidos.');
  }
  if (amount <= 0 || progress < 0) throw new Error('Valores devem ser positivos.');
  if (input.kind === 'goal' && progress > amount) {
    throw new Error('O valor guardado não pode ultrapassar a meta.');
  }
  if (input.kind === 'budget' && !categoryId) throw new Error('Selecione uma categoria.');
  if (
    input.kind === 'installment' &&
    (!Number.isInteger(installmentsTotal) ||
      installmentsTotal! < 1 ||
      installmentsTotal! > 360 ||
      !Number.isInteger(installmentsPaid) ||
      installmentsPaid! < 0 ||
      installmentsPaid! > installmentsTotal!)
  )
    throw new Error('Confira a quantidade de parcelas.');
  if (input.kind !== 'installment' && (installmentsTotal !== null || installmentsPaid !== null)) {
    throw new Error('Parcelas são exclusivas de financiamentos.');
  }
  if (input.kind !== 'goal' && progress !== 0) {
    throw new Error('Apenas metas permitem indicar valor guardado.');
  }
  if (input.nextDueDate) validateCustomerFinanceDate(input.nextDueDate);
  if (input.notes != null && (input.notes.length > 500 || /[\u0000-\u001f]/.test(input.notes))) {
    throw new Error('Observações inválidas.');
  }
  return {
    kind: input.kind,
    title: input.title.trim(),
    amount: amount / 100,
    progress: progress / 100,
    categoryId,
    installmentsTotal,
    installmentsPaid,
    nextDueDate: input.nextDueDate ?? null,
    notes: input.notes?.trim() || null,
  };
}

export class CustomerPlanningRepository extends BaseRepository {
  constructor(private readonly userId: string) {
    super();
    if (!userId || !userId.trim()) throw new Error('Sem conta para planejamento.');
  }

  async list(): Promise<CustomerPlan[]> {
    const rows = await this.query<PlanRow>(
      `SELECT ${PLAN_FIELDS} FROM customer_plans WHERE user_id = $1 ORDER BY updated_at DESC, id LIMIT 81`,
      [this.userId]
    );
    return rows.slice(0, 80).map(map);
  }

  async get(id: string): Promise<CustomerPlan | null> {
    const row = await this.queryOne<PlanRow>(
      `SELECT ${PLAN_FIELDS} FROM customer_plans WHERE id = $1 AND user_id = $2`,
      [id, this.userId]
    );
    return row ? map(row) : null;
  }

  async subscriptions(): Promise<CustomerPlan[]> {
    const rows = await this.query<PlanRow>(
      `SELECT ${PLAN_FIELDS} FROM customer_plans WHERE user_id = $1 AND kind = 'subscription' ORDER BY customer_plans.next_due_date NULLS LAST, title, id`,
      [this.userId]
    );
    return rows.map(map);
  }

  async changeSubscription(
    requestKey: string,
    change: SubscriptionChange,
    canWrite: () => Promise<boolean>
  ): Promise<SubscriptionResult> {
    const fingerprint = createHash('sha256').update(JSON.stringify(change)).digest('hex');
    return this.transaction(async () => {
      await this.lockPlans();
      const previous = await this.queryOne<{ fingerprint: string }>(
        'SELECT fingerprint FROM customer_subscription_requests WHERE user_id = $1 AND request_key = $2',
        [this.userId, requestKey]
      );
      if (previous) return { status: previous.fingerprint === fingerprint ? 'replay' : 'conflict' };
      // Lock the selected kind before inspecting or modifying the row. The panel can edit
      // title, notes, date, amount and even kind concurrently.
      const rows = await this.query<PlanRow>(
        `SELECT ${PLAN_FIELDS} FROM customer_plans WHERE user_id = $1 AND kind = 'subscription' ORDER BY id FOR UPDATE`,
        [this.userId]
      );
      // The channel's access can expire or be revoked while waiting for the locks.
      if (!(await canWrite())) return { status: 'inactive' };
      await this.execute(
        'INSERT INTO customer_subscription_requests (user_id, request_key, fingerprint) VALUES ($1,$2,$3)',
        [this.userId, requestKey, fingerprint]
      );
      const matches = rows
        .filter((row) =>
          change.title.startsWith('#')
            ? '#' + row.id === change.title
            : subscriptionTitleKey(row.title) === subscriptionTitleKey(change.title)
        )
        .map(map);
      if (matches.length > 1) return { status: 'ambiguous', plans: matches };
      const match = matches[0];
      if (change.action === 'create') {
        if (match) return { status: 'exists', plan: match };
        if (await this.atLimit()) return { status: 'limit' };
        return {
          status: 'created',
          plan: await this.insert(validate({ ...change, kind: 'subscription' })),
        };
      }
      if (!match) return { status: 'missing' };
      if (change.action === 'remove') {
        return (await this.delete(match.id))
          ? { status: 'removed', plan: match }
          : { status: 'missing' };
      }
      const plan = await this.update(match.id, {
        ...match,
        amount: change.amount ?? match.amount,
        nextDueDate: change.nextDueDate ?? match.nextDueDate,
      });
      return plan ? { status: 'updated', plan } : { status: 'missing' };
    });
  }

  private async lockPlans(): Promise<void> {
    await this.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      'customer-plans:' + this.userId,
    ]);
  }

  private async atLimit(): Promise<boolean> {
    const total = await this.queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM customer_plans WHERE user_id = $1',
      [this.userId]
    );
    return Number(total?.count ?? 0) >= 80;
  }

  async create(input: CustomerPlanInput): Promise<CustomerPlan> {
    const value = validate(input);
    return this.transaction(async () => {
      await this.lockPlans();
      if (await this.atLimit()) throw new Error('Limite de 80 planejamentos por conta.');
      return this.insert(value);
    });
  }

  private async insert(value: Required<CustomerPlanInput>): Promise<CustomerPlan> {
    const row = await this.queryOne<PlanRow>(
      `INSERT INTO customer_plans
         (id, user_id, kind, title, amount_cents, progress_cents, category_id,
          installments_total, installments_paid, next_due_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${PLAN_FIELDS}`,
      [
        randomUUID(),
        this.userId,
        value.kind,
        value.title,
        customerMoneyCents(value.amount),
        Math.round(value.progress * 100),
        value.categoryId,
        value.installmentsTotal,
        value.installmentsPaid,
        value.nextDueDate,
        value.notes,
      ]
    );
    if (!row) throw new Error('Não foi possível salvar o planejamento.');
    return map(row);
  }

  async update(id: string, input: CustomerPlanInput): Promise<CustomerPlan | null> {
    const value = validate(input);
    const row = await this.queryOne<PlanRow>(
      `UPDATE customer_plans SET
          kind = $3, title = $4, amount_cents = $5, progress_cents = $6,
          category_id = $7, installments_total = $8, installments_paid = $9,
          next_due_date = $10, notes = $11, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 RETURNING ${PLAN_FIELDS}`,
      [
        id,
        this.userId,
        value.kind,
        value.title,
        customerMoneyCents(value.amount),
        Math.round(value.progress * 100),
        value.categoryId,
        value.installmentsTotal,
        value.installmentsPaid,
        value.nextDueDate,
        value.notes,
      ]
    );
    return row ? map(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.execute('DELETE FROM customer_plans WHERE id = $1 AND user_id = $2', [
      id,
      this.userId,
    ]);
    return result.changes > 0;
  }
}
