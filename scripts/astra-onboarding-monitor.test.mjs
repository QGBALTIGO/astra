import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeOnce, reconcileIncident, PROBE_URL } from './astra-onboarding-monitor.mjs';

const good = { success: true, data: { probe: 'astra-whatsapp-onboarding-v1', status: 'ready' } };
const response = (data, status = 200) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status });
test('accepts only the exact readiness protocol, never a generic HTTP 200', async () => {
  assert.equal(
    await probeOnce(async (url, options) => {
      assert.equal(url, PROBE_URL);
      assert.equal(options.redirect, 'error');
      return response(good);
    }),
    true
  );
  for (const data of [
    { success: true, data: { status: 'ok' } },
    { ...good, data: { ...good.data, status: 'not_ready' } },
    {},
    '<html>Astra</html>',
    'x'.repeat(5000),
  ]) {
    assert.equal(await probeOnce(async () => response(data)), false);
  }
});
test('detects HTTP, network and malformed responses without leaking error text', async () => {
  for (const status of [401, 404, 429, 500, 502, 503])
    assert.equal(await probeOnce(async () => response(good, status)), false);
  assert.equal(
    await probeOnce(async () => {
      throw new Error('sensitive failure');
    }),
    false
  );
});
const incident = {
  number: 25,
  state: 'open',
  title: '[Astra onboarding] Atendimento inicial precisa de verificacao',
  body: '<!-- astra-onboarding-monitor-v1 -->',
  user: { login: 'github-actions[bot]' },
};
function apiMock(issues) {
  const calls = [];
  const api = async (method, path, payload) => {
    calls.push({ method, path, payload });
    return method === 'GET' ? issues : {};
  };
  return { calls, api };
}
test('opens one incident and does not spam comments while it remains open', async () => {
  const empty = apiMock([]);
  await reconcileIncident(false, empty.api);
  assert.equal(empty.calls.filter((c) => c.method === 'POST').length, 1);
  const open = apiMock([incident]);
  await reconcileIncident(false, open.api);
  assert.equal(open.calls.length, 1);
});
test('reopens the same incident after recurrence and closes only on readiness', async () => {
  const closed = apiMock([{ ...incident, state: 'closed' }]);
  await reconcileIncident(false, closed.api);
  assert.deepEqual(closed.calls.at(-1).payload.state, 'open');
  const open = apiMock([incident]);
  await reconcileIncident(true, open.api);
  assert.equal(open.calls.at(-1).payload.state, 'closed');
  const empty = apiMock([]);
  await reconcileIncident(true, empty.api);
  assert.equal(empty.calls.length, 1);
});
test('does not modify a similarly named issue created by a user', async () => {
  const fake = apiMock([{ ...incident, user: { login: 'some-user' } }]);
  await reconcileIncident(true, fake.api);
  assert.equal(fake.calls.length, 1);
});
test('fails closed when incident pagination is incomplete', async () => {
  const crowded = apiMock(Array.from({ length: 100 }, (_, number) => ({ number, title: 'other' })));
  await assert.rejects(() => reconcileIncident(false, crowded.api), /incomplete/);
  assert.equal(
    crowded.calls.every((c) => c.method === 'GET'),
    true
  );
});
test('publishing an image requires the onboarding gate on the same checkout', () => {
  const publisher = readFileSync(
    new URL('../.github/workflows/publish-astra-image.yml', import.meta.url),
    'utf8'
  );
  const gate = readFileSync(
    new URL('../.github/workflows/astra-onboarding-release.yml', import.meta.url),
    'utf8'
  );
  assert.match(publisher, /needs: \[qualification, customer-verification, onboarding\]/);
  assert.match(publisher, /uses: \.\/\.github\/workflows\/astra-onboarding-release\.yml/);
  assert.match(gate, /workflow_call:/);
  assert.match(gate, /src\/channels\/service-impl\.test\.ts/);
  assert.match(gate, /src\/db\/repositories\/whatsapp-trials\.pg\.test\.ts/);
  assert.match(gate, /ASTRA_REVIEW_PG_PORT: '5432'/);
  assert.doesNotMatch(gate, /continue-on-error|ref:\s*(?:main|master)/);
});
test('production check runs independently without production secrets or writes', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/astra-onboarding-monitor.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /secrets\.|RAILWAY_TOKEN|ADMIN_API_KEY/);
});
