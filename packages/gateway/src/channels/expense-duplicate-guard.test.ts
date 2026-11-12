import { describe, expect, it } from 'vitest';
import { ExpenseDuplicateGuard } from './expense-duplicate-guard.js';
const draft = { date: '2026-11-11', amount: 1, currency: 'BRL' as const,
  category: 'other', description: 'dinheiro', source: 'channel' as const };
describe('Astra pending expense confirmation', () => {
  it('only accepts explicit separate expense confirmation once', () => {
    const guard = new ExpenseDuplicateGuard();
    guard.remember('person-a', draft, 1000);
    expect(guard.consume('person-a', 'Outro', 1100)).toEqual({ kind: 'other', draft });
    expect(guard.consume('person-a', 'Outro', 1200)).toBeNull();
  });
  it('does not turn an ambiguous yes or unrelated message into another write', () => {
    const guard = new ExpenseDuplicateGuard();
    guard.remember('person', draft, 0);
    expect(guard.consume('person', 'Sim', 1000)).toBeNull();
    expect(guard.consume('person', 'Outro', 1100)).toBeNull();
  });
  it('supports the same-expense reply and enforces account isolation and TTL', () => {
    const guard = new ExpenseDuplicateGuard();
    guard.remember('a', draft, 0);
    expect(guard.consume('b', 'Outro', 100)).toBeNull();
    expect(guard.consume('a', 'O mesmo', 200)).toEqual({ kind: 'same' });
    guard.remember('a', draft, 0);
    expect(guard.consume('a', 'Outro', 190_000)).toBeNull();
  });
});
