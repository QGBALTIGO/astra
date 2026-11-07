/**
 * Tests for jobified-level-runner.ts — runJobifiedLevel()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock workflow-node-job-handler BEFORE importing the module under test
// ---------------------------------------------------------------------------

const { mockEnqueue } = vi.hoisted(() => ({ mockEnqueue: vi.fn() }));

vi.mock('./workflow-node-job-handler.js', () => ({
  enqueueWorkflowLevel: mockEnqueue,
}));

import { runJobifiedLevel } from './jobified-level-runner.js';
import type { WorkflowNode } from '../../db/repositories/workflows/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string): WorkflowNode {
  return { id, type: 'toolNode', data: {} } as WorkflowNode;
}

function makeRepo(
  getLogFn: (logId: string) => Promise<{ nodeResults?: Record<string, unknown> } | null>
) {
  return { getLog: getLogFn };
}

const defaultNodeMap = new Map<string, WorkflowNode>([['n1', makeNode('n1')]]);
const defaultWorkflow = {
  edges: [] as { source: string; target: string; sourceHandle?: string }[],
  variables: {},
};
const defaultAbort = new AbortController().signal;
const defaultLogId = 'log-1';
const defaultNodeOutputs = {} as Record<string, unknown>;
const defaultDeps = { repo: makeRepo(async () => null) };
const defaultOptions = { pollIntervalMs: 10, maxWaitMs: 500 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runJobifiedLevel', () => {
  beforeEach(() => {
    mockEnqueue.mockReset();
    mockEnqueue.mockResolvedValue(undefined);
  });

  it('enqueues the level and polls until all nodes report completion', async () => {
    let pollCount = 0;
    const repo = makeRepo(async () => {
      pollCount++;
      // First poll: n1 not done yet
      if (pollCount === 1) return { nodeResults: {} };
      // Second poll: n1 done
      return { nodeResults: { n1: { nodeId: 'n1', status: 'success', output: { result: 42 } } } };
    });

    await runJobifiedLevel(
      'wf-1',
      ['n1'],
      defaultNodeMap,
      defaultWorkflow,
      'user1',
      defaultAbort,
      defaultLogId,
      defaultNodeOutputs,
      { repo },
      defaultOptions
    );

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(pollCount).toBe(2); // initial + one more after nodes complete
  });

  it('throws immediately if already aborted before enqueue', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(() =>
      runJobifiedLevel(
        'wf-1',
        ['n1'],
        defaultNodeMap,
        defaultWorkflow,
        'user1',
        ctrl.signal,
        defaultLogId,
        defaultNodeOutputs,
        defaultDeps,
        defaultOptions
      )
    ).rejects.toThrow('Workflow execution cancelled');

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('throws timeout error when maxWaitMs elapses before all nodes complete', async () => {
    const repo = makeRepo(async () => ({ nodeResults: {} })); // never completes

    const p = runJobifiedLevel(
      'wf-1',
      ['n1'],
      defaultNodeMap,
      defaultWorkflow,
      'user1',
      defaultAbort,
      defaultLogId,
      defaultNodeOutputs,
      { repo },
      { pollIntervalMs: 5, maxWaitMs: 30 }
    );

    await expect(p).rejects.toThrow('timed out');
  });

  it('completes immediately when all nodes already done on first poll', async () => {
    const repo = makeRepo(async () => ({
      nodeResults: { n1: { nodeId: 'n1', status: 'success', output: { result: 42 } } },
    }));

    await runJobifiedLevel(
      'wf-1',
      ['n1'],
      defaultNodeMap,
      defaultWorkflow,
      'user1',
      defaultAbort,
      defaultLogId,
      defaultNodeOutputs,
      { repo },
      defaultOptions
    );

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('treats error status as done', async () => {
    const repo = makeRepo(async () => ({
      nodeResults: { n1: { nodeId: 'n1', status: 'error', error: 'failed' } },
    }));

    await runJobifiedLevel(
      'wf-1',
      ['n1'],
      defaultNodeMap,
      defaultWorkflow,
      'user1',
      defaultAbort,
      defaultLogId,
      defaultNodeOutputs,
      { repo },
      defaultOptions
    );

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('treats skipped status as done', async () => {
    const repo = makeRepo(async () => ({
      nodeResults: { n1: { nodeId: 'n1', status: 'skipped' } },
    }));

    await runJobifiedLevel(
      'wf-1',
      ['n1'],
      defaultNodeMap,
      defaultWorkflow,
      'user1',
      defaultAbort,
      defaultLogId,
      defaultNodeOutputs,
      { repo },
      defaultOptions
    );

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
});
