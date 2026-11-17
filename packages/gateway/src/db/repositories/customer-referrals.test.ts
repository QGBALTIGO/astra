import { describe, expect, it } from 'vitest';
import { normalizePixKey, referralCycle, referralTokenHash } from './customer-referrals.js';
describe('referral period and payment data', () => {
  it('uses the Sao Paulo calendar month at UTC boundaries', () => {
    expect(referralCycle(new Date('2026-12-01T01:00:00Z'))).toBe('2026-11');
    expect(referralCycle(new Date('2026-12-01T04:00:00Z'))).toBe('2026-12');
  });
  it('hashes opaque visit tokens without embedding their value', () => {
    expect(referralTokenHash('secret-visit')).toMatch(/^[a-f0-9]{64}$/);
    expect(referralTokenHash('secret-visit')).not.toContain('secret-visit');
  });
  it('normalizes recognized Pix formats and rejects arbitrary/control input', () => {
    expect(normalizePixKey('  qa@example.test  ')).toBe('qa@example.test');
    expect(normalizePixKey('+55 (67) 99999-1111')).toBe('+5567999991111');
    expect(normalizePixKey('123.456.789-01')).toBe('12345678901');
    expect(normalizePixKey('123E4567-E89B-42D3-A456-426614174000')).toBe(
      '123e4567-e89b-42d3-a456-426614174000'
    );
    expect(() => normalizePixKey('foo')).toThrow();
    expect(() => normalizePixKey('<script>')).toThrow();
  });
});
