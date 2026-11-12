import { describe, expect, it } from 'vitest';
import { CustomerPlanningRepository } from './customer-planning.js';

type Call = { sql: string; params?: unknown[] };

class MemoryPlanning extends CustomerPlanningRepository {
  calls: Call[] = [];
  count = 0;
  rows: Record<string, unknown>[] = [];
  override async queryOne<T extends object>(sql: string, params?: unknown[]): Promise<T | null> {
    this.calls.push({ sql, params });
    if (sql.includes('COUNT(*)')) return { count: String(this.count) } as T;
    if (sql.includes('RETURNING')) {
      const [id, , kind, title, amount, progress, category, total, paid, due, notes] = params!;
      return {
        id,
        kind,
        title,
        amount_cents: String(amount),
        progress_cents: String(progress),
        category_id: category,
        installments_total: total,
        installments_paid: paid,
        next_due_date: due,
        notes,
        created_at: '2026-11-11T12:00:00Z',
        updated_at: '2026-11-11T12:00:00Z',
      } as T;
    }
    return (this.rows[0] as T) ?? null;
  }
  override async query<T extends object>(sql: string, params?: unknown[]): Promise<T[]> {
    this.calls.push({ sql, params });
    return this.rows as T[];
  }
  override async execute(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    this.calls.push({ sql, params });
    return { changes: 1 };
  }
}

describe('isolated customer planning records', () => {
  it('saves a zero-progress goal with exact cents, scoped to the logged-in user', async () => {
    const repo = new MemoryPlanning('whatsapp:test-a');
    const plan = await repo.create({ kind: 'goal', title: 'Reserva', amount: 2000, progress: 0 });
    expect(plan).toMatchObject({ title: 'Reserva', kind: 'goal', amount: 2000, progress: 0 });
    const write = repo.calls.find((entry) => entry.sql.includes('INSERT INTO'));
    expect(write?.params?.[1]).toBe('whatsapp:test-a');
    expect(write?.params?.[4]).toBe(200000);
    expect(write?.params?.[5]).toBe(0);
  });

  it('validates realistic budgets and installment progress', async () => {
    const repo = new MemoryPlanning('whatsapp:test');
    await expect(
      repo.create({ kind: 'budget', title: 'Alimentação', amount: 350, categoryId: 'food' })
    ).resolves.toMatchObject({ kind: 'budget', categoryId: 'food' });
    await expect(
      repo.create({
        kind: 'installment',
        title: 'Carro',
        amount: 470,
        installmentsTotal: 12,
        installmentsPaid: 3,
      })
    ).resolves.toMatchObject({
      kind: 'installment',
      installmentsTotal: 12,
      installmentsPaid: 3,
    });
    await expect(
      repo.create({ kind: 'goal', title: 'Inválida', amount: 20, progress: 21 })
    ).rejects.toThrow(/ultrapassar/);
    await expect(
      repo.create({ kind: 'budget', title: 'Sem categoria', amount: 100 })
    ).rejects.toThrow(/categoria/);
    await expect(
      repo.create({
        kind: 'installment',
        title: 'Impossível',
        amount: 470,
        installmentsTotal: 4,
        installmentsPaid: 5,
      })
    ).rejects.toThrow(/parcelas/);
  });

  it('rejects floating-point and negative amounts rather than rounding silently', async () => {
    const repo = new MemoryPlanning('whatsapp:test');
    await expect(
      repo.create({ kind: 'subscription', title: 'Internet', amount: 99.999 })
    ).rejects.toThrow(/casas decimais/);
    await expect(
      repo.create({ kind: 'goal', title: 'Reserva', amount: 200, progress: -1 })
    ).rejects.toThrow();
  });

  it('returns only rows scoped by user and caps the initial list', async () => {
    const repo = new MemoryPlanning('whatsapp:test-b');
    await repo.list();
    expect(repo.calls[0]?.sql).toContain('WHERE user_id = $1');
    expect(repo.calls[0]?.params).toEqual(['whatsapp:test-b']);
    await repo.get('other-id');
    expect(repo.calls[1]?.params).toEqual(['other-id', 'whatsapp:test-b']);
    await repo.delete('other-id');
    expect(repo.calls[2]?.sql).toContain('WHERE id = $1 AND user_id = $2');
    expect(repo.calls[2]?.params).toEqual(['other-id', 'whatsapp:test-b']);
  });

  it('rejects more than 80 stored plans without inventing entries', async () => {
    const repo = new MemoryPlanning('whatsapp:test');
    repo.count = 80;
    await expect(repo.create({ kind: 'goal', title: 'Extra', amount: 20 })).rejects.toThrow(/80/);
    expect(repo.calls.some((entry) => entry.sql.includes('INSERT INTO'))).toBe(false);
  });
});
