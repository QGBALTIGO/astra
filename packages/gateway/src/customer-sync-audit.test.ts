import { describe, expect, it } from 'vitest';
import { customerSyncAuditSql, runCustomerSyncAudit } from './customer-sync-audit.js';

describe('explicit read-only customer support audit', () => {
  it('does nothing when not explicitly configured, including without database credentials', async () => {
    expect(await runCustomerSyncAudit({})).toBeNull();
  });
  it.each(['', '7364', '7364:2026-11-17:500;DELETE', '7364:2026-02-30:500', '7364:2026-11-17:0'])(
    'rejects an invalid reference before connecting: %s',
    (value) => {
      expect(() => customerSyncAuditSql(value)).toThrow();
    }
  );
  it('enforces read-only SQL and outputs only the bounded reported case', () => {
    const sql = customerSyncAuditSql('7364:2026-11-17:500');
    expect(sql).toMatch(/^BEGIN READ ONLY;/);
    expect(sql).toMatch(/ROLLBACK;\s*$/);
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COMMIT)\b/);
    expect(sql).toContain('ambiguous_suffix');
    expect(sql).toContain("x.date = '2026-11-17' AND x.amount * 100 = 500");
    expect(sql).not.toContain('token_hash');
    expect(sql).not.toContain('code_hash');
  });
});
