/**
 * Astra x Cakto — standalone Railway Function (Bun)
 * Scope: one Cakto product, one paid entitlement per WhatsApp phone.
 * No customer data is sent to AI providers. No payments are initiated.
 * Deploy with server-only environment variables; never commit the webhook secret.
 */
import { SQL } from 'bun';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const RELEASE = 'astra-cakto-20261112-v1';
const SECRET = String(Bun.env.CAKTO_WEBHOOK_SECRET || '');
const PRODUCT_ID = String(Bun.env.CAKTO_PRODUCT_ID || '').trim();
const PRODUCT_NAME = String(Bun.env.CAKTO_PRODUCT_NAME || 'Astra Acessor')
  .trim()
  .toLowerCase();
const DAYS = Number(Bun.env.CAKTO_ACCESS_DAYS || 30);
const MAX_BODY = 65536;
const GRANT_EVENTS = new Set([
  'purchase_approved',
  'subscription_renewed',
  'subscription_late_recovered',
]);
const REVOKE_EVENTS = new Set([
  'refund',
  'chargeback',
  'subscription_canceled',
  'subscription_paused',
]);
const RESUME_EVENTS = new Set(['subscription_resumed']);
const RELEVANT = new Set([...GRANT_EVENTS, ...REVOKE_EVENTS, ...RESUME_EVENTS]);
const BRAZIL_AREA_CODES = new Set([
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '21',
  '22',
  '24',
  '27',
  '28',
  '31',
  '32',
  '33',
  '34',
  '35',
  '37',
  '38',
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '53',
  '54',
  '55',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '68',
  '69',
  '71',
  '73',
  '74',
  '75',
  '77',
  '79',
  '81',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '91',
  '92',
  '93',
  '94',
  '95',
  '96',
  '97',
  '98',
  '99',
]);

