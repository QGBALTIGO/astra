/** Customer and WhatsApp finance share the existing expenses ledger. */
import { createHash, randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';

export type CustomerTransactionType = 'income' | 'expense';
export type CustomerTransactionStatus = 'settled' | 'pending';

export interface CustomerCategory {
  id: string;
  name: string;
  type: CustomerTransactionType;
  color: string;
  archived: boolean;
}

export interface CustomerTransaction {
  id: string;
  description: string;
  amount: number;
  currency: 'BRL';
  type: CustomerTransactionType;
  status: CustomerTransactionStatus;
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  date: string;
  notes: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerTransactionInput {
  description: string;
  amount: number;
  type: CustomerTransactionType;
  status: CustomerTransactionStatus;
  categoryId: string;
  date: string;
  notes?: string | null;
}

export interface CustomerTransactionQuery {
  from?: string;
  to?: string;
  type?: CustomerTransactionType | 'all';
  status?: CustomerTransactionStatus | 'all';
  categoryId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface CustomerFinanceSummary {
  period: { from: string; to: string };
  currency: 'BRL';
  income: number;
  expenses: number;
  result: number;
  pendingIncome: number;
  pendingExpenses: number;
  series: Array<{ date: string; income: number; expenses: number }>;
  categories: Array<{ id: string; name: string; color: string; total: number; percentage: number }>;
  recent: CustomerTransaction[];
}

export class CustomerFinanceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
    this.name = 'CustomerFinanceError';
  }
}

interface CategoryRow extends CustomerCategory {
  legacy_key: string | null;
  name_key: string;
  request_fingerprint?: string | null;
}

interface TransactionRow {
  id: string;
  description: string;
  amount: string;
  transaction_type: CustomerTransactionType;
  status: CustomerTransactionStatus;
  category_id: string;
  category_name: string;
  category_color: string;
  date: string;
  notes: string | null;
  source: string;
  created_at: string | Date;
  updated_at: string | Date;
  request_fingerprint: string | null;
  deleted_at?: string | Date | null;
}

const EXPENSE_DEFAULTS = [
  ['food', 'Alimentação', '#2563EB'],
  ['housing', 'Moradia', '#4F46E5'],
  ['transport', 'Transporte', '#0891B2'],
  ['utilities', 'Contas da casa', '#0D9488'],
  ['health', 'Saúde', '#059669'],
  ['entertainment', 'Lazer', '#7C3AED'],
  ['education', 'Educação', '#9333EA'],
  ['shopping', 'Compras', '#C026D3'],
  ['travel', 'Viagens', '#DB2777'],
  ['subscription', 'Assinaturas', '#D97706'],
  ['electronics', 'Eletrônicos', '#EA580C'],
  ['other', 'Outros', '#64748B'],
] as const;
const INCOME_DEFAULTS = [
  ['salary', 'Salário', '#2563EB'],
  ['services', 'Serviços', '#0891B2'],
  ['sales', 'Vendas', '#059669'],
  ['investments', 'Rendimentos', '#7C3AED'],
  ['other', 'Outras entradas', '#64748B'],
] as const;

function categoryNameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
}

export function customerMoneyCents(amount: number): number {
  const cents = Math.round(amount * 100);
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    cents <= 0 ||
    cents > 999_999_999_999 ||
    !Number.isSafeInteger(cents) ||
    amount !== cents / 100
  ) {
    throw new CustomerFinanceError(
      'Informe um valor positivo de até R$ 9.999.999.999,99, com no máximo duas casas decimais.'
    );
  }
  return cents;
}

function moneyFromCents(value: string | number): number {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents))
    throw new CustomerFinanceError('O total excede o limite de precisão do relatório.', 409);
  return cents / 100;
}

function moneyFromDecimal(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error('Invalid stored monetary amount');
  const cents = BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return moneyFromCents(String(match[1] ? -cents : cents));
}

export function validateCustomerFinanceDate(date: string): string {
  if (
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    throw new CustomerFinanceError('Informe uma data válida no formato AAAA-MM-DD.');
  }
  return date;
}

function validateRange(from?: string, to?: string): void {
  if (from !== undefined) validateCustomerFinanceDate(from);
  if (to !== undefined) validateCustomerFinanceDate(to);
  if (from && to && (from > to || Date.parse(to) - Date.parse(from) > 3660 * 86_400_000)) {
    throw new CustomerFinanceError('Informe um período válido de até dez anos.');
  }
}

