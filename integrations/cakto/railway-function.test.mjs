import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as crypto from 'node:crypto';

const source = (await readFile(new URL('./railway-function.ts', import.meta.url), 'utf8')).replace(
  /^import[\s\S]*?from ['"][^'"]+['"];\n/gm,
  ''
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const secret = 'synthetic-test-webhook-secret-not-production';
function fixture() {
  const state = { objects: new Map(), queries: [], dbDown: false, storageDown: false };
  class SQL {
    constructor() {
      const query = async (strings, ...values) => {
        if (state.dbDown) throw new Error('synthetic database outage');
        const text = strings.join('?');
        state.queries.push({ text, values });
        if (text.includes('INSERT INTO astra_cakto_events')) return [{ event_key: 'synthetic' }];
        return [];
      };
      query.begin = (callback) => callback(query);
      query.close = async () => {};
      return query;
    }
  }
  class S3Client {
    file(key) {
      return {
        write: async (bytes) => {
          if (state.storageDown) throw new Error('storage unavailable');
          state.objects.set(key, Buffer.from(bytes));
        },
        arrayBuffer: async () => Uint8Array.from(state.objects.get(key)).buffer,
        delete: async () => {
          state.objects.delete(key);
        },
      };
    }
    async list({ prefix, startAfter, maxKeys }) {
      const keys = [...state.objects.keys()]
        .filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter))
        .sort();
      return {
        contents: keys.slice(0, maxKeys).map((key) => ({ key })),
        isTruncated: keys.length > maxKeys,
      };
    }
  }
  async function boot(mode) {
    let fetch;
    const Bun = {
      env: {
        CAKTO_WEBHOOK_SECRET: secret,
        CAKTO_PRODUCT_ID: 'test-product',
        CAKTO_INBOX_KEY: 'ab'.repeat(32),
        POSTGRES_HOST: 'test',
        POSTGRES_USER: 'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB: 'test',
        CAKTO_INBOX_MODE: mode,
      },
      serve: (options) => {
        fetch = options.fetch;
      },
    };
    const names = [
      'SQL',
      'S3Client',
      'Bun',
      ...Object.keys(crypto).filter((key) => key !== 'default'),
    ];
    await new AsyncFunction(...names, source)(
      SQL,
      S3Client,
      Bun,
      ...Object.entries(crypto)
        .filter(([key]) => key !== 'default')
        .map(([, value]) => value)
    );
    return fetch;
  }
  return { state, boot };
}
function request(event = 'pix_gerado', overrides = {}) {
  const raw = JSON.stringify({
    secret,
    event,
    data: {
      id: 'test-order',
      offer_type: 'main',
      status: 'waiting_payment',
      customer: {
        phone: '5511999991234',
        name: 'Test',
        email: 'fulano.123@example.com',
        docNumber: 'CPF_MUST_NOT_BE_SAVED',
      },
      product: { id: 'test-product', name: 'Test' },
      createdAt: new Date().toISOString(),
      ...overrides,
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(timestamp + '.' + raw)
    .digest('hex');
  return new Request('https://example.test/webhooks/cakto', {
    method: 'POST',
    body: raw,
    headers: {
      'content-type': 'application/json',
      'x-cakto-timestamp': timestamp,
      'x-cakto-signature': 'v1=' + signature,
    },
  });
}
test('accepts durably during database outage and recovers after a new worker starts', async () => {
  const { state, boot } = fixture();
  state.dbDown = true;
  const fetch = await boot();
  const response = await fetch(request());
  assert.equal(response.status, 202);
  assert.equal(state.objects.size, 1);
  const stored = [...state.objects.values()][0].toString('utf8');
  for (const text of ['fulano', '5511999991234', secret, 'CPF_MUST_NOT_BE_SAVED'])
    assert.ok(!stored.includes(text));
  state.dbDown = false;
  await boot('worker');
  assert.equal(state.objects.size, 0);
  const insert = state.queries.find((q) => q.text.includes('INSERT INTO astra_cakto_pending_pix'));
  assert.ok(insert.values.includes('fulano.123@example.com'));
  assert.ok(
    !state.queries.some((q) => /INSERT INTO channel_users|UPDATE channel_users/.test(q.text))
  );
});
test('never acknowledges a failed durable write', async () => {
  const { state, boot } = fixture();
  state.storageDown = true;
  const response = await (await boot())(request());
  assert.equal(response.status, 503);
  assert.equal(state.objects.size, 0);
  assert.equal(state.queries.length, 0);
});
test('rejects unsigned delivery before storage or database access', async () => {
  const { state, boot } = fixture();
  const req = request();
  req.headers.delete('x-cakto-signature');
  assert.equal((await (await boot())(req)).status, 401);
  assert.equal(state.objects.size, 0);
  assert.equal(state.queries.length, 0);
});
test('keeps a failed worker item for the next run', async () => {
  const { state, boot } = fixture();
  state.dbDown = true;
  await (
    await boot()
  )(request());
  await assert.rejects(boot('worker'));
  assert.equal(state.objects.size, 1);
});
test('tampered ciphertext cannot be processed or deleted', async () => {
  const { state, boot } = fixture();
  state.dbDown = true;
  await (
    await boot()
  )(request());
  state.dbDown = false;
  [...state.objects.values()][0][30] ^= 1;
  await assert.rejects(boot('worker'));
  assert.equal(state.objects.size, 1);
  assert.equal(state.queries.length, 0);
});
test('ignores other products without queueing or granting access', async () => {
  const { state, boot } = fixture();
  assert.equal(
    (await (await boot())(request('purchase_approved', { product: { id: 'other' } }))).status,
    200
  );
  assert.equal(state.objects.size, 0);
  assert.equal(state.queries.length, 0);
});