function normalizePhone(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const value = input.trim();
  if (!/^\+?[0-9 ().-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  let normalized;
  if (value.startsWith('+')) {
    if (!/^[1-9]\d{9,14}$/.test(digits)) return null;
    normalized = digits;
  } else if (digits.length === 10 || digits.length === 11) {
    normalized = '55' + digits;
  } else if (/^55\d{10,11}$/.test(digits)) {
    normalized = digits;
  } else return null;
  if (normalized.startsWith('55')) {
    const national = normalized.slice(2);
    if (
      !BRAZIL_AREA_CODES.has(national.slice(0, 2)) ||
      !/^(?:\d{2}[2-9]\d{7}|\d{2}9\d{8})$/.test(national)
    )
      return null;
  }
  return normalized;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifySignature(headers, rawBody, now = Date.now()) {
  if (!SECRET || SECRET.length < 24) return false;
  const timestamp = headers.get('x-cakto-timestamp') || '';
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const signature = (headers.get('x-cakto-signature') || '')
    .split(',')
    .map((x) => x.trim())
    .find((x) => /^v1=[a-f0-9]{64}$/i.test(x));
  if (!signature) return false;
  const actual = createHmac('sha256', SECRET)
    .update(timestamp + '.')
    .update(rawBody)
    .digest('hex');
  return safeEqual(signature, 'v1=' + actual);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function idString(value) {
  const v = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return v.length >= 1 && v.length <= 120 && /^[\w.-]+$/.test(v) ? v : null;
}
function dateValue(value) {
  if (typeof value !== 'string' || value.length > 60) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}
function eventWhen(event, data) {
  if (event === 'refund') return dateValue(data.refundedAt) || new Date();
  if (event === 'chargeback') return dateValue(data.chargedbackAt) || new Date();
  if (event === 'subscription_canceled') return dateValue(data.canceledAt) || new Date();
  if (event === 'subscription_paused' || event === 'subscription_resumed') return new Date();
  return dateValue(data.paidAt) || new Date();
}
function productMatches(data) {
  const p = asObject(data.product);
  if (!p) return false;
  if (PRODUCT_ID) return String(p.id ?? '') === PRODUCT_ID;
  return typeof p.name === 'string' && p.name.trim().toLowerCase() === PRODUCT_NAME;
}

if (!Number.isInteger(DAYS) || DAYS < 1 || DAYS > 366) throw new Error('Invalid access days');
if (!SECRET || SECRET.length < 24) throw new Error('Missing Cakto webhook secret');
for (const field of ['POSTGRES_HOST', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) {
  if (!Bun.env[field]) throw new Error('Missing PostgreSQL configuration: ' + field);
}
const sql = new SQL({
  hostname: Bun.env.POSTGRES_HOST,
  port: Number(Bun.env.POSTGRES_PORT || 5432),
  username: Bun.env.POSTGRES_USER,
  password: Bun.env.POSTGRES_PASSWORD,
  database: Bun.env.POSTGRES_DB,
  max: 4,
  idleTimeout: 10,
  connectionTimeout: 8,
  connection: { application_name: 'astra-cakto-webhook', statement_timeout: '5000' },
});

await sql`CREATE TABLE IF NOT EXISTS astra_cakto_orders (
  order_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  product_id TEXT NOT NULL,
  subscription_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('paid','refunded','chargedback','canceled')),
  paid_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  event_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
await sql`CREATE INDEX IF NOT EXISTS astra_cakto_orders_phone ON astra_cakto_orders(phone,valid_until) WHERE status='paid'`;
await sql`CREATE TABLE IF NOT EXISTS astra_cakto_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','canceled','paused')),
  event_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
await sql`CREATE TABLE IF NOT EXISTS astra_cakto_events (
  event_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  outcome TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

// All operations for one buyer are committed together. No duplicate grant on Cakto retry.
async function applyEvent(event, data, digest) {
  if (!RELEVANT.has(event)) return { outcome: 'ignored_event' };
  if (!productMatches(data)) return { outcome: 'ignored_product' };
  if (data.offer_type && data.offer_type !== 'main') return { outcome: 'ignored_addon' };
  const orderId = idString(data.id);
  const customer = asObject(data.customer);
  const phone = normalizePhone(customer?.phone);
  if (!orderId || !phone) return { outcome: 'held_invalid_identity' };
  const subscription = asObject(data.subscription);
  const subId = idString(subscription?.id);
  const when = eventWhen(event, data);
  const whenISO = when.toISOString();
  const productId = String(asObject(data.product)?.id ?? '');
  const name = typeof customer?.name === 'string' ? customer.name.trim().slice(0, 120) : '';
  if (GRANT_EVENTS.has(event) && data.status !== 'paid') return { outcome: 'held_unpaid' };
  const paymentDate = GRANT_EVENTS.has(event) ? dateValue(data.paidAt) : null;
  if (GRANT_EVENTS.has(event) && !paymentDate) return { outcome: 'held_missing_payment_date' };
  const paymentUntil = paymentDate ? new Date(paymentDate.getTime() + DAYS * 86_400_000) : null;
  const key = event + ':' + orderId;

  return sql.begin(async (tx) => {
    // A transaction advisory lock serializes this phone's renewals and revocations.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`astra-cakto:${phone}`},0))`;
    const inserted =
      await tx`INSERT INTO astra_cakto_events(event_key,order_id,event_type,payload_digest,outcome)
      VALUES (${key},${orderId},${event},${digest},'processing') ON CONFLICT DO NOTHING RETURNING event_key`;
    if (!inserted.length) return { outcome: 'duplicate' };
    const existingOrder =
      await tx`SELECT phone,product_id FROM astra_cakto_orders WHERE order_id=${orderId} FOR UPDATE`;
    if (
      existingOrder.length &&
      (existingOrder[0].phone !== phone || existingOrder[0].product_id !== productId)
    ) {
      await tx`UPDATE astra_cakto_events SET outcome='held_order_conflict' WHERE event_key=${key}`;
      return { outcome: 'held_order_conflict' };
    }

    if (GRANT_EVENTS.has(event)) {
      await tx`INSERT INTO astra_cakto_orders(order_id,phone,product_id,subscription_id,status,paid_at,valid_until,event_at)
        VALUES (${orderId},${phone},${productId},${subId},'paid',${paymentDate.toISOString()},${paymentUntil.toISOString()},${whenISO})
        ON CONFLICT (order_id) DO UPDATE SET
        status='paid', paid_at=EXCLUDED.paid_at, valid_until=EXCLUDED.valid_until,
        subscription_id=EXCLUDED.subscription_id, event_at=EXCLUDED.event_at,updated_at=now()
        WHERE astra_cakto_orders.event_at <= EXCLUDED.event_at`;
      if (subId)
        await tx`INSERT INTO astra_cakto_subscriptions(subscription_id,phone,status,event_at)
        VALUES (${subId},${phone},'active',${whenISO}) ON CONFLICT(subscription_id) DO UPDATE SET
        status='active', event_at=EXCLUDED.event_at,updated_at=now()
        WHERE astra_cakto_subscriptions.event_at <= EXCLUDED.event_at AND astra_cakto_subscriptions.phone=EXCLUDED.phone`;
    } else if (event === 'refund' || event === 'chargeback') {
      const status = event === 'refund' ? 'refunded' : 'chargedback';
      await tx`INSERT INTO astra_cakto_orders(order_id,phone,product_id,subscription_id,status,event_at)
        VALUES (${orderId},${phone},${productId},${subId},${status},${whenISO})
        ON CONFLICT(order_id) DO UPDATE SET status=EXCLUDED.status,event_at=EXCLUDED.event_at,updated_at=now()
        WHERE astra_cakto_orders.event_at <= EXCLUDED.event_at`;
    } else if (event === 'subscription_canceled' || event === 'subscription_paused') {
      if (subId) {
        const status = event === 'subscription_canceled' ? 'canceled' : 'paused';
        await tx`INSERT INTO astra_cakto_subscriptions(subscription_id,phone,status,event_at)
          VALUES (${subId},${phone},${status},${whenISO})
          ON CONFLICT(subscription_id) DO UPDATE SET status=EXCLUDED.status,event_at=EXCLUDED.event_at,updated_at=now()
          WHERE astra_cakto_subscriptions.event_at <= EXCLUDED.event_at AND astra_cakto_subscriptions.phone=EXCLUDED.phone`;
      } else {
        await tx`UPDATE astra_cakto_orders SET status='canceled',event_at=${whenISO},updated_at=now()
          WHERE order_id=${orderId} AND phone=${phone} AND event_at<=${whenISO}`;
      }
    } else if (event === 'subscription_resumed' && subId) {
      await tx`INSERT INTO astra_cakto_subscriptions(subscription_id,phone,status,event_at)
        VALUES (${subId},${phone},'active',${whenISO})
        ON CONFLICT(subscription_id) DO UPDATE SET status='active',event_at=EXCLUDED.event_at,updated_at=now()
        WHERE astra_cakto_subscriptions.event_at <= EXCLUDED.event_at AND astra_cakto_subscriptions.phone=EXCLUDED.phone`;
    }

    // An account can have another still-active paid order. Never revoke it for an old refunded order.
    const entitlement = await tx`SELECT max(o.valid_until) AS expires
      FROM astra_cakto_orders o LEFT JOIN astra_cakto_subscriptions s ON s.subscription_id=o.subscription_id
      WHERE o.phone=${phone} AND o.status='paid' AND o.valid_until>now()
        AND (o.subscription_id IS NULL OR (s.status='active' AND s.phone=${phone}))`;
    const expires = entitlement[0]?.expires ? new Date(entitlement[0].expires) : null;
    const users =
      await tx`SELECT id,ownpilot_user_id,is_blocked,is_verified,access_source,access_expires_at,display_name
      FROM channel_users WHERE platform='whatsapp' AND platform_user_id=${phone} FOR UPDATE`;
    const user = users[0] || null;
    const retired =
      await tx`SELECT 1 FROM customer_phone_aliases WHERE phone_number=${phone} AND retired_at IS NOT NULL LIMIT 1`;
    let outcome = 'no_active_payment';
    if (
      retired.length ||
      (user && (user.is_blocked || user.ownpilot_user_id !== 'whatsapp:' + phone))
    ) {
      outcome = 'held_identity_conflict';
    } else if (
      user?.access_source === 'manual' &&
      user.is_verified &&
      (!user.access_expires_at || new Date(user.access_expires_at).getTime() > Date.now())
    ) {
      outcome = 'manual_access_preserved';
    } else if (expires && expires.getTime() > Date.now()) {
      if (!user) {
        await tx`INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,display_name,
          is_verified,verified_at,verification_method,status,access_expires_at,access_granted_at,access_source,metadata)
          VALUES (${randomUUID()},${'whatsapp:' + phone},'whatsapp',${phone},${name || null},true,now(),
          'admin','active',${expires.toISOString()},now(),'cakto',${JSON.stringify({ hasInteracted: false, manualPreauthorized: false, caktoManaged: true })}::jsonb)`;
      } else {
        await tx`UPDATE channel_users SET is_verified=true,verified_at=now(),verification_method='admin',
          status='active', access_expires_at=${expires.toISOString()}, access_granted_at=now(),
          access_source='cakto', display_name=COALESCE(NULLIF(display_name,''),${name || null})
          WHERE id=${user.id} AND NOT is_blocked`;
      }
      outcome = 'granted';
    } else if (user && user.access_source === 'cakto') {
      await tx`UPDATE channel_users SET is_verified=false,verified_at=NULL,verification_method=NULL,
        access_expires_at=now() WHERE id=${user.id} AND access_source='cakto'`;
      await tx`UPDATE channel_sessions SET is_active=false WHERE channel_user_id=${user.id}`;
      outcome = 'revoked';
    }
    await tx`UPDATE astra_cakto_events SET outcome=${outcome} WHERE event_key=${key}`;
    return { outcome };
  });
}

const noCache = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
function reply(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: noCache });
}

