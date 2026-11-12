/**
 * Tests for WorkflowExecutionLocks.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowExecutionLocks } from './execution-locks.js';

describe('WorkflowExecutionLocks', () => {
  let locks: WorkflowExecutionLocks;

  beforeEach(() => {
    locks = new WorkflowExecutionLocks();
  });

  describe('tryAcquire', () => {
    it('returns an AbortController for a new workflow', () => {
      const controller = locks.tryAcquire('wf-1');
      expect(controller).toBeInstanceOf(AbortController);
    });

    it('returns null when the same workflow is already locked', () => {
      const first = locks.tryAcquire('wf-1');
      const second = locks.tryAcquire('wf-1');
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('allows different workflows to be acquired independently', () => {
      const a = locks.tryAcquire('wf-a');
      const b = locks.tryAcquire('wf-b');
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    });
  });

  describe('release', () => {
    it('removes the lock so the same workflow can be re-acquired', () => {
      const first = locks.tryAcquire('wf-1');
      locks.release('wf-1');
      const second = locks.tryAcquire('wf-1');
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
    });

    it('is a no-op for a workflow that was never locked', () => {
      expect(() => locks.release('wf-nonexistent')).not.toThrow();
    });
  });

  describe('cancel', () => {
    it('aborts the AbortController and returns true', () => {
      const controller = locks.tryAcquire('wf-1')!;
      expect(locks.cancel('wf-1')).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    });

    it('returns false for a workflow that was never locked', () => {
      expect(locks.cancel('wf-nonexistent')).toBe(false);
    });

    it('aborts without removing the lock entry (matches original semantics)', () => {
      locks.tryAcquire('wf-1');
      locks.cancel('wf-1');
      // Entry remains — only release() removes it
      expect(locks.isRunning('wf-1')).toBe(true);
    });

    it('aborting one workflow does not affect another', () => {
      const c1 = locks.tryAcquire('wf-a')!;
      locks.tryAcquire('wf-b')!;
      locks.cancel('wf-a');
      expect(c1.signal.aborted).toBe(true);
      expect(locks.isRunning('wf-b')).toBe(true);
    });
  });

  describe('isRunning', () => {
    it('returns false for a workflow that was never locked', () => {
      expect(locks.isRunning('wf-nonexistent')).toBe(false);
    });

    it('returns true after tryAcquire', () => {
      locks.tryAcquire('wf-1');
      expect(locks.isRunning('wf-1')).toBe(true);
    });

    it('returns true after cancel (lock not released until release() is called)', () => {
      locks.tryAcquire('wf-1');
      locks.cancel('wf-1');
      expect(locks.isRunning('wf-1')).toBe(true);
    });

    it('returns false after release', () => {
      locks.tryAcquire('wf-1');
      locks.release('wf-1');
      expect(locks.isRunning('wf-1')).toBe(false);
    });
  });
});
