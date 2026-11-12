import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONA_COUNT, personaAt, scenarioAt } from './core.mjs';
import { SyntheticWorldOracle } from './world-oracle.mjs';
test('follows a synthetic life without sharing state across identities', () => {
  const a = personaAt(0),
    b = personaAt(1);
  const world = new SyntheticWorldOracle(a);
  for (let s = 0; s < 10; s++) {
    const result = world.apply(scenarioAt(s));
    assert.equal(result.synthetic, true);
    assert.equal(result.contractualDebtVerified, false);
  }
  assert.equal(world.snapshot().accountId, a.id);
  assert.equal(world.nextStep, 10);
  assert.equal(world.readExternalUser(b.id), null);
  assert.ok(world.stats.deniedCrossUserReads >= 1);
});
test('rejects foreign users, skipped turns and non-synthetic tool actors', () => {
  const world = new SyntheticWorldOracle(personaAt(0));
  assert.throws(() => world.apply(scenarioAt(10)), /cross-user/);
  assert.throws(() => world.apply(scenarioAt(1)), /Out-of-order/);
  assert.throws(() => world.readExternalUser('whatsapp:real'), /Foreign/);
});
test('deduplicates after-commit retries without a second ledger entry', () => {
  const w = new SyntheticWorldOracle(personaAt(100));
  const before = w.transactions.size;
  assert.equal(w.write('SIM-E1', 'expense', 100), true);
  assert.equal(w.write('SIM-E1', 'expense', 100), false);
  assert.equal(w.transactions.size, before + 1);
  assert.equal(w.stats.duplicateWritesPrevented, 1);
});
test('virtual scheduler never creates an actual WhatsApp send', () => {
  const w = new SyntheticWorldOracle(personaAt(0));
  w.reminders.set('SIM-R1', { nextAt: Date.UTC(2026, 0, 2), recurringMs: 0, cancelled: false });
  w.dispatch(Date.UTC(2026, 0, 3));
  w.dispatch(Date.UTC(2026, 0, 3));
  assert.equal(w.stats.virtualReminderDeliveries, 1);
  assert.equal(w.reminders.get('SIM-R1').cancelled, true);
});
test('financial arithmetic explicitly excludes unknown contractual interest', () => {
  const w = new SyntheticWorldOracle(personaAt(0));
  assert.equal(w.snapshot().loan.arithmeticDifferenceCents, 7_107_000);
  assert.equal(w.snapshot().loan.contractualInterestKnown, false);
  w.loan.alreadyPaidCents += 47_000;
  assert.equal(w.snapshot().loan.arithmeticDifferenceCents, 7_060_000);
});

test('synthetic financial ledger uses the actual labeled source amount, not a random value', () => {
  let index = 0;
  while (index < PERSONA_COUNT && categoryOf(index) !== 'finance') index++;
  assert.ok(index < PERSONA_COUNT);
  const w = new SyntheticWorldOracle(personaAt(index));
  const first = scenarioAt(index * 10);
  const outcome = w.apply(first);
  assert.equal(outcome.decision, 'write_expense');
  assert.equal(w.expenseCents(), first.context.expectedActionAmountCents);
  assert.ok(first.message.includes('farmácia'));
});
function categoryOf(personaIndex) {
  return scenarioAt(personaIndex * 10).category;
}

test('simulated recurring Friday reminders fire weekly at 06:00 local, not daily', () => {
  const find = Array.from({length:10000},(_,i)=>i).find(i=>scenarioAt(i*10).category==='schedule');
  assert.ok(find!==undefined);
  const w=new SyntheticWorldOracle(personaAt(find));
  for(let step=0;step<=5;step++)w.apply(scenarioAt(find*10+step));
  const friday=[...w.reminders.values()].find(r=>r.weeklyLocal);
  assert.ok(friday);
  assert.equal(friday.recurringMs,7*86_400_000);
  const noticesBefore=w.reminders.size;
  assert.ok(w.stats.clarificationTurns>=2, 'Every-15-days request without a time must ask for a time');
  assert.equal(w.reminders.size,noticesBefore);
  const initial=friday.nextAt;
  w.dispatch(initial);
  assert.ok(friday.nextAt>initial);
  assert.equal(friday.nextAt-initial,7*86_400_000);
});
