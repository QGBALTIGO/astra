import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVirtualWeekdayAt, virtualLocalDayAt } from './virtual-clock.mjs';
function local(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
test('tomorrow at 18h uses account local date in different Brazil timezones', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  for (const zone of [
    'America/Campo_Grande',
    'America/Sao_Paulo',
    'America/Manaus',
    'America/Belem',
  ]) {
    const due = virtualLocalDayAt(now, zone, 1, 18, 0);
    const actual = local(due, zone);
    assert.match(actual, /02\/01\/2026/);
    assert.match(actual, /18:00/);
    assert.ok(due > now);
  }
});
test('next Friday at 6h is a weekly event, not daily', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const zone = 'America/Campo_Grande';
  const due = nextVirtualWeekdayAt(now, zone, 5, 6);
  assert.match(local(due, zone), /Fri/);
  assert.match(local(due, zone), /06:00/);
  const repeat = nextVirtualWeekdayAt(new Date(due.getTime() + 1000), zone, 5, 6);
  assert.equal(repeat.getTime() - due.getTime(), 7 * 86_400_000);
});
test('same-day early or late Friday chooses correct occurrence', () => {
  const zone = 'America/Sao_Paulo';
  const before = new Date('2026-01-02T08:00:00.000Z'); // 05:00 local
  const after = new Date('2026-01-02T12:00:00.000Z'); // 09:00 local
  assert.match(local(nextVirtualWeekdayAt(before, zone, 5, 6), zone), /02\/01\/2026/);
  assert.match(local(nextVirtualWeekdayAt(after, zone, 5, 6), zone), /09\/01\/2026/);
});
test('rejects invalid hours and weekday before changing state', () => {
  assert.throws(() => virtualLocalDayAt(new Date(), 'America/Sao_Paulo', 1, 24), /Invalid/);
  assert.throws(() => nextVirtualWeekdayAt(new Date(), 'America/Sao_Paulo', 7, 6), /Invalid/);
});
