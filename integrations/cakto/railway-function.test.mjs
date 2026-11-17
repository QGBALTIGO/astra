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
  const state = {
    objects: new Map(),
    queries: [],
    dbDown: false,
    storageDown: false,
    heldStorageDown: false,
    s3Options: null,
  };
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
      query.json = (value) => value;
      query.close = async () => {};
      return query;
    }
  }
  class S3Client {
    constructor(options) {
      state.s3Options = options;
    }
    file(key) {
      return {
        write: async (bytes) => {
          if (state.storageDown || (state.heldStorageDown && key.startsWith('held/')))
            throw new Error('storage unavailable');
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
  async function boot(mode, storageEnv = {}, sqlOverride) {
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
        S3_ENDPOINT: 'https://t3.storageapi.dev',
        S3_BUCKET: 'synthetic-bucket',
        S3_ACCESS_KEY_ID: 'synthetic',
        S3_SECRET_ACCESS_KEY: 'synthetic',
        S3_REGION: 'auto',
        S3_VIRTUAL_HOSTED_STYLE: 'true',
        ...storageEnv,
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
      sqlOverride ?? SQL,
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
for (const mutation of [
  'tampered body',
  'expired timestamp',
  'future timestamp',
  'wrong signature',
  'wrong body secret',
]) {
  test(`rejects ${mutation} without accessing storage or the database`, async () => {
    const { state, boot } = fixture();
    const original = request('purchase_approved', {
      status: 'paid',
      paidAt: new Date().toISOString(),
    });
    let raw = await original.text();
    const headers = new Headers(original.headers);
    if (mutation === 'tampered body') raw = raw.replace('5511999991234', '5511999999876');
    else {
      if (mutation === 'expired timestamp' || mutation === 'future timestamp') {
        headers.set(
          'x-cakto-timestamp',
          String(Math.floor(Date.now() / 1000) + (mutation === 'expired timestamp' ? -600 : 600))
        );
      }
      if (mutation === 'wrong body secret')
        raw = JSON.stringify({ ...JSON.parse(raw), secret: 'wrong' });
      const signingSecret = mutation === 'wrong signature' ? 'another-synthetic-secret' : secret;
      headers.set(
        'x-cakto-signature',
        'v1=' +
          crypto
            .createHmac('sha256', signingSecret)
            .update(headers.get('x-cakto-timestamp') + '.' + raw)
            .digest('hex')
      );
    }
    const response = await (
      await boot()
    )(new Request(original.url, { method: 'POST', headers, body: raw }));
    assert.equal(response.status, 401);
    assert.equal(state.objects.size, 0);
    assert.equal(state.queries.length, 0);
  });
}
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

test('retains an authenticated paid event that cannot be associated with a customer', async () => {
  const { state, boot } = fixture();
  const response = await (
    await boot()
  )(
    request('purchase_approved', {
      status: 'paid',
      paidAt: new Date().toISOString(),
      customer: { name: 'Synthetic unassociated buyer', phone: '', email: 'review@example.com' },
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).outcomes, ['held_invalid_identity']);
  assert.equal(state.objects.size, 1);
  assert.match([...state.objects.keys()][0], /^held\/v1\//);
  const retained = [...state.objects.values()][0].toString('utf8');
  for (const privateValue of ['review@example.com', 'Synthetic unassociated buyer', secret])
    assert.ok(!retained.includes(privateValue));
  const queryCount = state.queries.length;
  await boot('worker');
  assert.equal(state.objects.size, 1, 'a worker restart must preserve manual-review evidence');
  assert.equal(state.queries.length, queryCount, 'held entries must not be automatically granted');
  assert.ok(
    !state.queries.some((q) => /INSERT INTO channel_users|UPDATE channel_users/.test(q.text))
  );
});

test('a failed move to manual review retains the original durable event for recovery', async () => {
  const { state, boot } = fixture();
  state.heldStorageDown = true;
  const response = await (
    await boot()
  )(request('purchase_approved', { status: 'paid', paidAt: null }));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);
  assert.equal(state.objects.size, 1);
  assert.match([...state.objects.keys()][0], /^pending\/v1\//);
  state.heldStorageDown = false;
  await boot('worker');
  assert.equal(state.objects.size, 1);
  assert.match([...state.objects.keys()][0], /^held\/v1\//);
});

test('constructs the bucket hostname for Bun virtual-host addressing', async () => {
  const { state, boot } = fixture();
  await boot();
  assert.equal(new URL(state.s3Options.endpoint).hostname, 'synthetic-bucket.t3.storageapi.dev');
  await boot(undefined, { S3_ENDPOINT: 'https://synthetic-bucket.t3.storageapi.dev' });
  assert.equal(new URL(state.s3Options.endpoint).hostname, 'synthetic-bucket.t3.storageapi.dev');
});
test(
  'the real Bun S3 client addresses the intended bucket',
  { skip: !globalThis.Bun },
  async () => {
    const { state, boot } = fixture();
    await boot();
    const client = new globalThis.Bun.S3Client(state.s3Options);
    const signed = new URL(client.presign('probe/address'));
    assert.equal(signed.hostname, 'synthetic-bucket.t3.storageapi.dev');
    assert.equal(signed.pathname, '/probe/address');
  }
);

test(
  'replays an encrypted paid event once through real PostgreSQL and preserves unpaid and revoked states',
  { skip: !globalThis.Bun || !process.env.ASTRA_REVIEW_PG_PORT },
  async () => {
    const { SQL: NativeSQL } = await import('bun');
    const connection = {
      hostname: '127.0.0.1',
      port: Number(process.env.ASTRA_REVIEW_PG_PORT),
      username: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
      password: process.env.ASTRA_REVIEW_PG_PASSWORD,
      database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
    };
    const schema = 'review_cakto_' + crypto.randomUUID().replaceAll('-', '');
    const admin = new NativeSQL(connection);
    const clients = [];
    const options = { ...connection, connection: { search_path: schema } };
    const db = new NativeSQL(options);
    class ReviewSQL {
      constructor() {
        const client = new NativeSQL(options);
        clients.push(client);
        return client;
      }
    }
    try {
      await admin.unsafe('CREATE SCHEMA ' + schema);
      // Use the real contracts for every queried gateway table. Conversations
      // are only a foreign-key target in this isolated payment fixture.
      await db`CREATE TABLE conversations(id text PRIMARY KEY)`;
      for (const [file, tables] of [
        ['channels', ['channel_users', 'channel_sessions', 'channel_access_notifications']],
        ['customer-accounts', ['customer_accounts', 'customer_phone_aliases']],
        ['core', ['system_settings']],
      ]) {
        const contents = await readFile(
          new URL('../../packages/gateway/src/db/schema/' + file + '.ts', import.meta.url),
          'utf8'
        );
        for (const table of tables) {
          const ddl = contents.match(
            new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);')
          )?.[0];
          assert.ok(ddl, 'Missing real table schema: ' + table);
          await db.unsafe(ddl);
        }
      }
      const { state, boot } = fixture();
      const paid = { status: 'paid', paidAt: new Date().toISOString() };
      // A paid checkout must upgrade the same trial identity, never preserve
      // only its three-day deadline or create a second customer.
      const trialUntil = new Date(Date.now() + 3 * 86_400_000);
      await db`INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,
        is_verified,status,access_source,access_granted_at,access_expires_at,metadata)
        VALUES('trial-customer','whatsapp:5511999991234','whatsapp','5511999991234',
          true,'active','trial',now(),${trialUntil.toISOString()},
          '{"hasInteracted":true,"trialSyntheticPreference":"preserved"}'::jsonb)`;
      state.dbDown = true;
      assert.equal((await (await boot())(request('purchase_approved', paid))).status, 202);
      assert.equal(state.objects.size, 1);
      assert.ok(![...state.objects.values()][0].toString().includes('5511999991234'));

      await boot('worker', {}, ReviewSQL);
      assert.equal(state.objects.size, 0);
      const [user] =
        await db`SELECT id,is_verified,access_source,access_expires_at,metadata FROM channel_users`;
      assert.equal(user.id, 'trial-customer');
      assert.equal(user.access_source, 'cakto');
      assert.equal(user.metadata.trialSyntheticPreference, 'preserved');
      assert.ok(new Date(user.access_expires_at).getTime() > trialUntil.getTime());
      assert.equal(user.is_verified, true);
      assert.ok(new Date(user.access_expires_at).getTime() > Date.now());
      const fetch = await boot(undefined, {}, ReviewSQL);
      assert.equal((await fetch(request('purchase_approved', paid))).status, 200);
      assert.equal(Number((await db`SELECT count(*) AS n FROM channel_users`)[0].n), 1);
      assert.equal(
        Number((await db`SELECT count(*) AS n FROM channel_access_notifications`)[0].n),
        1
      );

      // Reproduce the legacy JSON-string binding and repair it on renewal.
      const legacy = { hasInteracted: true, manualPreauthorized: false, caktoManaged: true };
      await db`UPDATE channel_users SET metadata=${db.json(JSON.stringify(legacy))}::jsonb`;
      assert.equal(
        (await fetch(request('subscription_renewed', { ...paid, id: 'renewal-order' }))).status,
        200
      );
      assert.deepEqual((await db`SELECT metadata FROM channel_users`)[0].metadata, legacy);
      assert.equal(
        Number((await db`SELECT count(*) AS n FROM channel_access_notifications`)[0].n),
        2
      );

      assert.equal((await fetch(request('pix_gerado', { id: 'unpaid-order' }))).status, 200);
      assert.equal(
        (await db`SELECT buyer_email FROM astra_cakto_pending_pix WHERE order_id='unpaid-order'`)[0]
          .buyer_email,
        'fulano.123@example.com'
      );
      assert.equal(Number((await db`SELECT count(*) AS n FROM astra_cakto_orders`)[0].n), 2);
      assert.equal(
        new Date(
          (await db`SELECT access_expires_at FROM channel_users`)[0].access_expires_at
        ).getTime(),
        new Date(user.access_expires_at).getTime()
      );

      await db`INSERT INTO channel_sessions(id,channel_user_id,channel_plugin_id,platform_chat_id)
        VALUES('session',${user.id},'channel.whatsapp','5511999991234')`;
      assert.equal(
        (await fetch(request('refund', { refundedAt: new Date().toISOString() }))).status,
        200
      );
      assert.equal((await db`SELECT is_verified FROM channel_users`)[0].is_verified, true);
      assert.equal(
        (
          await fetch(
            request('refund', { id: 'renewal-order', refundedAt: new Date().toISOString() })
          )
        ).status,
        200
      );
      assert.equal((await db`SELECT is_verified FROM channel_users`)[0].is_verified, false);
      assert.equal((await db`SELECT is_active FROM channel_sessions`)[0].is_active, false);
      assert.equal(state.objects.size, 0);

      // A delayed approval cannot revive a refunded payment. Providers may
      // emit sub-millisecond timestamps which JavaScript reduces to one ms.
      const reversedAt = new Date(Date.now() - 500).toISOString();
      for (const [event, status, reversedPhone] of [
        ['refund', 'refunded', '5511999982234'],
        ['chargeback', 'chargedback', '5511999983234'],
      ]) {
        const reversed = {
          id: event + '-before-approval',
          customer: { phone: reversedPhone, name: 'Synthetic reversed buyer' },
          paidAt: reversedAt,
          refundedAt: reversedAt,
          chargedbackAt: reversedAt,
        };
        assert.equal((await fetch(request('pix_gerado', reversed))).status, 200);
        assert.equal((await fetch(request(event, { ...reversed, status }))).status, 200);
        for (const [grantEvent, paidAt] of [
          ['purchase_approved', reversedAt],
          ['subscription_renewed', new Date().toISOString()],
          ['subscription_late_recovered', new Date().toISOString()],
        ]) {
          const response = await fetch(
            request(grantEvent, { ...reversed, status: 'paid', paidAt })
          );
          assert.equal(response.status, 200);
          assert.deepEqual((await response.json()).outcomes, ['ignored_reversed_order']);
        }
        assert.equal(
          (await db`SELECT status FROM astra_cakto_orders WHERE order_id=${reversed.id}`)[0].status,
          status
        );
        assert.equal(
          (await db`SELECT status FROM astra_cakto_pending_pix WHERE order_id=${reversed.id}`)[0]
            .status,
          status
        );
        assert.equal(
          Number(
            (
              await db`SELECT count(*) AS n FROM channel_users
            WHERE platform_user_id=${reversedPhone} AND is_verified`
            )[0].n
          ),
          0
        );
        assert.equal(
          Number(
            (
              await db`SELECT count(*) AS n FROM channel_access_notifications
            WHERE platform_user_id=${reversedPhone}`
            )[0].n
          ),
          0
        );
        // A legitimate new order still grants access to the same customer.
        const replacement = await fetch(
          request('purchase_approved', {
            ...reversed,
            ...paid,
            id: event + '-new-order',
          })
        );
        assert.equal(replacement.status, 200);
        assert.deepEqual((await replacement.json()).outcomes, ['granted']);
      }

      // Distinct authenticated event types may arrive concurrently with
      // conflicting buyer details. Neither may overwrite the other's order.
      await db.unsafe(`CREATE FUNCTION delay_conflicting_order() RETURNS trigger AS $$
        BEGIN
          IF NEW.order_id='conflicting-concurrent-order' THEN PERFORM pg_sleep(0.15); END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER delay_conflicting_order BEFORE INSERT ON astra_cakto_orders
          FOR EACH ROW EXECUTE FUNCTION delay_conflicting_order();`);
      const concurrent = await Promise.all([
        fetch(
          request('purchase_approved', {
            ...paid,
            id: 'conflicting-concurrent-order',
            customer: { phone: '5511999984234' },
          })
        ),
        fetch(
          request('subscription_renewed', {
            ...paid,
            id: 'conflicting-concurrent-order',
            customer: { phone: '5511999985234' },
          })
        ),
      ]);
      const concurrentOutcomes = (await Promise.all(concurrent.map((response) => response.json())))
        .flatMap((body) => body.outcomes)
        .sort();
      assert.deepEqual(concurrentOutcomes, ['granted', 'held_order_conflict']);
      assert.equal(
        Number(
          (
            await db`SELECT count(*) AS n FROM channel_users
        WHERE platform_user_id IN ('5511999984234','5511999985234') AND is_verified`
          )[0].n
        ),
        1
      );

      // A conflict is committed before its encrypted reconciliation object.
      // Losing only that storage write must survive event-key dedup on restart.
      const heldBefore = [...state.objects.keys()].filter((key) => key.startsWith('held/')).length;
      state.heldStorageDown = true;
      const interruptedHold = await fetch(
        request('subscription_late_recovered', {
          ...paid,
          customer: { phone: '5511999986234' },
        })
      );
      assert.equal(interruptedHold.status, 202);
      assert.equal(
        (
          await db`SELECT outcome FROM astra_cakto_events
        WHERE event_key='subscription_late_recovered:test-order'`
        )[0].outcome,
        'held_order_conflict'
      );
      assert.equal([...state.objects.keys()].filter((key) => key.startsWith('pending/')).length, 1);
      state.heldStorageDown = false;
      await boot('worker', {}, ReviewSQL);
      assert.equal([...state.objects.keys()].filter((key) => key.startsWith('pending/')).length, 0);
      assert.equal(
        [...state.objects.keys()].filter((key) => key.startsWith('held/')).length,
        heldBefore + 1
      );
      assert.equal(
        Number(
          (
            await db`SELECT count(*) AS n FROM channel_users
        WHERE platform_user_id='5511999986234'`
          )[0].n
        ),
        0
      );
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await db.close();
      await admin.unsafe('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await admin.close();
    }
  }
);
