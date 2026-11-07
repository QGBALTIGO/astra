/**
 * Tests for retention-service.ts.
 *
 * Tests the retention cleanup scheduling and worker registration.
 * The actual cleanup methods are mocked — we verify orchestration, not
 * that individual repo cleanup methods work (those have their own tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnqueue = vi.fn();
const mockStartWorker = vi.fn().mockReturnValue(() => {});
const mockGetInstance = vi.fn().mockReturnValue({
  enqueue: mockEnqueue,
  startWorker: mockStartWorker,
});

vi.mock('./job-queue-service.js', () => ({
  JobQueueService: {
    getInstance: () => mockGetInstance(),
  },
}));

const mockCleanupOld = vi.fn().mockResolvedValue(0);
const mockCleanupOldHistory = vi.fn().mockResolvedValue(5);
const mockCleanupOldAuditLog = vi.fn().mockResolvedValue(2);
const mockCleanupOldWorkflowLogs = vi.fn().mockResolvedValue(3);
const mockCleanupHistory = vi.fn().mockResolvedValue(1);
const mockHeartbeatCleanup = vi.fn().mockResolvedValue(0);
const mockEmbeddingCleanup = vi.fn().mockResolvedValue(10);
const mockJobsCleanup = vi.fn().mockResolvedValue(0);
const mockJobsCleanupHistory = vi.fn().mockResolvedValue(0);
const mockProviderMetricsPurge = vi.fn().mockResolvedValue(0);

vi.mock('../db/repositories/claws.js', () => ({
  getClawsRepository: () => ({
    cleanupOldHistory: mockCleanupOldHistory,
    cleanupOldAuditLog: mockCleanupOldAuditLog,
  }),
}));

vi.mock('../db/repositories/jobs.js', () => ({
  getJobsRepository: () => ({
    cleanupOld: mockJobsCleanup,
    cleanupHistory: mockJobsCleanupHistory,
  }),
}));

vi.mock('../db/repositories/workflows/index.js', () => ({
  createWorkflowsRepository: () => ({
    cleanupOldWorkflowLogs: mockCleanupOldWorkflowLogs,
  }),
}));

vi.mock('../db/repositories/triggers.js', () => ({
  createTriggersRepository: () => ({
    cleanupHistory: mockCleanupHistory,
  }),
}));

vi.mock('../db/repositories/heartbeats/log.js', () => ({
  getHeartbeatLogRepository: () => ({
    cleanupOld: mockHeartbeatCleanup,
  }),
}));

vi.mock('../db/repositories/embedding-cache.js', () => ({
  embeddingCacheRepo: {
    cleanupOld: mockEmbeddingCleanup,
  },
}));

vi.mock('../db/repositories/logs.js', () => ({
  createLogsRepository: () => ({
    cleanupOld: mockCleanupOld,
  }),
}));

vi.mock('../db/repositories/costs/provider-metrics.js', () => ({
  getProviderMetricsRepository: () => ({
    purgeOld: mockProviderMetricsPurge,
  }),
}));

vi.mock('./log.js', () => ({
  getLog: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { scheduleRetentionCleanup, registerRetentionCleanupWorker } =
  await import('./retention-service.js');

describe('retention-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('scheduleRetentionCleanup', () => {
    it('enqueues a nightly_retention_cleanup job', () => {
      const jobId = scheduleRetentionCleanup(2);

      expect(jobId).toBe('nightly_retention_cleanup');
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      const [name, payload, options] = mockEnqueue.mock.calls[0]!;
      expect(name).toBe('nightly_retention_cleanup');
      expect(payload).toHaveProperty('scheduledUtc');
      expect(options).toHaveProperty('queue', 'system');
      expect(options).toHaveProperty('runAfter');
    });

    it('calculates runAfter as tomorrow at the specified UTC hour', () => {
      scheduleRetentionCleanup(3);

      const options = mockEnqueue.mock.calls[0]![2] as { runAfter: Date };
      expect(options.runAfter.getUTCHours()).toBe(3);
      // Should be tomorrow (or later)
      const now = new Date();
      expect(options.runAfter.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe('registerRetentionCleanupWorker', () => {
    it('starts a worker and returns a stop function', () => {
      const stop = registerRetentionCleanupWorker();

      expect(mockStartWorker).toHaveBeenCalledTimes(1);
      const [, opts] = mockStartWorker.mock.calls[0]!;
      expect(opts).toMatchObject({ queue: 'system', concurrency: 1 });
      expect(typeof stop).toBe('function');
    });
  });
});
