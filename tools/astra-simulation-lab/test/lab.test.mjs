import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  CATEGORY_QUOTAS,
  TOTAL_SCENARIOS,
  PROFESSIONS,
  LANGUAGES,
  makePersona,
  makeStory,
  makeScenario,
  seeded,
  quotaCategories,
  storyArchetypes,
  templatesPerCategory,
} from '../engine.mjs';
import { runSourceProbes } from '../probes.mjs';

describe('Astra Simulation & Reliability Lab: synthetic fixtures', () => {
  it('meets the exact 100k distribution', () => {
    expect(TOTAL_SCENARIOS).toBe(100000);
    expect(Object.values(CATEGORY_QUOTAS).reduce((a, b) => a + b, 0)).toBe(100000);
    const categories = quotaCategories();
    expect(categories).toHaveLength(100000);
    expect(categories.filter((v) => v === 'finances')).toHaveLength(20000);
    expect(categories.filter((v) => v === 'calendar')).toHaveLength(16000);
    expect(categories.filter((v) => v === 'goals_debt')).toHaveLength(15000);
  });
  it('supports a varied population and independent long-lived stories', () => {
    expect(PROFESSIONS.length).toBeGreaterThanOrEqual(40);
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(9);
    expect(storyArchetypes().length).toBeGreaterThanOrEqual(10);
    expect(Object.values(templatesPerCategory()).every((n) => n >= 7)).toBe(true);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9999 }), (i) => {
        const p = makePersona(i);
        const story = makeStory(i, p);
        expect(p.synthetic).toBe(true);
        expect(story.synthetic).toBe(true);
        expect(story.personaId).toBe(p.id);
        expect(story.turns.length).toBeGreaterThanOrEqual(5);
        const timestamps = story.turns.map((t) => Date.parse(t.at));
        expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
        story.turns.forEach((t, k) => {
          expect(t.role).toBe('user');
          expect(t.expectedAction).toBeTruthy();
          expect(t.dependsOn).toBe(k ? story.turns[k - 1].id : null);
        });
        return true;
      }),
      { seed: 20261111, numRuns: 300 }
    );
  });
  it('is reproducible for any seed and does not generate actual phone numbers or email addresses', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: 1, max: 999999999 }),
        (index, seed) => {
          const p1 = makePersona(index, seed),
            p2 = makePersona(index, seed);
          expect(p1).toEqual(p2);
          expect(p1.id).toMatch(/^sim-person-/);
          expect(p1.email).toBeUndefined();
          expect(p1.phone).toBeUndefined();
          expect(p1.cpf).toBeUndefined();
          expect(makeStory(index, p1, seed)).toEqual(makeStory(index, p2, seed));
          return true;
        }
      ),
      { seed: 34, numRuns: 250 }
    );
  });
  it('never marks generated data as verified Astra executions', () => {
    const domains = Object.keys(CATEGORY_QUOTAS);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9999 }), (i) => {
        const p = makePersona(i),
          caseData = makeScenario(i, domains[i % domains.length], p);
        expect(caseData.synthetic).toBe(true);
        expect(caseData.expected.noRealSideEffects).toBe(true);
        expect(caseData.id).toMatch(/^sim-case-/);
        expect(caseData.text.length).toBeGreaterThan(2);
        expect(caseData.timeZone).toBe(p.timeZone);
        return true;
      }),
      { numRuns: 250 }
    );
  });
  it('uses seeded deterministic RNG for repeatable failures', () => {
    const a = seeded(8123),
      b = seeded(8123);
    const values = Array.from({ length: 100 }, () => a());
    expect(values).toEqual(Array.from({ length: 100 }, () => b()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});
describe('Astra source level regression probes', () => {
  it('executes actual pure functions from the Astra checked-out source', async () => {
    const result = await runSourceProbes();
    expect(result.total).toBeGreaterThanOrEqual(45);
    expect(result.failed, result.issues.map((i) => i.id).join('\n')).toBe(0);
    expect(result.guardrails.databaseConnections).toBe(0);
    expect(result.guardrails.whatsappMessages).toBe(0);
  });
});
