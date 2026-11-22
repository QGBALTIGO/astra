/**
 * Tests for retention-service.ts.
 *
 * Tests the retention cleanup scheduling and worker registration.
 * The actual cleanup methods are mocked — we verify orchestration, not
 * that individual repo cleanup methods work (those have their own tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
const mockQualityDetails = vi.fn().mockResolvedValue(0);
const mockQualityDaily = vi.fn().mockResolvedValue(0);
vi.mock('./outbound-quality.js', () => ({
  outboundQualityRepo: {
    cleanupDetail: mockQualityDetails,
    cleanupDaily: mockQualityDaily,
  },
}));

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
    mockEnqueue.mockResolvedValue('job-id');
  });
  afterEach(() => vi.useRealTimers());

  describe('scheduleRetentionCleanup', () => {
    it('enqueues a nightly_retention_cleanup job', async () => {
      const jobId = await scheduleRetentionCleanup(2);

      expect(jobId).toBe('nightly_retention_cleanup');
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      const [name, payload, options] = mockEnqueue.mock.calls[0]!;
      expect(name).toBe('nightly_retention_cleanup');
      expect(payload).toHaveProperty('scheduledUtc');
      expect(options).toHaveProperty('queue', 'system');
      expect(options).toHaveProperty('runAfter');
    });

    it('calculates a future runAfter at the specified UTC hour', async () => {
      await scheduleRetentionCleanup(3);

      const options = mockEnqueue.mock.calls[0]![2] as { runAfter: Date };
      expect(options.runAfter.getUTCHours()).toBe(3);
      // Should be tomorrow (or later)
      const now = new Date();
      expect(options.runAfter.getTime()).toBeGreaterThan(now.getTime());
    });

    it('uses today’s UTC slot when the service starts before the scheduled hour', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-15T01:00:00Z'));
      await scheduleRetentionCleanup(2);
      expect(mockEnqueue.mock.calls[0]![2].runAfter.toISOString()).toBe('2026-11-15T02:00:00.000Z');
    });

    it('keeps a stable daily reservation key across repeated startup scheduling', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
      await scheduleRetentionCleanup(2);
      await scheduleRetentionCleanup(2);
      expect(mockEnqueue.mock.calls.map((call) => call[2].deduplicationKey)).toEqual([
        '2026-11-16T02:00:00.000Z',
        '2026-11-16T02:00:00.000Z',
      ]);
    });

    it('reports a failed durable reservation to the boot caller', async () => {
      mockEnqueue.mockRejectedValueOnce(new Error('synthetic_queue_unavailable'));
      await expect(scheduleRetentionCleanup()).rejects.toThrow('synthetic_queue_unavailable');
    });
  });

  describe('registerRetentionCleanupWorker', () => {
    it('reserves the next day and asks the queue to retry a failed table cleanup', async () => {
      mockCleanupOldWorkflowLogs.mockRejectedValueOnce(new Error('synthetic_schema_failure'));
      registerRetentionCleanupWorker();
      const handler = mockStartWorker.mock.calls[0]![0];
      const job = { name: 'nightly_retention_cleanup', payload: {} };
      await expect(handler(job)).rejects.toThrow('Retention cleanup failed for: workflow_logs');
      expect(mockEnqueue).toHaveBeenCalledOnce();
      expect(mockJobsCleanup).toHaveBeenCalled();
      expect(await handler(job)).toMatchObject({
        cleaned: expect.arrayContaining([
          { table: 'workflow_logs', deleted: 3, retentionDays: 90 },
        ]),
      });
      expect(mockEnqueue.mock.calls[1]![2].deduplicationKey).toBe(
        mockEnqueue.mock.calls[0]![2].deduplicationKey
      );
    });
    it('starts a worker and returns a stop function', () => {
      const stop = registerRetentionCleanupWorker();

      expect(mockStartWorker).toHaveBeenCalledTimes(1);
      const [, opts] = mockStartWorker.mock.calls[0]!;
      expect(opts).toMatchObject({ queue: 'system', concurrency: 1 });
      expect(typeof stop).toBe('function');
    });

    it('persists the next daily run after a successful cleanup without a service restart', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-15T02:01:00Z'));
      registerRetentionCleanupWorker();
      const handler = mockStartWorker.mock.calls[0]![0];
      await handler({
        name: 'nightly_retention_cleanup',
        payload: { scheduledUtc: '2026-11-15T02:00:00Z' },
      });
      expect(mockEnqueue).toHaveBeenCalledOnce();
      expect(mockEnqueue.mock.calls[0]![2].runAfter.toISOString()).toBe('2026-11-16T02:00:00.000Z');
    });

    it('does not perform cleanup for an unrelated system job', async () => {
      registerRetentionCleanupWorker();
      const handler = mockStartWorker.mock.calls[0]![0];
      await expect(handler({ name: 'other', payload: {} })).rejects.toThrow(
        'Unexpected maintenance job'
      );
      expect(mockCleanupOld).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });
});
