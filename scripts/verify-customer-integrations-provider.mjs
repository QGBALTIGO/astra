import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Opt-in real-provider qualification. It never opens a channel transport or sends email.
assert.equal(process.env.POSTGRES_HOST, '127.0.0.1');
assert.match(process.env.POSTGRES_DB ?? '', /^astratest_integrations_/);
assert.match(process.env.ASTRA_INTEGRATION_TEST_OWNER ?? '', /^astra-customer:[a-zA-Z0-9_-]+$/);
const owner = process.env.ASTRA_INTEGRATION_TEST_OWNER;
const { setConfigCenter } = await import(
  pathToFileURL(resolve('packages/core/dist/services/index.js')).href
);
const { runInExecContext } = await import(
  pathToFileURL(resolve('packages/core/dist/agent/index.js')).href
);
const apiKey = (await fs.readFile(process.env.ASTRA_INTEGRATION_TEST_KEY_FILE, 'utf8')).trim();
assert.ok(apiKey && !apiKey.includes('*'));
setConfigCenter({
  getFieldValue: (service, field) =>
    service === 'composio' && field === 'api_key' ? apiKey : undefined,
});
process.env.ASTRA_CUSTOMER_OAUTH_ENABLED = 'true';
const mod = (path) => import(pathToFileURL(resolve('packages/gateway/src', path)).href);
const { initializeAdapter, getAdapter, closeAdapter } = await mod('db/adapters/index.ts');
await initializeAdapter();
const db = await getAdapter();
const { composioService } = await mod('services/composio-service.ts');
const { customerIntegrationService: service } = await mod('services/customer-integrations.ts');
const { customerIntegrationsRepo: repo } = await mod('db/repositories/customer-integrations.ts');
const { tryIntegrationConfirmation } = await mod('channels/customer-integrations.ts');
const { customerLocalDay, addCalendarDays } = await mod('services/customer-date.ts');
const suffix = randomUUID(),
  userId = 'lab:real-integration:' + suffix,
  chatId = 'synthetic-private';
const pluginId = 'channel.whatsapp.synthetic',
  messageId = 'request-' + suffix;
