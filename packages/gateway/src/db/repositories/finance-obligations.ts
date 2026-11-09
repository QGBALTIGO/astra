/**
 * Financing liabilities, separated by owner. Historical paid amounts are an
 * opening balance, never a new expense; new payments are both a ledger entry
 * and an expense, committed in one PostgreSQL transaction.
 */
import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import { ExpensesRepository } from './expenses.js';

interface FinanceRow {
  id: string;
  name: string;
  principal_cents: string | number;
  opening_paid_cents: string | number;
  additional_paid_cents: string | number;
}

export interface FinanceBalance {
  id: string;
  name: string;
  principalCents: number;
  paidCents: number;
  remainingCents: number;
}

export type PaymentOutcome =
  | { status: 'missing' }
  | { status: 'duplicate' | 'exceeds' | 'recorded'; balance: FinanceBalance };

function validCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 9_000_000_000_000;
}

function cents(value: string | number): number {
  const numeric = Number(value);
  if (!validCents(numeric)) throw new Error('Invalid financing amount in database');
  return numeric;
}

export function financeNameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
}

function balanceFromRow(row: FinanceRow): FinanceBalance {
  const principalCents = cents(row.principal_cents);
  const paidCents = cents(row.opening_paid_cents) + cents(row.additional_paid_cents);
  return {
    id: row.id,
    name: row.name,
    principalCents,
    paidCents,
    remainingCents: Math.max(0, principalCents - paidCents),
  };
}

function localDay(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export class FinanceObligationsRepository extends BaseRepository {
  constructor(private readonly userId: string) {
    super();
    if (!userId || userId.trim() === '') throw new Error('Financing requires a user identity');
  }

  async find(name: string): Promise<FinanceBalance | null> {
    const row = await this.queryOne<FinanceRow>(
      [
        'SELECT o.*,',
        'COALESCE((SELECT SUM(p.amount_cents) FROM finance_obligation_payments p',
        'WHERE p.obligation_id = o.id AND p.user_id = o.user_id), 0) AS additional_paid_cents',
        'FROM finance_obligations o WHERE o.user_id = $1 AND o.name_key = $2',
      ].join(' '),
      [this.userId, financeNameKey(name)]
    );
    return row ? balanceFromRow(row) : null;
  }

  async createOrFind(
    name: string,
    principalCents: number,
    openingPaidCents: number
  ): Promise<{ balance: FinanceBalance; created: boolean }> {
    const key = financeNameKey(name);
    if (
      key.length < 2 ||
      key.length > 60 ||
      !validCents(principalCents) ||
      principalCents === 0 ||
      !validCents(openingPaidCents) ||
      openingPaidCents > principalCents
    ) {
      throw new Error('Invalid financing information');
    }
    // ON CONFLICT guarantees one account per user/name under concurrent messages.
    const row = await this.queryOne<{ id: string }>(
      [
        'INSERT INTO finance_obligations',
        '(id, user_id, name, name_key, principal_cents, opening_paid_cents)',
        'VALUES ($1, $2, $3, $4, $5, $6)',
        'ON CONFLICT (user_id, name_key) DO NOTHING RETURNING id',
      ].join(' '),
      [randomUUID(), this.userId, name.trim(), key, principalCents, openingPaidCents]
    );
    const balance = await this.find(name);
    if (!balance) throw new Error('Financing could not be verified after saving');
    return { balance, created: row !== null };
  }

  async recordPayment(
    name: string,
    amountCents: number,
    sourceKey: string
  ): Promise<PaymentOutcome> {
    if (!validCents(amountCents) || amountCents === 0 || !/^[a-f0-9]{64}$/i.test(sourceKey)) {
      throw new Error('Invalid financing payment');
    }
    return this.transaction(async (): Promise<PaymentOutcome> => {
      // Lock the owner-scoped liability so concurrent payments cannot overpay.
      const account = await this.queryOne<FinanceRow>(
        [
          'SELECT o.*, 0 AS additional_paid_cents FROM finance_obligations o',
          'WHERE user_id = $1 AND name_key = $2 FOR UPDATE',
        ].join(' '),
        [this.userId, financeNameKey(name)]
      );
      if (!account) return { status: 'missing' };

      const alreadyRecorded = await this.queryOne<{ id: string }>(
        'SELECT id FROM finance_obligation_payments WHERE user_id = $1 AND source_key = $2',
        [this.userId, sourceKey]
      );
      if (alreadyRecorded) {
        return { status: 'duplicate', balance: (await this.find(name))! };
      }

      const balance = await this.find(name);
      if (!balance) throw new Error('Financing disappeared during payment');
      if (amountCents > balance.remainingCents) return { status: 'exceeds', balance };

      const expense = await new ExpensesRepository(this.userId).create({
        date: localDay(new Date()),
        amount: amountCents / 100,
        currency: 'BRL',
        category: /carro|moto|veiculo|automovel/i.test(financeNameKey(name))
          ? 'transport'
          : 'other',
        description: 'Pagamento de ' + balance.name,
        source: 'financing',
        tags: ['financiamento'],
      });
      await this.execute(
        [
          'INSERT INTO finance_obligation_payments',
          '(id, obligation_id, user_id, amount_cents, expense_id, source_key)',
          'VALUES ($1, $2, $3, $4, $5, $6)',
        ].join(' '),
        [randomUUID(), balance.id, this.userId, amountCents, expense.id, sourceKey]
      );
      await this.execute(
        'UPDATE finance_obligations SET updated_at = NOW() WHERE id = $1 AND user_id = $2',
        [balance.id, this.userId]
      );
      // No manual math drift: always compute the balance from committed ledger rows.
      const updated = await this.find(name);
      if (!updated) throw new Error('Financing update could not be verified');
      return { status: 'recorded', balance: updated };
    });
  }
}
