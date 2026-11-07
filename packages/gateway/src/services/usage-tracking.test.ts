/**
 * Tests for usage-tracking.ts — gateway-wide singleton wiring.
 *
 * This module instantiates UsageTracker and BudgetManager on import and
 * wires DB persistence. Tests verify the singletons are exported and
 * the budget alert handler doesn't crash.
 */

import { describe, it, expect } from 'vitest';
import { usageTracker, budgetManager } from './usage-tracking.js';

describe('usage-tracking', () => {
  it('exports a UsageTracker instance', () => {
    expect(usageTracker).toBeDefined();
    expect(typeof usageTracker.record).toBe('function');
    expect(typeof usageTracker.setRecordCallback).toBe('function');
  });

  it('exports a BudgetManager instance', () => {
    expect(budgetManager).toBeDefined();
    expect(typeof budgetManager.getStatus).toBe('function');
    expect(typeof budgetManager.canSpend).toBe('function');
    expect(typeof budgetManager.on).toBe('function');
    expect(typeof budgetManager.emit).toBe('function');
  });

  it('budgetManager alert event listener does not crash on emit', () => {
    // The module registers an 'alert' listener on budgetManager.
    // Verify emitting an alert doesn't throw.
    expect(() => {
      budgetManager.emit('alert', {
        type: 'test',
        threshold: 100,
        currentSpend: 50,
        limit: 100,
      });
    }).not.toThrow();
  });
});