const summary = 'ASTRA TESTE FICTICIO ' + suffix.slice(0, 8);
const metrics = [];
let createdId;
try {
  const connections = await composioService.getCustomerConnections(owner);
  assert.ok(connections.some((c) => c.appName === 'googlecalendar' && c.status === 'ACTIVE'));
  assert.deepEqual(
    await composioService.getCustomerConnections('astra-customer:unrelated-' + suffix),
    [],
    'provider must filter by the specified customer'
  );
  await db.execute(
    `INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,display_name,is_verified,status)
    VALUES($1,$2,'whatsapp',$3,'Cliente fictício',TRUE,'active')`,
    ['channel-' + suffix, userId, 'synthetic-' + suffix]
  );
  await db.execute(
    `INSERT INTO customer_accounts(id,channel_user_id,data_user_id,current_phone,display_name,time_zone)
    VALUES($1,$2,$3,$4,'Cliente fictício','America/Cuiaba') ON CONFLICT(id) DO UPDATE SET channel_user_id=EXCLUDED.channel_user_id,data_user_id=EXCLUDED.data_user_id
    WHERE customer_accounts.data_user_id LIKE 'lab:real-integration:%'`,
    [
      owner.slice('astra-customer:'.length),
      'channel-' + suffix,
      userId,
      '199' + Date.now().toString().slice(-10),
    ]
  );
  const start = addCalendarDays(customerLocalDay(new Date(), 'America/Cuiaba'), 1) + 'T09:00:00';
  const args = {
    calendar_id: 'primary',
    summary,
    start_datetime: start,
    timezone: 'America/Cuiaba',
    event_duration_minutes: 15,
    send_updates: 'none',
  };
  const queueStart = performance.now();
  const proposal = await runInExecContext(
    {
      channelPluginId: pluginId,
      platformChatId: chatId,
      channelMessageId: messageId,
      channelIsPrivate: true,
      externalContentGuard: { seen: false },
    },
    () =>
      service.run(
        userId,
        'googlecalendar',
        'GOOGLECALENDAR_CREATE_EVENT',
        args,
        'Criar compromisso fictício de teste'
      )
  );
  assert.equal(proposal.confirmationRequired, true);
  const row = await repo.forMessage(userId, pluginId, chatId, messageId);
  assert.ok(row);
  await repo.markPromptSent(row.id, userId, pluginId, chatId);
  metrics.push({ step: 'prepare', ms: Math.round(performance.now() - queueStart) });
  const confirmationStart = performance.now();
  const reply = await tryIntegrationConfirmation(
    {
      id: 'confirm-' + suffix,
      channelPluginId: pluginId,
      platform: 'whatsapp',
      platformChatId: chatId,
      sender: { platformUserId: chatId },
      text: 'sim',
      timestamp: new Date(),
      metadata: {},
    },
    userId
  );
  const completed = (await repo.recent(userId))[0];
  assert.equal(completed.state, 'succeeded', String(reply));
  const result = completed.result?.data;
  createdId = result?.id ?? result?.event?.id ?? result?.response_data?.id;
  assert.ok(createdId, 'provider must return the created event identity');
  metrics.push({ step: 'confirm_create', ms: Math.round(performance.now() - confirmationStart) });
  const listStart = performance.now();
  const list = await service.run(userId, 'googlecalendar', 'GOOGLECALENDAR_EVENTS_LIST', {
    calendarId: 'primary',
    query: summary,
    maxResults: 10,
    singleEvents: true,
  });
  assert.match(JSON.stringify(list), new RegExp(summary));
  metrics.push({ step: 'read_after_write', ms: Math.round(performance.now() - listStart) });
  const cached = await service.run(userId, 'googlecalendar', 'GOOGLECALENDAR_EVENTS_LIST', {
    calendarId: 'primary',
    query: summary,
    maxResults: 10,
    singleEvents: true,
  });
  assert.equal(cached.cached, true);
  const imported = await db.queryOne(
    'SELECT title,start_time FROM calendar_events WHERE user_id=$1 AND external_id=$2',
    [userId, createdId]
  );
  assert.equal(imported?.title, summary);
  assert.match(
    new Date(imported.start_time).toISOString(),
    /T13:00:00.000Z$/,
    '09:00 Cuiabá must be 13:00 UTC'
  );
  const telegramPlugin = 'channel.telegram.synthetic',
    telegramMessage = 'update-' + suffix;
  const updateArgs = {
    calendar_id: 'primary',
    event_id: createdId,
    summary: summary + ' atualizado',
    start_datetime: start.replace('T09:00:00', 'T09:15:00'),
    timezone: 'America/Cuiaba',
    event_duration_minutes: 15,
    send_updates: 'none',
  };
  await runInExecContext(
    {
      channelPluginId: telegramPlugin,
      platformChatId: chatId,
      channelMessageId: telegramMessage,
      channelIsPrivate: true,
      externalContentGuard: { seen: false },
    },
    () =>
      service.run(
        userId,
        'googlecalendar',
        'GOOGLECALENDAR_UPDATE_EVENT',
        updateArgs,
        'Remarcar o compromisso fictício para 9h15'
      )
  );
  const update = await repo.forMessage(userId, telegramPlugin, chatId, telegramMessage);
  assert.ok(update);
  await repo.markPromptSent(update.id, userId, telegramPlugin, chatId);
  const updateStart = performance.now();
  await tryIntegrationConfirmation(
    {
      id: 'confirm-update-' + suffix,
      channelPluginId: telegramPlugin,
      platform: 'telegram',
      platformChatId: chatId,
      sender: { platformUserId: chatId },
      text: 'sim',
      timestamp: new Date(),
      metadata: { chatType: 'private' },
    },
    userId
  );
  assert.equal((await repo.recent(userId, telegramPlugin, chatId))[0].state, 'succeeded');
  const changed = await service.run(userId, 'googlecalendar', 'GOOGLECALENDAR_EVENTS_LIST', {
    calendarId: 'primary',
    query: summary,
    maxResults: 10,
    singleEvents: true,
  });
  assert.match(
    JSON.stringify(changed),
    /atualizado/,
    'read cache must be invalidated after the Telegram update'
  );
  const mirror = await db.queryOne(
    'SELECT title,start_time FROM calendar_events WHERE user_id=$1 AND external_id=$2',
    [userId, createdId]
  );
  assert.equal(mirror.title, summary + ' atualizado');
  assert.match(new Date(mirror.start_time).toISOString(), /T13:15:00.000Z$/);
  metrics.push({
    step: 'telegram_confirm_update_and_read',
    ms: Math.round(performance.now() - updateStart),
  });
  const gmail = connections.find((c) => c.appName === 'gmail' && c.status === 'ACTIVE');
  if (gmail) {
    const t = performance.now();
    const inbox = await service.run(userId, 'gmail', 'GMAIL_FETCH_EMAILS', {
      user_id: 'me',
      max_results: 1,
      query: 'in:inbox',
      verbose: false,
      include_payload: false,
    });
    assert.ok(inbox.source);
    metrics.push({ step: 'gmail_read', ms: Math.round(performance.now() - t) });
    const { buildEmailDigest } = await mod('services/email-digest.ts');
    const digestStarted = performance.now();
    const digest = await buildEmailDigest(userId, pluginId, gmail.id);
    assert.match(digest, /Seus e-mails importantes/);
    assert.ok(
      digest.includes('• *Resumo:*') || digest.includes('Não encontrei mensagens recentes'),
      'Non-empty Gmail digests must include readable message previews'
    );
    assert.doesNotMatch(digest, /message_id|event_id|untrustedExternalData|"messages"\s*:/);
    metrics.push({
      step: 'gmail_digest_readonly_source',
      ms: Math.round(performance.now() - digestStarted),
    });
  }
  const pinned = connections.find((c) => c.appName === 'googlecalendar');
  await assert.rejects(
    service.run(userId, 'googlecalendar', 'GOOGLECALENDAR_EVENTS_LIST', {}, undefined, 'ca_foreign')
  );
  // Remove only the event this test just created. Calendar deletion is recoverable in Google's Trash.
  const removal = await composioService.executeCustomerSession(
    owner,
    'googlecalendar',
    pinned.id,
    'GOOGLECALENDAR_DELETE_EVENT',
    { calendar_id: 'primary', event_id: createdId, send_updates: 'none' }
  );
  assert.notEqual(removal?.successful, false);
  createdId = null;
  const proof = {
    passed: true,
    realCustomerOAuth: true,
    operatorFallback: false,
    providerUserFilter: true,
    privateChannelConfirmation: true,
    whatsappRouting: true,
    telegramRouting: true,
    createdEventVerifiedByRead: true,
    updateVerifiedByRead: true,
    localCalendarMirror: true,
    cuiabaTimezone: true,
    readCache: true,
    gmailRead: !!gmail,
    testEventRemoved: true,
    metrics,
  };
  console.log(JSON.stringify(proof));
  if (process.env.ASTRA_INTEGRATION_TEST_PROOF)
    await fs.writeFile(process.env.ASTRA_INTEGRATION_TEST_PROOF, JSON.stringify(proof, null, 2));
} finally {
  if (createdId) console.error('The synthetic test event needs review; no write was retried.');
  await closeAdapter();
}
