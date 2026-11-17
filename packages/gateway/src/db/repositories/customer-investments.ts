import { createHash } from 'node:crypto';
import { BaseRepository } from './base.js';
import {
  emptyInvestmentState,
  validateInvestmentState,
  type InvestmentState,
} from '../../services/investments/engine.js';

export const MAX_INVESTMENT_BOOK_BYTES = 10 * 1024 * 1024;
export type CustomerInvestmentBook = { state: InvestmentState; storageVersion: number };
type BookRow = { state: unknown; state_hash: string; storage_version: string | number };

export class CustomerInvestmentError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 409 | 413 = 400
  ) {
    super(message);
    this.name = 'CustomerInvestmentError';
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}

export function investmentBookHash(state: InvestmentState): string {
  return createHash('sha256').update(canonical(state)).digest('hex');
}

/** Validation never invents identifiers or silently provisions an example portfolio. */
export function validateCustomerInvestmentBook(value: unknown): InvestmentState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CustomerInvestmentError('Informe um livro de investimentos válido.');
  const data = value as Record<string, unknown>;
  const fields = new Set([
    'version',
    'revision',
    'marketRevision',
    'portfolios',
    'accounts',
    'assets',
    'operations',
    'quotes',
    'marketGaps',
  ]);
  if (Object.keys(data).some((key) => !fields.has(key)))
    throw new CustomerInvestmentError('O livro contém campos desconhecidos.');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_INVESTMENT_BOOK_BYTES)
    throw new CustomerInvestmentError('O livro deve ter no máximo 10 MiB.', 413);
  for (const field of ['portfolios', 'accounts', 'assets', 'operations', 'quotes']) {
    if (
      !Array.isArray(data[field]) ||
      data[field].some(
        (item) => !item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id
      )
    )
      throw new CustomerInvestmentError(
        'O livro está incompleto ou contém identificadores inválidos.'
      );
  }
  try {
    return validateInvestmentState(value);
  } catch (error) {
    throw new CustomerInvestmentError(
      error instanceof Error ? error.message : 'Livro de investimentos inválido.'
    );
  }
}

function mapped(row: BookRow): CustomerInvestmentBook {
  const storageVersion = Number(row.storage_version);
  if (!Number.isSafeInteger(storageVersion) || storageVersion < 0)
    throw new Error('Invalid investment storage version');
  return { state: validateCustomerInvestmentBook(row.state), storageVersion };
}

export class CustomerInvestmentsRepository extends BaseRepository {
  constructor(private readonly userId: string) {
    super();
    if (!userId?.trim() || userId === 'default')
      throw new CustomerInvestmentError('Entre no Astra para continuar.', 401);
  }

  async get(): Promise<CustomerInvestmentBook> {
    const row = await this.queryOne<BookRow>(
      'SELECT state, state_hash, storage_version FROM customer_investment_books WHERE user_id = $1',
      [this.userId]
    );
    return row ? mapped(row) : { state: emptyInvestmentState(), storageVersion: 0 };
  }

  async save(value: unknown, expectedStorageVersion: number): Promise<CustomerInvestmentBook> {
    if (!Number.isSafeInteger(expectedStorageVersion) || expectedStorageVersion < 0)
      throw new CustomerInvestmentError('A versão de armazenamento é inválida.');
    const state = validateCustomerInvestmentBook(value),
      hash = investmentBookHash(state);
    return this.transaction(async () => {
      const empty = emptyInvestmentState();
      // INSERT plus row lock serializes even two first writes for a previously empty account.
      await this.execute(
        'INSERT INTO customer_investment_books (user_id, state, state_hash, storage_version) VALUES ($1, $2::jsonb, $3, 0) ON CONFLICT (user_id) DO NOTHING',
        [this.userId, JSON.stringify(empty), investmentBookHash(empty)]
      );
      const current = await this.queryOne<BookRow>(
        'SELECT state, state_hash, storage_version FROM customer_investment_books WHERE user_id = $1 FOR UPDATE',
        [this.userId]
      );
      if (!current) throw new Error('Investment book missing after insert');
      const version = Number(current.storage_version);
      // A lost successful response may be retried without adding a revision or losing data.
      if (current.state_hash === hash) return mapped(current);
      if (version !== expectedStorageVersion || version >= Number.MAX_SAFE_INTEGER)
        throw new CustomerInvestmentError(
          'Os investimentos foram atualizados em outra janela. Atualize a carteira antes de salvar.',
          409
        );
      const saved = await this.queryOne<BookRow>(
        'UPDATE customer_investment_books SET state = $2::jsonb, state_hash = $3, storage_version = storage_version + 1, updated_at = NOW() WHERE user_id = $1 AND storage_version = $4 RETURNING state, state_hash, storage_version',
        [this.userId, JSON.stringify(state), hash, expectedStorageVersion]
      );
      if (!saved)
        throw new CustomerInvestmentError('A carteira mudou. Atualize antes de salvar.', 409);
      return mapped(saved);
    });
  }
}
