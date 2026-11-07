import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log before importing the module
vi.mock('./log.js', () => ({
  getLog: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Dynamic repo mocks — set per-test via module caching
const mockClawsRepo = { getOrphanedSessions: vi.fn(), updateSessionStatus: vi.fn() };
const mockWorkflowsRepo = { getOrphanedRuns: vi.fn(), markRunFailed: vi.fn() };
const mockPlansRepo = { getOrphanedPlans: vi.fn(), markPlanFailed: vi.fn() };

vi.mock('../db/repositories/claws.js', () => ({
  getClawsRepository: vi.fn(() => mockClawsRepo),
}));

vi.mock('../db/repositories/workflows/index.js', () => ({
  createWorkflowsRepository: vi.fn(() => mockWorkflowsRepo),
}));

vi.mock('../db/repositories/plans.js', () => ({
  createPlansRepository: vi.fn(() => mockPlansRepo),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrphan(id: string, name = 'test-session'): { id: string; name: string } {
  return { id, name };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcileOrphanedSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClawsRepo.getOrphanedSessions.mockResolvedValue([]);
    mockClawsRepo.updateSessionStatus.mockResolvedValue(undefined);
    mockWorkflowsRepo.getOrphanedRuns.mockResolvedValue([]);
    mockWorkflowsRepo.markRunFailed.mockResolvedValue(undefined);
    mockPlansRepo.getOrphanedPlans.mockResolvedValue([]);
    mockPlansRepo.markPlanFailed.mockResolvedValue(undefined);
  });

  it('returns empty results when no orphaned sessions exist', async () => {
    const { reconcileOrphanedSessions } = await import('./orphan-reconciliation.js');
    const results = await reconcileOrphanedSessions();

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.orphaned).toBe(0);
      expect(r.recovered).toBe(0);
      expect(r.errors).toHaveLength(0);
    }
  });

  it('recovers orphaned claw sessions', async () => {
    mockClawsRepo.getOrphanedSessions.mockResolvedValue([
      makeOrphan('claw-1', 'alpha'),
      makeOrphan('claw-2', 'beta'),
    ]);
    mockClawsRepo.updateSessionStatus.mockResolvedValue(undefined);

    const { reconcileOrphanedSessions } = await import('./orphan-reconciliation.js');
    const results = await reconcileOrphanedSessions();

    const clawResult = results.find((r) => r.system === 'claw')!;
    expect(clawResult.orphaned).toBe(2);
    expect(clawResult.recovered).toBe(2);
    expect(clawResult.errors).toHaveLength(0);
    expect(mockClawsRepo.updateSessionStatus).toHaveBeenCalledTimes(2);
    expect(mockClawsRepo.updateSessionStatus).toHaveBeenCalledWith(
      'claw-1',
      'stopped',
      'orphan_recovery'
    );
    expect(mockClawsRepo.updateSessionStatus).toHaveBeenCalledWith(
      'claw-2',
      'stopped',
      'orphan_recovery'
    );
  });

  it('recovers orphaned workflow runs', async () => {
    mockWorkflowsRepo.getOrphanedRuns.mockResolvedValue([makeOrphan('wf-1', 'nightly-report')]);
    mockWorkflowsRepo.markRunFailed.mockResolvedValue(undefined);

    const { reconcileOrphanedSessions } = await import('./orphan-reconciliation.js');
    const results = await reconcileOrphanedSessions();

    const wfResult = results.find((r) => r.system === 'workflow')!;
    expect(wfResult.orphaned).toBe(1);
    expect(wfResult.recovered).toBe(1);
    expect(mockWorkflowsRepo.markRunFailed).toHaveBeenCalledWith('wf-1', 'orphan_recovery');
  });

  it('recovers orphaned plan executions', async () => {
    mockPlansRepo.getOrphanedPlans.mockResolvedValue([makeOrphan('plan-1', 'weekly-scan')]);
    mockPlansRepo.markPlanFailed.mockResolvedValue(undefined);

    const { reconcileOrphanedSessions } = await import('./orphan-reconciliation.js');
    const results = await reconcileOrphanedSessions();

    const planResult = results.find((r) => r.system === 'plan')!;
    expect(planResult.orphaned).toBe(1);
    expect(planResult.recovered).toBe(1);
    expect(mockPlansRepo.markPlanFailed).toHaveBeenCalledWith('plan-1', 'orphan_recovery');
  });

  it('continues recovering other sessions when one fails', async () => {
    mockClawsRepo.getOrphanedSessions.mockResolvedValue([
      makeOrphan('claw-1'),
      makeOrphan('claw-2'),
    ]);
    mockClawsRepo.updateSessionStatus
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('DB write failed'));

    const { reconcileOrphanedSessions } = await import('./orphan-reconciliation.js');
    const results = await reconcileOrphanedSessions();

    const clawResult = results.find((r) => r.system === 'claw')!;
    expect(clawResult.orphaned).toBe(2);
    expect(clawResult.recovered).toBe(1);
    expect(clawResult.errors).toHaveLength(1);
    expect(clawResult.errors[0]).toContain('claw-2');
    expect(clawResult.errors[0]).toContain('DB write failed');
  });

  it('handles repo.getOrphanedSessions throwing', async () => {
    mockClawsRepo.getOrphanedSessions.mockRejectedValue(new Error('Connection refused'));

    const { reconcileOrphanedSessions } = await import('./orphan-reconciliation.js');
    const results = await reconcileOrphanedSessions();

    const clawResult = results.find((r) => r.system === 'claw')!;
    expect(clawResult.orphaned).toBe(0);
    expect(clawResult.recovered).toBe(0);
    expect(clawResult.errors).toHaveLength(1);
    expect(clawResult.errors[0]).toContain('Connection refused');
  });

  it('handles repo.getOrphanedRuns throwing', async () => {
    mockWorkflowsRepo.getOrphanedRuns.mockRejectedValue(new Error('DB timeout'));

    const { reconcileOrphanedSessions } = await import('./orphan-reconciliation.js');
    const results = await reconcileOrphanedSessions();

    const wfResult = results.find((r) => r.system === 'workflow')!;
    expect(wfResult.errors).toHaveLength(1);
    expect(wfResult.errors[0]).toContain('DB timeout');
  });

  it('handles repo.getOrphanedPlans throwing', async () => {
    mockPlansRepo.getOrphanedPlans.mockRejectedValue(new Error('Table missing'));

    const { reconcileOrphanedSessions } = await import('./orphan-reconciliation.js');
    const results = await reconcileOrphanedSessions();

    const planResult = results.find((r) => r.system === 'plan')!;
    expect(planResult.errors).toHaveLength(1);
    expect(planResult.errors[0]).toContain('Table missing');
  });

  it('runs all three reconciliations in parallel via Promise.allSettled', async () => {
    mockClawsRepo.getOrphanedSessions.mockResolvedValue([makeOrphan('claw-1')]);
    mockWorkflowsRepo.getOrphanedRuns.mockResolvedValue([makeOrphan('wf-1')]);
    mockPlansRepo.getOrphanedPlans.mockResolvedValue([makeOrphan('plan-1')]);

    const { reconcileOrphanedSessions } = await import('./orphan-reconciliation.js');
    const start = Date.now();
    const results = await reconcileOrphanedSessions();
    const elapsed = Date.now() - start;

    // All three ran
    expect(results.map((r) => r.system).sort()).toEqual(['claw', 'plan', 'workflow']);
    // Each returned 1 recovered
    for (const r of results) {
      expect(r.orphaned).toBe(1);
      expect(r.recovered).toBe(1);
    }
    // Parallel execution should complete quickly (within 100ms with resolved mocks)
    expect(elapsed).toBeLessThan(500);
  });
});
