import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Opt-in real-provider check, restricted to the disposable local QA database.
assert.equal(process.env.POSTGRES_HOST, '127.0.0.1');
assert.match(process.env.POSTGRES_DB ?? '', /^astratest_integrations_/);
const mod = (path) => import(new URL('../packages/gateway/src/' + path, import.meta.url).href);
const { initializeAdapter, getAdapter, closeAdapter } = await mod('db/adapters/index.ts');
await initializeAdapter();
const db = await getAdapter();
const { customerWeather } = await mod('services/customer-weather.ts');
const user = 'lab:weather:' + randomUUID();
try {
  assert.equal((await customerWeather(user)).needsCity, true);
  assert.equal((await customerWeather(user, 'Cuiabá, Mato Grosso, Brasil', true)).saved, true);
  const start = performance.now();
  const result = await customerWeather(user);
  assert.equal(result.city, 'Cuiabá');
  assert.equal(result.kind, 'model_estimate');
  assert.equal(typeof result.temperatureC, 'number');
  assert.equal((await customerWeather(user + ':unrelated')).needsCity, true);
  const cachedStart = performance.now();
  const cached = await customerWeather(user);
  assert.equal(cached.temperatureC, result.temperatureC);
  console.log(
    JSON.stringify({
      passed: true,
      city: result.city,
      temperatureC: result.temperatureC,
      updatedAt: result.updatedAt,
      source: result.source.weather,
      firstReadMs: Math.round(cachedStart - start),
      cachedReadMs: Math.round(performance.now() - cachedStart),
    })
  );
} finally {
  await db.execute('DELETE FROM memories WHERE user_id=$1', [user]);
  await closeAdapter();
}
