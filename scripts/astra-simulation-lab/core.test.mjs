import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SEED,
  PERSONA_COUNT,
  SCENARIO_COUNT,
  CATEGORIES,
  personaAt,
  scenarioAt,
  categoryFor,
  scriptAt,
  toBrl,
  parseBrlExact,
  effectiveNoDuplicateState,
  inspectScenario,
} from './core.mjs';

test('generates 10,000 distinct fictional identities with stable histories', () => {
  const ids = new Set();
  const fingerprints = new Set();
  for (let i = 0; i < PERSONA_COUNT; i++) {
    const p = personaAt(i, DEFAULT_SEED);
    assert.equal(p.synthetic, true);
    assert.ok(!ids.has(p.id));
    ids.add(p.id);
    fingerprints.add(p.profileFingerprint);
    assert.ok(p.carCostCents > p.carPaidCents);
    assert.equal(p.carDebtDifferenceCents, p.carCostCents - p.carPaidCents);
    assert.equal(p.carContractInterestKnown, false);
  }
  assert.equal(ids.size, PERSONA_COUNT);
  assert.equal(fingerprints.size, PERSONA_COUNT);
  assert.equal(personaAt(0).carCostCents, 7_200_000);
  assert.equal(personaAt(0).carPaidCents, 93_000);
  assert.equal(personaAt(0).carDebtDifferenceCents, 7_107_000);
});
test('permutation exactly preserves all category quotas for 100,000 scenarios', () => {
  const count = Object.fromEntries(CATEGORIES.map((x) => [x.key, 0]));
  let goals = 0;
  for (let i = 0; i < SCENARIO_COUNT; i++) {
    const category = categoryFor(i);
    count[category]++;
    if (category === 'goals') goals++;
  }
  for (const item of CATEGORIES) assert.equal(count[item.key], item.count, item.key);
  assert.equal(goals, 15_000);
});
test('10,000 multistep scripts have linked context and advancing virtual dates', () => {
  for (let i = 0; i < PERSONA_COUNT; i++) {
    const story = scriptAt(i);
    assert.equal(story.turns.length, 10);
    assert.equal(story.turns[0].personaId, story.turns[9].personaId);
    const domain = story.turns[0].category;
    assert.ok(story.turns.every((turn) => turn.category === domain),
      'Each ten-turn script must stay in the same causal domain');
    const dates = story.turns.map((x) => Date.parse(x.virtualAt));
    for (let j = 1; j < dates.length; j++) assert.ok(dates[j] > dates[j - 1]);
    for (let j = 0; j < 10; j++) {
      const turn = story.turns[j];
      assert.equal(turn.step, j);
      assert.equal(turn.semanticFamily, domain + ':' + j);
      assert.equal(turn.context.priorTurnIds.length, j);
      assert.equal(turn.context.stableCarPriceCents, story.persona.carCostCents);
      assert.equal(turn.expected.prohibitFalseSuccess, true);
      assert.equal(turn.expected.validatedAgainstAstra, false);
      assert.equal(inspectScenario(turn).pass, true);
    }
  }
});
test('generation is reproducible and exposes seed changes', () => {
  const scenario = scenarioAt(12_345);
  assert.deepEqual(scenario, scenarioAt(12_345));
  assert.notDeepEqual(scenarioAt(12_345, 100), scenarioAt(12_345, 101));
  assert.throws(() => scenarioAt(-1), RangeError);
  assert.throws(() => scenarioAt(SCENARIO_COUNT), RangeError);
});
test('money roundtrips exactly in cents and avoids accidental coercion', () => {
  for (const cents of [0, 1, 20, 100, 101, 47000, 93000, 7200000, 999999999]) {
    assert.equal(parseBrlExact(toBrl(cents)), cents);
  }
  for (const value of ['R$ 1,00,00', 'R$ -1,00', 'R$ 10.3', 'R$ 3.', 'R$ 1e4']) {
    assert.equal(parseBrlExact(value), null, value);
  }
  assert.equal(parseBrlExact('R$ 1.234,56'), 123456);
});
test('synthetic ledger is idempotent under retry and segregates accounts', () => {
  const a = { userId: 'SIM-P00001', eventId: 'SIM-E1', type: 'expense', amountCents: 100 };
  const b = { ...a, userId: 'SIM-P00002' };
  const c = { ...a, eventId: 'SIM-E2', amountCents: 200 };
  const ledger = effectiveNoDuplicateState([a, a, b, c, c]);
  assert.equal(ledger.get(a.userId).expenseCents, 300);
  assert.equal(ledger.get(b.userId).expenseCents, 100);
  assert.equal(ledger.get(a.userId).appliedIds.length, 2);
  assert.equal(ledger.get(b.userId).appliedIds.length, 1);
  assert.throws(() => effectiveNoDuplicateState([{ ...a, userId: 'whatsapp:real-phone' }]));
  assert.throws(() => effectiveNoDuplicateState([{ ...a, amountCents: -100 }]));
});

test('financial amounts in scenarios are the oracle values, never random ledger placeholders', () => {
  let finance = 0, goals = 0;
  for (let story = 0; story < PERSONA_COUNT; story++) {
    const turns = scriptAt(story).turns;
    if (turns[0].category === 'finance') {
      finance++;
      const t = turns[0];
      const cents = t.context.expectedActionAmountCents;
      assert.ok(Number.isSafeInteger(cents));
      assert.ok(t.message.includes(toBrl(cents).replace(/\u00a0/gu, ' ')) ||
        t.message.includes(toBrl(cents)), 'The expense amount must occur in its visible prompt');
      const installment = turns[2];
      assert.equal(installment.context.expectedActionAmountCents, 47000);
    }
    if (turns[0].category === 'goals') {
      goals++;
      const contribution = turns[3];
      assert.ok(contribution.message.includes(toBrl(contribution.context.expectedActionAmountCents)) ||
        contribution.message.includes(toBrl(contribution.context.expectedActionAmountCents).replace(/\u00a0/gu, ' ')));
    }
  }
  assert.equal(finance, 2000);
  assert.equal(goals, 1500);
});

test('style without punctuation never mutates BRL cent separators', () => {
  let checked = 0;
  for (let scriptIndex = 0; scriptIndex < PERSONA_COUNT; scriptIndex++) {
    const persona = personaAt(scriptIndex);
    if (persona.style !== 'sem_pontuacao') continue;
    const story = scriptAt(scriptIndex);
    for (const step of [0, 1, 2, 3, 5]) {
      const scenario = story.turns[step];
      const cents = scenario.context.expectedActionAmountCents;
      if (cents == null) continue;
      const expected = toBrl(cents);
      assert.ok(scenario.message.includes(expected),
        'Raw monetary value was corrupted by punctuation removal: ' + scenario.id);
      checked++;
    }
  }
  assert.ok(checked > 100);
});