Bun.serve({
  hostname: '0.0.0.0',
  port: Number(Bun.env.PORT || 8080),
  maxRequestBodySize: MAX_BODY,
  async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname === '/health' && request.method === 'GET')
      return reply({ status: 'ok', service: 'astra-cakto-webhook', release: RELEASE });
    if (u.pathname !== '/webhooks/cakto') return reply({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      return reply({ error: 'invalid_content_type' }, 415);
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY)
      return reply({ error: 'payload_too_large' }, 413);
    if (!verifySignature(request.headers, raw)) return reply({ error: 'unauthorized' }, 401);
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return reply({ error: 'invalid_json' }, 400);
    }
    if (
      !asObject(envelope) ||
      typeof envelope.event !== 'string' ||
      !safeEqual(envelope.secret, SECRET)
    )
      return reply({ error: 'unauthorized' }, 401);
    if (envelope.event === 'checkout_abandonment' || !RELEVANT.has(envelope.event))
      return reply({ received: true, result: 'ignored' });
    const records = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
    if (!records.length || records.length > 15 || records.some((x) => !asObject(x)))
      return reply({ error: 'invalid_data' }, 422);
    const digest = createHash('sha256').update(raw).digest('hex');
    try {
      const outcomes = [];
      for (const record of records)
        outcomes.push((await applyEvent(envelope.event, record, digest)).outcome);
      console.log(JSON.stringify({ event: 'cakto_delivery', type: envelope.event, outcomes }));
      return reply({ received: true, outcomes });
    } catch (e) {
      console.error('CAKTO_PROCESSING_FAILED', e instanceof Error ? e.name : 'UnknownError');
      return reply({ error: 'processing_unavailable' }, 503);
    }
  },
});
console.log(JSON.stringify({ event: 'astra_cakto_ready', release: RELEASE }));
