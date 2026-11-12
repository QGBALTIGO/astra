import { describe, expect, it } from 'vitest';
import { planAccessState } from './PlanAccess';
import { customerFixture } from './test-fixtures';

describe('subscription expiry from the authenticated customer', () => {
  const now = new Date('2026-11-12T16:00:00Z');
  const customer = (expiry: string | null, status: 'active' | 'expired' = 'active') => ({
    ...customerFixture,
    access: { status, expiresAt: expiry, canWrite: status === 'active' },
  });
  it('shows the actual expiry and calendar days in the account timezone', () => {
    const result = planAccessState(customer('2026-12-12T16:00:00Z'), now);
    expect(result.status).toBe('active');
    expect(result.dateLabel).toBe('Válido até 12 de dezembro de 2026');
    expect(result.remaining).toBe('Faltam 30 dias');
  });
  it('recognizes today, tomorrow and the three-day renewal window', () => {
    expect(planAccessState(customer('2026-11-12T23:00:00Z'), now).remaining).toBe('Vence hoje');
    expect(planAccessState(customer('2026-11-13T16:00:00Z'), now).remaining).toBe('Vence amanhã');
    expect(planAccessState(customer('2026-11-15T16:00:00Z'), now).status).toBe('soon');
    expect(planAccessState(customer('2026-11-16T16:00:00Z'), now).status).toBe('active');
  });
  it('honors an expired server status and an elapsed expiry timestamp', () => {
    expect(planAccessState(customer('2026-11-12T15:59:59Z'), now).status).toBe('expired');
    expect(planAccessState(customer('2027-01-01T00:00:00Z', 'expired'), now).label).toBe(
      'Plano vencido'
    );
  });
  it('uses the local calendar date across UTC midnight instead of rounding 24-hour periods', () => {
    const result = planAccessState(customer('2026-11-13T02:00:00Z'), now);
    expect(result.remaining).toBe('Vence hoje');
    expect(result.dateLabel).toBe('Válido até 12 de novembro de 2026');
  });
  it('does not invent a deadline for absent or malformed dates', () => {
    expect(planAccessState(customer(null), now).dateLabel).toBe('Sem vencimento definido');
    expect(planAccessState(customer('bad'), now).dateLabel).toBe('Validade não informada');
    expect(planAccessState(customer(null, 'expired'), now).label).toBe('Plano vencido');
  });
});