function cleanText(value: string, field: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > max ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new CustomerFinanceError(
      `${field} deve ter de 1 a ${max} caracteres, sem caracteres de controle.`
    );
  }
  return value.trim();
}

function validateInput(input: CustomerTransactionInput): CustomerTransactionInput {
  customerMoneyCents(input.amount);
  validateCustomerFinanceDate(input.date);
  if (
    !['income', 'expense'].includes(input.type) ||
    !['settled', 'pending'].includes(input.status)
  ) {
    throw new CustomerFinanceError('Tipo ou situação financeira inválidos.');
  }
  if (
    input.notes != null &&
    (typeof input.notes !== 'string' || input.notes.length > 2000 || /\u0000/.test(input.notes))
  ) {
    throw new CustomerFinanceError('As observações devem ter até 2000 caracteres.');
  }
  return {
    ...input,
    description: cleanText(input.description, 'A descrição', 160),
    categoryId: cleanText(input.categoryId, 'A categoria', 160),
    notes: input.notes?.trim() || null,
  };
}

function categoryFromRow(row: CategoryRow): CustomerCategory {
  return { id: row.id, name: row.name, type: row.type, color: row.color, archived: row.archived };
}

function transactionFromRow(row: TransactionRow): CustomerTransaction {
  return {
    id: row.id,
    description: row.description,
    amount: moneyFromDecimal(row.amount),
    currency: 'BRL',
    type: row.transaction_type,
    status: row.status,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryColor: row.category_color,
    date: row.date,
    notes: row.notes,
    source: row.source,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// The fallback also covers a WhatsApp insert committed after category backfill.
// Every join repeats the authenticated data scope, including fallback lookups.
const TRANSACTION_FROM = `FROM expenses AS e LEFT JOIN customer_categories AS c
  ON c.user_id = e.user_id AND c.id = COALESCE(e.category_id,
    (SELECT candidate.id FROM customer_categories AS candidate WHERE candidate.user_id = e.user_id
      AND candidate.type = e.transaction_type AND candidate.legacy_key = e.category AND NOT candidate.archived),
    (SELECT fallback.id FROM customer_categories AS fallback WHERE fallback.user_id = e.user_id
      AND fallback.type = e.transaction_type AND fallback.legacy_key = 'other'))`;
const TRANSACTION_SELECT = `SELECT e.*, c.id AS category_id, c.name AS category_name, c.color AS category_color ${TRANSACTION_FROM}`;

export class CustomerFinanceRepository extends BaseRepository {
  private prepared: Promise<void> | undefined;

  constructor(private readonly dataUserId: string) {
    super();
    if (!dataUserId?.trim())
      throw new CustomerFinanceError('A identidade do cliente é obrigatória.');
  }

  private async prepareCategories(): Promise<void> {
    if (!this.prepared)
      this.prepared = this.initializeCategories().catch((error) => {
        this.prepared = undefined;
        throw error;
      });
    return this.prepared;
  }

  private async initializeCategories(): Promise<void> {
    await this.transaction(async () => {
      await this.lockLedger();
      await this.initializeCategoriesLocked();
    });
  }

  private async initializeCategoriesLocked(): Promise<void> {
    const legacy = await this.query<{
      category: string;
      transaction_type: CustomerTransactionType;
    }>(
      'SELECT DISTINCT category, transaction_type FROM expenses WHERE user_id = $1 AND category_id IS NULL',
      [this.dataUserId]
    );
    const defaults: Array<{
      key: string;
      name: string;
      color: string;
      type: CustomerTransactionType;
    }> = [
      ...EXPENSE_DEFAULTS.map(([key, name, color]) => ({
        key,
        name,
        color,
        type: 'expense' as const,
      })),
      ...INCOME_DEFAULTS.map(([key, name, color]) => ({
        key,
        name,
        color,
        type: 'income' as const,
      })),
    ];
    for (const item of legacy) {
      if (
        !defaults.some(
          (entry) =>
            entry.type === item.transaction_type &&
            (entry.key === item.category ||
              categoryNameKey(entry.name) === categoryNameKey(item.category))
        )
      ) {
        defaults.push({
          key: item.category,
          name: item.category.trim().slice(0, 120) || 'Sem categoria',
          color: '#64748B',
          type: item.transaction_type,
        });
      }
    }
    const values = defaults.map((entry) => ({
      ...entry,
      id: `cat_${createHash('sha256')
        .update(JSON.stringify([this.dataUserId, entry.type, entry.key]))
        .digest('hex')}`,
      name_key: categoryNameKey(entry.name),
    }));
    await this.execute(
      `INSERT INTO customer_categories (id, user_id, type, name, name_key, color, legacy_key)
      SELECT v.id, $1, v.type, v.name, v.name_key, v.color, v.key
      FROM jsonb_to_recordset($2::jsonb) AS v(id text, type text, name text, name_key text, color text, key text)
      ON CONFLICT DO NOTHING`,
      [this.dataUserId, JSON.stringify(values)]
    );
    if (legacy.length === 0) return;
    const categories = await this.query<CategoryRow>(
      'SELECT * FROM customer_categories WHERE user_id = $1',
      [this.dataUserId]
    );
    const links = legacy.map((item) => {
      const category =
        categories.find(
          (entry) =>
            !entry.archived &&
            entry.type === item.transaction_type &&
            (entry.legacy_key === item.category ||
              entry.name_key === categoryNameKey(item.category))
        ) ??
        categories.find(
          (entry) => entry.type === item.transaction_type && entry.legacy_key === 'other'
        );
      if (!category) throw new Error('Missing finance fallback category');
      return { category: item.category, type: item.transaction_type, id: category.id };
    });
    await this.execute(
      `UPDATE expenses AS e SET category_id = link.id
      FROM jsonb_to_recordset($2::jsonb) AS link(category text, type text, id text)
      WHERE e.user_id = $1 AND e.category_id IS NULL AND e.category = link.category
        AND e.transaction_type = link.type`,
      [this.dataUserId, JSON.stringify(links)]
    );
  }

  async listCategories(): Promise<CustomerCategory[]> {
    await this.prepareCategories();
    const rows = await this.query<CategoryRow>(
      'SELECT * FROM customer_categories WHERE user_id = $1 ORDER BY type, archived, name, id',
      [this.dataUserId]
    );
    return rows.map(categoryFromRow);
  }

  /** Match lock order across transaction edits and category transfers. */
  private async lockLedger(): Promise<void> {
    await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
      `customer-finance:${this.dataUserId}`,
    ]);
  }

  private async categoryForWrite(
    id: string,
    type: CustomerTransactionType,
    allowArchived = false
  ): Promise<CategoryRow> {
    const row = await this.queryOne<CategoryRow>(
      'SELECT * FROM customer_categories WHERE user_id = $1 AND id = $2 FOR SHARE',
      [this.dataUserId, id]
    );
    if (!row || row.type !== type || (row.archived && !allowArchived)) {
      throw new CustomerFinanceError(
        'Escolha uma categoria ativa do mesmo tipo do lançamento.',
        409
      );
    }
    return row;
  }

  private async readTransaction(
    id: string,
    lock = false,
    includeDeleted = false
  ): Promise<TransactionRow | null> {
    return this.queryOne<TransactionRow>(
      `${TRANSACTION_SELECT} WHERE e.user_id = $1 AND e.id = $2 AND e.currency = 'BRL'${includeDeleted ? '' : ' AND e.deleted_at IS NULL'}${lock ? ' FOR UPDATE OF e' : ''}`,
      [this.dataUserId, id]
    );
  }

  async getTransaction(id: string): Promise<CustomerTransaction | null> {
    await this.prepareCategories();
    const row = await this.readTransaction(id);
    return row ? transactionFromRow(row) : null;
  }

  async createTransaction(
    input: CustomerTransactionInput,
    idempotencyKey?: string
  ): Promise<CustomerTransaction> {
    const validated = validateInput(input);
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
      throw new CustomerFinanceError('Chave de idempotência inválida.');
    }
    await this.prepareCategories();
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          validated.description,
          customerMoneyCents(validated.amount),
          validated.type,
          validated.status,
          validated.categoryId,
          validated.date,
          validated.notes,
        ])
      )
      .digest('hex');
    const id = idempotencyKey
      ? `exp_ui_${createHash('sha256')
          .update(JSON.stringify([this.dataUserId, idempotencyKey]))
          .digest('hex')}`
      : `exp_${randomUUID()}`;
    return this.transaction(async () => {
      await this.lockLedger();
      if (idempotencyKey) {
        const existing = await this.readTransaction(id, false, true);
        if (existing) {
          if (existing.deleted_at)
            throw new CustomerFinanceError(
              'Esse lançamento já foi excluído. Use uma nova tentativa para cadastrar outro.',
              409
            );
          if (existing.request_fingerprint !== fingerprint)
            throw new CustomerFinanceError(
              'Esta tentativa já foi usada para outro lançamento. Reabra o formulário para criar outro.',
              409
            );
          return transactionFromRow(existing);
        }
      }
      const category = await this.categoryForWrite(validated.categoryId, validated.type);
      await this.execute(
        `INSERT INTO expenses (id, user_id, date, amount, currency, category, category_id,
        description, notes, source, transaction_type, status, request_fingerprint)
        VALUES ($1, $2, $3, $4::numeric, 'BRL', $5, $6, $7, $8, 'customer', $9, $10, $11)
        ON CONFLICT (id) DO NOTHING`,
        [
          id,
          this.dataUserId,
          validated.date,
          (customerMoneyCents(validated.amount) / 100).toFixed(2),
          category.legacy_key ?? category.name,
          category.id,
          validated.description,
          validated.notes,
          validated.type,
          validated.status,
          fingerprint,
        ]
      );
      const stored = await this.readTransaction(id);
      if (!stored) throw new Error('Transaction persistence could not be confirmed');
      if (stored.request_fingerprint !== fingerprint)
        throw new CustomerFinanceError(
          'A chave de idempotência já foi usada para outro lançamento.',
          409
        );
      return transactionFromRow(stored);
    });
  }

  /** Provider message IDs share the existing exp_ch key space; replay never edits a record. */
  async createFromChannel(
    input: Omit<CustomerTransactionInput, 'categoryId'> & { categoryKey: string },
    sourceKey: string
  ): Promise<{ transaction: CustomerTransaction; created: boolean }> {
    if (!/^[a-f0-9]{64}$/i.test(sourceKey))
      throw new CustomerFinanceError('Identificador da mensagem inválido.');
    await this.prepareCategories();
    const id = `exp_ch_${createHash('sha256')
      .update(JSON.stringify([this.dataUserId, sourceKey]))
      .digest('hex')}`;
    return this.transaction(async () => {
      await this.lockLedger();
      const existing = await this.readTransaction(id, false, true);
      if (existing?.deleted_at)
        throw new CustomerFinanceError(
          'Esse lançamento já foi excluído e não será recriado por uma mensagem repetida.',
          409
        );
      if (existing) return { transaction: transactionFromRow(existing), created: false };
      const category = await this.queryOne<CategoryRow>(
        `SELECT * FROM customer_categories
        WHERE user_id = $1 AND type = $2 AND legacy_key IN ($3, 'other') AND NOT archived
        ORDER BY CASE WHEN legacy_key = $3 THEN 0 ELSE 1 END LIMIT 1 FOR SHARE`,
        [this.dataUserId, input.type, input.categoryKey]
      );
      if (!category) throw new Error('No category for channel transaction');
      const valid = validateInput({ ...input, categoryId: category.id });
      const inserted = await this.execute(
        `INSERT INTO expenses (id, user_id, date, amount, currency, category,
        category_id, description, notes, source, transaction_type, status)
        VALUES ($1, $2, $3, $4::numeric, 'BRL', $5, $6, $7, $8, 'channel', $9, $10)
        ON CONFLICT (id) DO NOTHING`,
        [
          id,
          this.dataUserId,
          valid.date,
          (customerMoneyCents(valid.amount) / 100).toFixed(2),
          category.legacy_key ?? category.name,
          category.id,
          valid.description,
          valid.notes,
          valid.type,
          valid.status,
        ]
      );
      const stored = await this.readTransaction(id);
      if (!stored) throw new Error('Channel transaction persistence could not be confirmed');
      return { transaction: transactionFromRow(stored), created: inserted.changes === 1 };
    });
  }

  /** Explicitly settle one named pending record; never infer between matches. */
  async settleFromChannel(input: {
    description: string;
    type: CustomerTransactionType;
    date: string;
    sourceKey: string;
  }): Promise<
    | { outcome: 'missing' }
    | { outcome: 'ambiguous' }
    | { outcome: 'settled' | 'duplicate'; transaction: CustomerTransaction }
  > {
    const description = cleanText(input.description, 'A descrição', 160).replace(/\s+/g, ' ');
    validateCustomerFinanceDate(input.date);
    if (!['income', 'expense'].includes(input.type) || !/^[a-f0-9]{64}$/i.test(input.sourceKey))
      throw new CustomerFinanceError('Confirmação financeira inválida.');
    await this.prepareCategories();
    return this.transaction(async () => {
      await this.lockLedger();
      const previous = await this.queryOne<{ transaction_id: string }>(
        'SELECT transaction_id FROM customer_finance_operations WHERE user_id = $1 AND source_key = $2',
        [this.dataUserId, input.sourceKey]
      );
      if (previous) {
        const recorded = await this.readTransaction(previous.transaction_id);
        return recorded
          ? { outcome: 'duplicate' as const, transaction: transactionFromRow(recorded) }
          : { outcome: 'missing' as const };
      }
      const matches = await this.query<{ id: string }>(
        `SELECT id FROM expenses WHERE user_id = $1
        AND transaction_type = $2 AND status = 'pending' AND currency = 'BRL' AND deleted_at IS NULL
        AND LOWER(REGEXP_REPLACE(BTRIM(description), '\\s+', ' ', 'g')) = LOWER($3)
        ORDER BY id LIMIT 2 FOR UPDATE`,
        [this.dataUserId, input.type, description]
      );
      if (matches.length === 0) return { outcome: 'missing' as const };
      if (matches.length !== 1) return { outcome: 'ambiguous' as const };
      const id = matches[0]!.id;
      await this.execute(
        `UPDATE expenses SET status = 'settled', date = $3, updated_at = NOW()
        WHERE user_id = $1 AND id = $2 AND status = 'pending' AND deleted_at IS NULL`,
        [this.dataUserId, id, input.date]
      );
      await this.execute(
        `INSERT INTO customer_finance_operations (user_id, source_key, transaction_id, kind)
        VALUES ($1, $2, $3, 'settle')`,
        [this.dataUserId, input.sourceKey, id]
      );
      const recorded = await this.readTransaction(id);
      if (!recorded) throw new Error('Settlement persistence could not be confirmed');
      return { outcome: 'settled' as const, transaction: transactionFromRow(recorded) };
    });
  }

  async updateTransaction(
    id: string,
    patch: Partial<CustomerTransactionInput>
  ): Promise<CustomerTransaction | null> {
    await this.prepareCategories();
    return this.transaction(async () => {
      await this.lockLedger();
      const row = await this.readTransaction(id, true);
      if (!row) return null;
      const previous = transactionFromRow(row);
      const input = validateInput({ ...previous, ...patch });
      if (
        input.amount !== previous.amount ||
        input.type !== previous.type ||
        input.status !== previous.status
      ) {
        const linked = await this.queryOne<{ id: string }>(
          'SELECT id FROM finance_obligation_payments WHERE user_id = $1 AND expense_id = $2',
          [this.dataUserId, id]
        );
        if (linked)
          throw new CustomerFinanceError(
            'Este pagamento está vinculado a um financiamento. O valor e a situação devem ser ajustados no financiamento.',
            409
          );
      }
      const category = await this.categoryForWrite(
        input.categoryId,
        input.type,
        input.categoryId === previous.categoryId && input.type === previous.type
      );
      await this.execute(
        `UPDATE expenses SET date = $3, amount = $4::numeric, description = $5,
        notes = $6, transaction_type = $7, status = $8, category_id = $9, category = $10, updated_at = NOW()
        WHERE user_id = $1 AND id = $2`,
        [
          this.dataUserId,
          id,
          input.date,
          (customerMoneyCents(input.amount) / 100).toFixed(2),
          input.description,
          input.notes,
          input.type,
          input.status,
          category.id,
          category.legacy_key ?? category.name,
        ]
      );
      const updated = await this.readTransaction(id);
      if (!updated) throw new Error('Updated transaction not found');
      return transactionFromRow(updated);
    });
  }

  async deleteTransaction(id: string): Promise<boolean> {
    await this.prepareCategories();
    return this.transaction(async () => {
      await this.lockLedger();
      if (!(await this.readTransaction(id, true))) return false;
      const linked = await this.queryOne<{ id: string }>(
        'SELECT id FROM finance_obligation_payments WHERE user_id = $1 AND expense_id = $2',
        [this.dataUserId, id]
      );
      if (linked)
        throw new CustomerFinanceError(
          'Este lançamento está vinculado a um financiamento e não pode ser excluído isoladamente.',
          409
        );
      const result = await this.execute(
        "UPDATE expenses SET deleted_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND id = $2 AND currency = 'BRL' AND deleted_at IS NULL",
        [this.dataUserId, id]
      );
      return result.changes === 1;
    });
  }

  private filters(query: CustomerTransactionQuery): { where: string; params: unknown[] } {
    validateRange(query.from, query.to);
    if (query.type && !['all', 'income', 'expense'].includes(query.type))
      throw new CustomerFinanceError('Tipo inválido.');
    if (query.status && !['all', 'settled', 'pending'].includes(query.status))
      throw new CustomerFinanceError('Situação inválida.');
    const clauses = ['e.user_id = $1', "e.currency = 'BRL'", 'e.deleted_at IS NULL'];
    const params: unknown[] = [this.dataUserId];
    const add = (column: string, operator: string, value: unknown) => {
      params.push(value);
      clauses.push(`${column} ${operator} $${params.length}`);
    };
    if (query.from) add('e.date', '>=', query.from);
    if (query.to) add('e.date', '<=', query.to);
    if (query.type && query.type !== 'all') add('e.transaction_type', '=', query.type);
    if (query.status && query.status !== 'all') add('e.status', '=', query.status);
    if (query.categoryId) add('c.id', '=', cleanText(query.categoryId, 'A categoria', 160));
    if (query.search)
      add(
        'e.description',
        'ILIKE',
        `%${this.escapeLike(cleanText(query.search, 'A busca', 160))}%`
      );
    return { where: clauses.join(' AND '), params };
  }

  async listTransactions(query: CustomerTransactionQuery = {}): Promise<{
    transactions: CustomerTransaction[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 30;
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100_000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      throw new CustomerFinanceError('Paginação inválida.');
    }
    const { where, params } = this.filters(query);
    await this.prepareCategories();
    return this.transaction(async () => {
      await this.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const count = await this.queryOne<{ total: string }>(
        `SELECT COUNT(*)::text AS total ${TRANSACTION_FROM} WHERE ${where}`,
        params
      );
      const rows = await this.query<TransactionRow>(
        `${TRANSACTION_SELECT} WHERE ${where}
        ORDER BY e.date DESC, e.created_at DESC, e.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize]
      );
      return {
        transactions: rows.map(transactionFromRow),
        total: Number(count?.total ?? 0),
        page,
        pageSize,
      };
    });
  }

  async listPending(from: string, to: string): Promise<CustomerTransaction[]> {
    const { where, params } = this.filters({ from, to, status: 'pending' });
    await this.prepareCategories();
    const rows = await this.query<TransactionRow>(
      `${TRANSACTION_SELECT} WHERE ${where} ORDER BY e.date, e.created_at, e.id`,
      params
    );
    return rows.map(transactionFromRow);
  }

  /** Complete BRL export; no UI pagination cap or silent truncation. */
  async exportTransactions(): Promise<CustomerTransaction[]> {
    await this.prepareCategories();
    const rows = await this.query<TransactionRow>(
      `${TRANSACTION_SELECT}
      WHERE e.user_id = $1 AND e.currency = 'BRL' AND e.deleted_at IS NULL
      ORDER BY e.date, e.created_at, e.id`,
      [this.dataUserId]
    );
    return rows.map(transactionFromRow);
  }

  async summary(from: string, to: string): Promise<CustomerFinanceSummary> {
    validateRange(from, to);
    await this.prepareCategories();
    return this.transaction(async () => {
      await this.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const params = [this.dataUserId, from, to];
      const base =
        "e.user_id = $1 AND e.currency = 'BRL' AND e.deleted_at IS NULL AND e.date >= $2 AND e.date <= $3";
      const totals = await this.queryOne<{
        income: string;
        expenses: string;
        pending_income: string;
        pending_expenses: string;
      }>(
        `SELECT COALESCE(SUM(amount * 100) FILTER (WHERE transaction_type = 'income' AND status = 'settled'), 0)::text AS income,
          COALESCE(SUM(amount * 100) FILTER (WHERE transaction_type = 'expense' AND status = 'settled'), 0)::text AS expenses,
          COALESCE(SUM(amount * 100) FILTER (WHERE transaction_type = 'income' AND status = 'pending'), 0)::text AS pending_income,
          COALESCE(SUM(amount * 100) FILTER (WHERE transaction_type = 'expense' AND status = 'pending'), 0)::text AS pending_expenses
         FROM expenses AS e WHERE ${base}`,
        params
      );
      const seriesRows = await this.query<{ date: string; income: string; expenses: string }>(
        `SELECT e.date, COALESCE(SUM(amount * 100) FILTER (WHERE transaction_type = 'income'), 0)::text AS income,
          COALESCE(SUM(amount * 100) FILTER (WHERE transaction_type = 'expense'), 0)::text AS expenses
         FROM expenses AS e WHERE ${base} AND status = 'settled' GROUP BY e.date ORDER BY e.date`,
        params
      );
      const categoryRows = await this.query<{
        id: string;
        name: string;
        color: string;
        total: string;
      }>(
        `SELECT c.id, c.name, c.color, SUM(e.amount * 100)::text AS total ${TRANSACTION_FROM}
         WHERE ${base} AND e.transaction_type = 'expense' AND e.status = 'settled'
         GROUP BY c.id, c.name, c.color ORDER BY SUM(e.amount) DESC, c.id`,
        params
      );
      const recent = await this.query<TransactionRow>(
        `${TRANSACTION_SELECT} WHERE ${base} ORDER BY e.date DESC, e.created_at DESC, e.id DESC LIMIT 8`,
        params
      );
      const income = moneyFromCents(totals?.income ?? '0');
      const expenses = moneyFromCents(totals?.expenses ?? '0');
      const dayTotals = new Map(
        seriesRows.map((row) => [
          row.date,
          { income: moneyFromCents(row.income), expenses: moneyFromCents(row.expenses) },
        ])
      );
      const series: CustomerFinanceSummary['series'] = [];
      for (
        let day = Date.parse(`${from}T00:00:00Z`);
        day <= Date.parse(`${to}T00:00:00Z`);
        day += 86_400_000
      ) {
        const date = new Date(day).toISOString().slice(0, 10);
        series.push({ date, ...(dayTotals.get(date) ?? { income: 0, expenses: 0 }) });
      }
      return {
        period: { from, to },
        currency: 'BRL',
        income,
        expenses,
        result: moneyFromCents(Number(totals?.income ?? 0) - Number(totals?.expenses ?? 0)),
        pendingIncome: moneyFromCents(totals?.pending_income ?? '0'),
        pendingExpenses: moneyFromCents(totals?.pending_expenses ?? '0'),
        series,
        categories: categoryRows.map((row) => ({
          id: row.id,
          name: row.name,
          color: row.color,
          total: moneyFromCents(row.total),
          percentage:
            expenses > 0 ? Math.round((Number(row.total) / (expenses * 100)) * 10_000) / 100 : 0,
        })),
        recent: recent.map(transactionFromRow),
      };
    });
  }

  async createCategory(
    input: { name: string; type: CustomerTransactionType; color: string },
    idempotencyKey?: string
  ): Promise<CustomerCategory> {
    const name = cleanText(input.name, 'O nome', 120);
    if (!['income', 'expense'].includes(input.type) || !/^#[a-f\d]{6}$/i.test(input.color))
      throw new CustomerFinanceError('Tipo ou cor de categoria inválidos.');
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))
      throw new CustomerFinanceError('Chave de idempotência inválida.');
    const id = idempotencyKey
      ? `cat_ui_${createHash('sha256')
          .update(JSON.stringify([this.dataUserId, idempotencyKey]))
          .digest('hex')}`
      : `cat_${randomUUID()}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([name, input.type, input.color.toUpperCase()]))
      .digest('hex');
    await this.prepareCategories();
    return this.transaction(async () => {
      await this.lockLedger();
      if (idempotencyKey) {
        const existing = await this.queryOne<CategoryRow>(
          'SELECT * FROM customer_categories WHERE user_id = $1 AND id = $2',
          [this.dataUserId, id]
        );
        if (existing) {
          if (existing.request_fingerprint !== fingerprint)
            throw new CustomerFinanceError(
              'A chave de idempotência já foi usada para outra categoria.',
              409
            );
          return categoryFromRow(existing);
        }
      }
      const count = await this.queryOne<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM customer_categories WHERE user_id = $1',
        [this.dataUserId]
      );
      if (Number(count?.count ?? 0) >= 200)
        throw new CustomerFinanceError('O limite é de 200 categorias por cliente.', 409);
      const row = await this.queryOne<CategoryRow>(
        `INSERT INTO customer_categories (id, user_id, type, name, name_key, color, request_fingerprint)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING *`,
        [
          id,
          this.dataUserId,
          input.type,
          name,
          categoryNameKey(name),
          input.color.toUpperCase(),
          fingerprint,
        ]
      );
      if (!row)
        throw new CustomerFinanceError('Já existe uma categoria com esse nome e tipo.', 409);
      return categoryFromRow(row);
    });
  }

  async updateCategory(
    id: string,
    patch: { name?: string; color?: string; archived?: boolean }
  ): Promise<CustomerCategory | null> {
    if (patch.name !== undefined) cleanText(patch.name, 'O nome', 120);
    if (patch.color !== undefined && !/^#[a-f\d]{6}$/i.test(patch.color))
      throw new CustomerFinanceError('Cor inválida.');
    if (patch.archived !== undefined && typeof patch.archived !== 'boolean')
      throw new CustomerFinanceError('Estado de categoria inválido.');
    await this.prepareCategories();
    return this.transaction(async () => {
      await this.lockLedger();
      const row = await this.queryOne<CategoryRow>(
        'SELECT * FROM customer_categories WHERE user_id = $1 AND id = $2 FOR UPDATE',
        [this.dataUserId, id]
      );
      if (!row) return null;
      if (row.legacy_key === 'other' && patch.archived)
        throw new CustomerFinanceError(
          'Mantenha a categoria padrão disponível para lançamentos sem categoria.',
          409
        );
      const name = patch.name?.trim() ?? row.name;
      const duplicate = await this.queryOne<{ id: string }>(
        'SELECT id FROM customer_categories WHERE user_id = $1 AND type = $2 AND name_key = $3 AND id <> $4',
        [this.dataUserId, row.type, categoryNameKey(name), id]
      );
      if (duplicate)
        throw new CustomerFinanceError('Já existe uma categoria com esse nome e tipo.', 409);
      const updated = await this.queryOne<CategoryRow>(
        `UPDATE customer_categories SET name = $3, name_key = $4,
        color = $5, archived = $6, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *`,
        [
          this.dataUserId,
          id,
          name,
          categoryNameKey(name),
          patch.color?.toUpperCase() ?? row.color,
          patch.archived ?? row.archived,
        ]
      );
      return updated ? categoryFromRow(updated) : null;
    });
  }

  async deleteCategory(
    id: string,
    transferToId?: string
  ): Promise<{ deleted: boolean; archived: boolean } | null> {
    if (transferToId === id)
      throw new CustomerFinanceError('Escolha outra categoria para transferir.');
    await this.prepareCategories();
    return this.transaction(async () => {
      await this.lockLedger();
      const rows = await this.query<CategoryRow>(
        'SELECT * FROM customer_categories WHERE user_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE',
        [this.dataUserId, transferToId ? [id, transferToId] : [id]]
      );
      const category = rows.find((row) => row.id === id);
      if (!category) return null;
      if (category.legacy_key === 'other')
        throw new CustomerFinanceError(
          'A categoria padrão preserva os lançamentos sem categoria e não pode ser excluída.',
          409
        );
      if (transferToId) {
        const destination = rows.find((row) => row.id === transferToId);
        if (!destination || destination.archived || destination.type !== category.type)
          throw new CustomerFinanceError(
            'Escolha uma categoria ativa do mesmo tipo para transferir.',
            409
          );
        await this.execute(
          'UPDATE expenses SET category_id = $3, category = $4, updated_at = NOW() WHERE user_id = $1 AND category_id = $2',
          [this.dataUserId, id, destination.id, destination.legacy_key ?? destination.name]
        );
      }
      const usage = await this.queryOne<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM expenses WHERE user_id = $1 AND category_id = $2',
        [this.dataUserId, id]
      );
      if (
        Number(usage?.count ?? 0) > 0 ||
        category.legacy_key !== null ||
        category.request_fingerprint
      ) {
        await this.execute(
          'UPDATE customer_categories SET archived = TRUE, updated_at = NOW() WHERE user_id = $1 AND id = $2',
          [this.dataUserId, id]
        );
        return { deleted: false, archived: true };
      }
      await this.execute('DELETE FROM customer_categories WHERE user_id = $1 AND id = $2', [
        this.dataUserId,
        id,
      ]);
      return { deleted: true, archived: false };
    });
  }
}
