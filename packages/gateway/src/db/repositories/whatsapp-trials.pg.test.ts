import { randomUUID, createHash } from 'node:crypto';
import { ONBOARDING_BACKLOG_SQL } from '../../services/whatsapp-onboarding-health.js';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../adapters/types.js';
import {
  CHANNELS_TABLES_SQL,
  CHANNELS_MIGRATIONS_SQL,
  CHANNELS_INDEXES_SQL,
} from '../schema/channels.js';
import { WhatsAppTrialsRepository } from './whatsapp-trials.js';
import { ChannelAccessNotificationsRepository } from './channel-access-notifications.js';
import {
  ChannelAccessInboundNoticesRepository,
  wasInboundAccessNoticeHandled,
} from './channel-access-inbound-notices.js';
import { ChannelUsersRepository } from './channels/users.js';

describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)(
  'first-contact WhatsApp trials on PostgreSQL',
  () => {
    const schema = 'trial_' + randomUUID().replaceAll('-', '');
    const clients: Client[] = [];
    const repos: WhatsAppTrialsRepository[] = [];
    const notices: ChannelAccessNotificationsRepository[] = [];
    const welcomes: ChannelAccessInboundNoticesRepository[] = [];
    const phone = '5567999981234';
    const input = {
      platform: 'whatsapp',
      platformUserId: phone,
      ownpilotUserId: 'whatsapp:' + phone,
      displayName: 'Pessoa sintética',
    };
    beforeAll(async () => {
      for (let i = 0; i < 2; i++) {
        const c = new Client({
          host: '127.0.0.1',
          port: Number(process.env.ASTRA_REVIEW_PG_PORT),
          user: process.env.ASTRA_REVIEW_PG_USER ?? 'astratest',
          database: process.env.ASTRA_REVIEW_PG_DATABASE ?? 'astratest_review',
          password: process.env.ASTRA_REVIEW_PG_PASSWORD,
        });
        await c.connect();
        clients.push(c);
        await c.query('SET statement_timeout=5000');
      }
      await clients[0]!.query('CREATE SCHEMA ' + schema);
      for (const c of clients) await c.query('SET search_path TO ' + schema);
      await clients[0]!.query(`CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT);
      CREATE TABLE system_settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE customer_phone_aliases(phone_number TEXT PRIMARY KEY,retired_at TIMESTAMPTZ);
      CREATE TABLE customer_accounts(current_phone TEXT,data_user_id TEXT);
      CREATE TABLE channel_messages(id TEXT PRIMARY KEY,direction TEXT,sender_id TEXT,metadata JSONB DEFAULT '{}')`);
      await clients[0]!.query(CHANNELS_TABLES_SQL);
      await clients[0]!.query(CHANNELS_MIGRATIONS_SQL);
      await clients[0]!.query(CHANNELS_INDEXES_SQL);
      for (const c of clients) {
        const adapter = {
          isConnected: () => true,
          query: async (sql: string, p?: unknown[]) => (await c.query(sql, p)).rows,
          queryOne: async (sql: string, p?: unknown[]) => (await c.query(sql, p)).rows[0] ?? null,
          execute: async (sql: string, p?: unknown[]) => ({
            changes: (await c.query(sql, p)).rowCount ?? 0,
          }),
          transaction: async <T>(fn: () => Promise<T>) => {
            await c.query('BEGIN');
            try {
              const v = await fn();
              await c.query('COMMIT');
              return v;
            } catch (e) {
              await c.query('ROLLBACK');
              throw e;
            }
          },
        } as unknown as DatabaseAdapter;
        repos.push(Object.assign(new WhatsAppTrialsRepository(), { adapter }));
        notices.push(Object.assign(new ChannelAccessNotificationsRepository(), { adapter }));
        const users = Object.assign(new ChannelUsersRepository(), { adapter });
        welcomes.push(Object.assign(new ChannelAccessInboundNoticesRepository(users), { adapter }));
      }
    });
    beforeEach(async () => {
      await clients[0]!.query(`TRUNCATE channel_users CASCADE;
    TRUNCATE whatsapp_trial_claims,system_settings,customer_phone_aliases,channel_messages,conversations,customer_accounts,channel_assets CASCADE`);
    });
    afterAll(async () => {
      if (clients[0]) await clients[0].query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await Promise.all(clients.map((c) => c.end()));
    });
    async function row() {
      return (
        await clients[0]!.query('SELECT * FROM channel_users WHERE platform_user_id=$1', [phone])
      ).rows[0];
    }
    async function onboardingProbe() {
      return (await clients[0]!.query(ONBOARDING_BACKLOG_SQL)).rows[0];
    }
    async function overdueTrial() {
      const id = await repos[0]!.createNewContact(input);
      await clients[0]!.query(
        `UPDATE channel_users SET
        access_granted_at=access_granted_at-INTERVAL '11 minutes',
        access_expires_at=access_expires_at-INTERVAL '11 minutes' WHERE id=$1`,
        [id]
      );
      await clients[0]!.query(
        `UPDATE channel_access_notifications n SET
        access_granted_at=u.access_granted_at,access_expires_at=u.access_expires_at
        FROM channel_users u WHERE n.channel_user_id=u.id AND u.id=$1`,
        [id]
      );
      return id;
    }
    it('read-only readiness detects a late welcome but not a fresh trial', async () => {
      expect(await onboardingProbe()).toEqual({ ledger_ready: true, overdue_welcome: false });
      await repos[0]!.createNewContact(input);
      expect(await onboardingProbe()).toEqual({ ledger_ready: true, overdue_welcome: false });
      await clients[0]!.query(
        `UPDATE channel_users SET access_granted_at=access_granted_at-INTERVAL '11 minutes'`
      );
      expect(await onboardingProbe()).toEqual({ ledger_ready: true, overdue_welcome: true });
    });
    it('flags uncertain delivery without retrying it and accepts a persisted receipt', async () => {
      const id = await overdueTrial();
      await clients[0]!.query(
        `UPDATE channel_access_notifications SET status='failed' WHERE channel_user_id=$1 AND kind='approved'`,
        [id]
      );
      expect((await onboardingProbe()).overdue_welcome).toBe(true);
      const before = (
        await clients[0]!.query('SELECT * FROM channel_access_notifications ORDER BY id')
      ).rows;
      await onboardingProbe();
      expect(
        (await clients[0]!.query('SELECT * FROM channel_access_notifications ORDER BY id')).rows
      ).toEqual(before);
      await clients[0]!.query(
        `UPDATE channel_access_notifications SET status='delivered',delivery_id='synthetic-receipt' WHERE channel_user_id=$1 AND kind='approved'`,
        [id]
      );
      expect((await onboardingProbe()).overdue_welcome).toBe(false);
    });
    it('does not mistake a pre-send welcome claim marker for a delivery receipt', async () => {
      const id = await overdueTrial();
      await clients[0]!.query(
        `UPDATE channel_users SET metadata=metadata ||
        '{"astraAccessNotices":{"firstAuthorized":true,"firstAuthorizedAsTrial":true,"firstAuthorizedClaimToken":"synthetic-lease"}}'::jsonb WHERE id=$1`,
        [id]
      );
      for (const status of ['claimed', 'sending', 'failed', 'cancelled']) {
        await clients[0]!.query(
          `UPDATE channel_access_notifications SET status=$2,delivery_id=NULL
          WHERE channel_user_id=$1 AND kind='approved'`,
          [id, status]
        );
        expect((await onboardingProbe()).overdue_welcome, status).toBe(true);
      }
      for (const emptyReceipt of ['', '   ']) {
        await clients[0]!.query(
          `UPDATE channel_access_notifications SET status='delivered',delivery_id=$2
          WHERE channel_user_id=$1 AND kind='approved'`,
          [id, emptyReceipt]
        );
        expect((await onboardingProbe()).overdue_welcome).toBe(true);
      }
      await clients[0]!.query(
        `UPDATE channel_access_notifications SET status='delivered',delivery_id='synthetic-confirmed'
        WHERE channel_user_id=$1 AND kind='approved'`,
        [id]
      );
      expect((await onboardingProbe()).overdue_welcome).toBe(false);
    });

    it.each(['blocked', 'revoked', 'expired'])(
      'does not alert for an intentionally inactive trial: %s',
      async (reason) => {
        const id = await overdueTrial();
        const mutations: Record<string, string> = {
          blocked: 'is_blocked=TRUE',
          revoked: 'is_verified=FALSE',
          expired: "access_expires_at=NOW()-INTERVAL '1 minute'",
        };
        await clients[0]!.query('UPDATE channel_users SET ' + mutations[reason] + ' WHERE id=$1', [
          id,
        ]);
        expect((await onboardingProbe()).overdue_welcome).toBe(false);
      }
    );
    it('does not mistake another access cycle receipt for a current welcome', async () => {
      const id = await overdueTrial();
      await clients[0]!.query(
        `UPDATE channel_access_notifications SET status='delivered',delivery_id='old-receipt',access_granted_at=access_granted_at-INTERVAL '1 day' WHERE channel_user_id=$1 AND kind='approved'`,
        [id]
      );
      expect((await onboardingProbe()).overdue_welcome).toBe(true);
    });
    const recovery = { requestId: 'recovery-synthetic-request', phone, botPhone: '5567988880000' };
    async function discovered() {
      await clients[0]!.query(
        `INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,status,metadata)
        VALUES('discovered',$1,'whatsapp',$2,'pending','{"hasInteracted":true,"discoveredFromHistory":true,"preserve":true}')`,
        [input.ownpilotUserId, phone]
      );
    }
    it('queues a privileged first-contact recovery without inventing an inbound interaction', async () => {
      const result = await repos[0]!.recoverFirstContactTrial(recovery);
      expect(result).toMatchObject({ outcome: 'queued' });
      const user = await row();
      expect(user).toMatchObject({
        id: result.userId,
        is_verified: true,
        access_source: 'trial',
        status: 'active',
      });
      expect(user.metadata).toMatchObject({
        hasInteracted: false,
        accessWelcomePending: true,
        astraFirstContactRecovery: {
          requestId: recovery.requestId,
          source: 'authorized_first_contact',
          confirmedIncoming: false,
          accessGrantedAt: user.access_granted_at.toISOString(),
          accessExpiresAt: user.access_expires_at.toISOString(),
        },
      });
      expect(user.access_expires_at.getTime() - user.access_granted_at.getTime()).toBe(
        72 * 3600_000
      );
      expect((await clients[0]!.query('SELECT * FROM channel_messages')).rows).toHaveLength(0);
      expect((await clients[0]!.query('SELECT * FROM whatsapp_trial_claims')).rows).toHaveLength(2);
      const queuedNotices = (await clients[0]!.query('SELECT * FROM channel_access_notifications'))
        .rows;
      expect(queuedNotices).toHaveLength(2);
      expect(queuedNotices.find((n) => n.kind === 'approved')).toMatchObject({
        status: 'pending',
        channel_user_id: user.id,
      });
      const [welcome] = await notices[0]!.claimDue();
      expect(welcome?.kind).toBe('approved');
      expect(
        await notices[0]!.beginSend(
          welcome!.id,
          welcome!.leaseToken!,
          'channel.whatsapp',
          new Date(),
          recovery.botPhone
        )
      ).toBe(true);
      expect((await row()).metadata.hasInteracted).toBe(false);
      expect(await repos[1]!.recoverFirstContactTrial(recovery)).toMatchObject({
        outcome: 'skipped',
      });
      expect((await row()).access_expires_at).toEqual(user.access_expires_at);
      expect(
        (await clients[0]!.query('SELECT * FROM channel_access_notifications')).rows
      ).toHaveLength(2);
    });
    it('recovers only a pure unanswered discovery in place and preserves its original history metadata', async () => {
      await discovered();
      const before = await row();
      expect(await repos[0]!.recoverFirstContactTrial(recovery)).toMatchObject({
        outcome: 'queued',
        userId: 'discovered',
      });
      const user = await row();
      expect(user.first_seen_at).toEqual(before.first_seen_at);
      expect(user.last_seen_at).toEqual(before.last_seen_at);
      expect(user.metadata).toMatchObject({
        hasInteracted: true,
        discoveredFromHistory: true,
        preserve: true,
        astraFirstContactRecovery: { confirmedIncoming: true },
      });
    });
    it('serializes two recovery processors against a real first-contact enrollment', async () => {
      const results = await Promise.all([
        repos[0]!.recoverFirstContactTrial(recovery),
        repos[1]!.createNewContact(input),
      ]);
      expect(
        results.filter(
          (r) => typeof r === 'string' || (r && typeof r === 'object' && r.outcome === 'queued')
        )
      ).toHaveLength(1);
      expect((await clients[0]!.query('SELECT * FROM channel_users')).rows).toHaveLength(1);
      expect(
        (await clients[0]!.query('SELECT * FROM channel_access_notifications')).rows
      ).toHaveLength(2);
      expect((await clients[0]!.query('SELECT * FROM whatsapp_trial_claims')).rows).toHaveLength(2);
    });
    it('rejects a bot spelling and malformed recovery inputs before writing anything', async () => {
      for (const invalid of [
        { ...recovery, requestId: 'bad' },
        { ...recovery, phone: 'temporary@lid' },
        { ...recovery, botPhone: 'invalid' },
        { ...recovery, botPhone: phone },
        { ...recovery, botPhone: '556799981234' },
        { ...recovery, displayName: '\u0000' },
      ])
        expect(await repos[0]!.recoverFirstContactTrial(invalid)).toMatchObject({
          outcome: 'skipped',
        });
      expect((await clients[0]!.query('SELECT * FROM channel_users')).rows).toHaveLength(0);
    });
    it.each([
      'owner',
      'alias',
      'account',
      'claim',
      'inbound',
      'outbound',
      'conversation',
      'session',
      'asset',
      'notice',
      'notice_metadata',
      'active',
      'blocked',
      'expired',
      'paid',
      'unconfirmed',
      'alternate',
    ] as const)('does not recover a contact with existing %s evidence', async (kind) => {
      await discovered();
      if (kind === 'owner')
        await clients[0]!.query("INSERT INTO system_settings VALUES('owner_whatsapp',$1)", [phone]);
      if (kind === 'alias')
        await clients[0]!.query('INSERT INTO customer_phone_aliases VALUES($1,NULL)', [phone]);
      if (kind === 'account')
        await clients[0]!.query('INSERT INTO customer_accounts VALUES($1,$2)', [
          phone,
          input.ownpilotUserId,
        ]);
      if (kind === 'claim')
        await clients[0]!.query(
          "INSERT INTO whatsapp_trial_claims VALUES($1,NOW()-INTERVAL '4 days',NOW()-INTERVAL '1 day')",
          [phone]
        );
      if (kind === 'inbound')
        await clients[0]!.query(
          "INSERT INTO channel_messages(id,direction,sender_id) VALUES('prior','inbound',$1)",
          [phone]
        );
      if (kind === 'outbound')
        await clients[0]!.query(
          "INSERT INTO channel_messages VALUES('prior','outbound','assistant',$1::jsonb)",
          [JSON.stringify({ platformChatId: phone })]
        );
      if (kind === 'conversation')
        await clients[0]!.query("INSERT INTO conversations VALUES('prior',$1)", [
          input.ownpilotUserId,
        ]);
      if (kind === 'session')
        await clients[0]!.query(
          "INSERT INTO channel_sessions(id,channel_user_id,channel_plugin_id,platform_chat_id) VALUES('prior','discovered','channel.whatsapp',$1)",
          [phone]
        );
      if (kind === 'asset')
        await clients[0]!.query(
          "INSERT INTO channel_assets(id,channel_message_id,channel_plugin_id,platform,platform_chat_id,type,mime_type,storage_path,sha256,expires_at) VALUES('prior','prior','channel.whatsapp','whatsapp',$1,'image','image/png','synthetic','synthetic',NOW()+INTERVAL '1 hour')",
          [phone]
        );
      if (kind === 'notice')
        await clients[0]!.query(
          "INSERT INTO channel_access_notifications(id,channel_user_id,ownpilot_user_id,platform_user_id,kind,cycle_key,status) VALUES('prior','discovered',$1,$2,'approved','prior','failed')",
          [input.ownpilotUserId, phone]
        );
      if (kind === 'notice_metadata')
        await clients[0]!.query(
          'UPDATE channel_users SET metadata=metadata || \'{"astraAccessNotices":{"firstAuthorized":true}}\''
        );
      if (kind === 'active')
        await clients[0]!.query("UPDATE channel_users SET is_verified=TRUE,status='active'");
      if (kind === 'blocked') await clients[0]!.query('UPDATE channel_users SET is_blocked=TRUE');
      if (kind === 'expired')
        await clients[0]!.query(
          "UPDATE channel_users SET access_source='trial',access_expires_at=NOW()-INTERVAL '1 day'"
        );
      if (kind === 'paid')
        await clients[0]!.query("UPDATE channel_users SET access_source='cakto'");
      if (kind === 'unconfirmed')
        await clients[0]!.query(
          'UPDATE channel_users SET metadata=\'{"hasInteracted":false,"discoveredFromLinkedSession":true}\''
        );
      if (kind === 'alternate')
        await clients[0]!.query(
          "INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,status) VALUES('alternate','whatsapp:556799981234','whatsapp','556799981234','pending')"
        );
      const before = await row();
      expect(await repos[0]!.recoverFirstContactTrial(recovery)).toMatchObject({
        outcome: 'skipped',
      });
      expect(await row()).toEqual(before);
    });
    it('rolls back the recovery grant when durable lifecycle insertion fails', async () => {
      await discovered();
      await clients[0]!.query(
        "ALTER TABLE channel_access_notifications ADD CONSTRAINT reject_recovery_notice CHECK(kind <> 'approved')"
      );
      try {
        await expect(repos[0]!.recoverFirstContactTrial(recovery)).rejects.toMatchObject({
          code: '23514',
        });
        expect(await row()).toMatchObject({
          id: 'discovered',
          is_verified: false,
          status: 'pending',
          access_source: null,
        });
        expect((await clients[0]!.query('SELECT * FROM whatsapp_trial_claims')).rows).toHaveLength(
          0
        );
      } finally {
        await clients[0]!.query(
          'ALTER TABLE channel_access_notifications DROP CONSTRAINT reject_recovery_notice'
        );
      }
    });
    async function prepareUnsentWelcome() {
      await repos[0]!.createNewContact(input);
      const user = await row();
      const message = 'first-message';
      const key = createHash('sha256').update(message).digest('hex');
      const token = randomUUID();
      await clients[0]!.query(`UPDATE channel_users SET metadata=metadata || $1::jsonb`, [
        JSON.stringify({
          preserve: true,
          astraAccessNotices: {
            firstAuthorized: true,
            firstAuthorizedAsTrial: true,
            firstAuthorizedMessageKey: key,
            firstAuthorizedClaimToken: token,
            messageIds: [key, 'another-message'],
          },
        }),
      ]);
      return {
        id: user.id,
        message,
        token,
        cycle: `active|${user.access_granted_at.toISOString()}|${user.access_expires_at.toISOString()}`,
      };
    }
    it('releases only its known-unsent welcome and keeps the trial deadline unchanged', async () => {
      const claim = await prepareUnsentWelcome();
      const expiry = (await row()).access_expires_at;
      expect(
        await welcomes[0]!.releaseBeforeSend(claim.id, claim.message, claim.cycle, claim.token)
      ).toBe(true);
      expect(
        await welcomes[1]!.releaseBeforeSend(claim.id, claim.message, claim.cycle, claim.token)
      ).toBe(false);
      const user = await row();
      expect(user.access_expires_at).toEqual(expiry);
      expect(user.metadata).toMatchObject({
        preserve: true,
        accessWelcomePending: true,
        astraAccessNotices: { firstAuthorized: false, messageIds: ['another-message'] },
      });
    });
    it.each(['wrong-token', 'wrong-message', 'renewed', 'blocked'])(
      'never rewinds a stale or invalid welcome claim: %s',
      async (reason) => {
        const claim = await prepareUnsentWelcome();
        if (reason === 'renewed')
          await clients[0]!.query(
            "UPDATE channel_users SET access_source='cakto',access_expires_at=NOW()+INTERVAL '30 days'"
          );
        if (reason === 'blocked')
          await clients[0]!.query('UPDATE channel_users SET is_blocked=TRUE');
        expect(
          await welcomes[0]!.releaseBeforeSend(
            claim.id,
            reason === 'wrong-message' ? 'other' : claim.message,
            claim.cycle,
            reason === 'wrong-token' ? 'stale' : claim.token
          )
        ).toBe(false);
        expect((await row()).metadata.astraAccessNotices.firstAuthorized).toBe(true);
      }
    );
    it('persists a recoverable welcome even if the process stops immediately after enrollment', async () => {
      await repos[0]!.createNewContact(input);
      const queued = (
        await clients[0]!.query("SELECT * FROM channel_access_notifications WHERE kind='approved'")
      ).rows;
      expect(queued).toHaveLength(1);
      expect(queued[0].status).toBe('pending');
      const [claim] = await notices[1]!.claimDue(20, new Date(Date.now() + 1000));
      expect(claim?.kind).toBe('approved');
    });
    it('recovers an unsent welcome lease across connections and marks the delivered onboarding once', async () => {
      await repos[0]!.createNewContact(input);
      const now = new Date(Date.now() + 1000);
      const [first] = await notices[0]!.claimDue(20, now);
      expect(first?.kind).toBe('approved');
      expect(await notices[1]!.claimDue(20, now)).toHaveLength(0);
      const later = new Date(now.getTime() + 121000);
      const [recovered] = await notices[1]!.claimDue(20, later);
      expect(recovered?.id).toBe(first!.id);
      expect(recovered?.leaseToken).not.toBe(first!.leaseToken);
      expect(
        await notices[0]!.beginSend(
          first!.id,
          first!.leaseToken!,
          'channel.whatsapp',
          later,
          '5567999991111'
        )
      ).toBe(false);
      expect(
        await notices[1]!.beginSend(
          recovered!.id,
          recovered!.leaseToken!,
          'channel.whatsapp',
          later,
          '5567999991111'
        )
      ).toBe(true);
      await notices[1]!.finish(
        recovered!.id,
        recovered!.leaseToken!,
        'delivered',
        { deliveryId: 'synthetic-receipt' },
        later
      );
      expect(
        await notices[1]!.markTrialWelcomeDelivered(recovered!.id, recovered!.channelUserId)
      ).toBe(true);
      expect((await row()).metadata).toMatchObject({
        accessWelcomePending: false,
        astraAccessNotices: { firstAuthorized: true, firstAuthorizedAsTrial: true },
      });
      expect(await notices[0]!.claimDue(20, later)).toHaveLength(0);
    });
    it('shares the first welcome between the inbound handler and recovery worker without duplicate sends', async () => {
      await repos[0]!.createNewContact(input);
      const user = await row();
      const now = new Date(Date.now() + 1000);
      const inbound = await welcomes[0]!.claim(
        user.id,
        'first-real-request',
        'first_authorized',
        now,
        false
      );
      expect(inbound?.notificationId).toBeTruthy();
      expect(inbound?.claimToken).toBeTruthy();
      expect(await notices[1]!.claimDue(20, now)).toHaveLength(0);
      const actual = await Object.assign(new ChannelUsersRepository(), {
        adapter: (welcomes[0] as unknown as { adapter: DatabaseAdapter }).adapter,
      }).getById(user.id);
      expect(wasInboundAccessNoticeHandled(actual!, 'first-real-request')).toBe(false);
      expect(
        await welcomes[0]!.releaseBeforeSend(
          user.id,
          'first-real-request',
          inbound!.cycle,
          inbound!.claimToken
        )
      ).toBe(true);
      const [recovered] = await notices[1]!.claimDue(20, new Date(Date.now() + 2000));
      expect(recovered?.id).toBe(inbound!.notificationId);
      expect(
        await notices[0]!.beginSend(
          recovered!.id,
          inbound!.claimToken!,
          'channel.whatsapp',
          now,
          '5567999991111'
        )
      ).toBe(false);
      expect(
        await notices[1]!.beginSend(
          recovered!.id,
          recovered!.leaseToken!,
          'channel.whatsapp',
          now,
          '5567999991111'
        )
      ).toBe(true);
      await notices[1]!.finish(
        recovered!.id,
        recovered!.leaseToken!,
        'delivered',
        { deliveryId: 'synthetic-receipt' },
        now
      );
      await notices[1]!.markTrialWelcomeDelivered(recovered!.id, user.id);
      expect(await welcomes[0]!.claim(user.id, 'second-hello', 'first_authorized', now)).toBeNull();
    });
    it('does not let a stale inline handler reset the welcome after a worker takes over', async () => {
      await repos[0]!.createNewContact(input);
      const user = await row();
      const now = new Date(Date.now() + 1000);
      const inbound = await welcomes[0]!.claim(user.id, 'first-hello', 'first_authorized', now);
      const later = new Date(now.getTime() + 121000);
      const [recovered] = await notices[1]!.claimDue(20, later);
      expect(recovered?.id).toBe(inbound!.notificationId);
      expect(
        await welcomes[0]!.releaseBeforeSend(
          user.id,
          'first-hello',
          inbound!.cycle,
          inbound!.claimToken
        )
      ).toBe(false);
      const queued = (
        await clients[0]!.query(
          'SELECT status,lease_token FROM channel_access_notifications WHERE id=$1',
          [recovered!.id]
        )
      ).rows[0];
      expect(queued).toMatchObject({ status: 'claimed', lease_token: recovered!.leaseToken });
      expect((await row()).metadata.astraAccessNotices.firstAuthorized).toBe(true);
    });
    it('grants exactly 72 hours and durably schedules one expiry notification', async () => {
      const id = await repos[0]!.createNewContact(input);
      const user = await row();
      expect(user).toMatchObject({
        id,
        access_source: 'trial',
        is_verified: true,
        status: 'active',
      });
      expect(user.access_expires_at.getTime() - user.access_granted_at.getTime()).toBe(
        72 * 3600_000
      );
      const queued = (await clients[0]!.query('SELECT * FROM channel_access_notifications')).rows;
      expect(queued).toHaveLength(2);
      expect(queued.find((n) => n.kind === 'trial_expired')).toMatchObject({
        kind: 'trial_expired',
        duration_days: 3,
        available_at: user.access_expires_at,
      });
      expect(await repos[1]!.createNewContact(input)).toBeNull();
      expect((await row()).access_expires_at).toEqual(user.access_expires_at);
    });
    it('keeps first-touch referral attribution immutable across repeated messages', async () => {
      await repos[0]!.createNewContact({ ...input, trialReferral: 'julio' });
      expect((await row()).metadata.astraTrialReferral).toBe('julio');
      await repos[1]!.createNewContact(input);
      expect((await row()).metadata.astraTrialReferral).toBe('julio');
    });
    it('does not attach a referral to an old or previously enrolled contact', async () => {
      await repos[0]!.createNewContact(input);
      await repos[1]!.createNewContact({ ...input, trialReferral: 'julio' });
      expect((await row()).metadata.astraTrialReferral).toBeUndefined();
    });
    it('enrolls 100 distinct first contacts and never renews any on replay', async () => {
      const first = new Map<string, Date>();
      for (let i = 0; i < 100; i++) {
        const number = String(244927010000 + i);
        const id = await repos[0]!.createNewContact({
          ...input,
          platformUserId: number,
          ownpilotUserId: 'whatsapp:' + number,
        });
        expect(id).toBeTruthy();
        const u = (await clients[0]!.query('SELECT * FROM channel_users WHERE id=$1', [id]))
          .rows[0];
        expect(u.is_verified).toBe(true);
        expect(u.access_source).toBe('trial');
        expect(u.ownpilot_user_id).toBe('whatsapp:' + number);
        expect(u.access_expires_at.getTime() - u.access_granted_at.getTime()).toBe(72 * 3600_000);
        first.set(number, u.access_expires_at);
      }
      for (const [number, expiry] of first) {
        expect(
          await repos[1]!.createNewContact({
            ...input,
            platformUserId: number,
            ownpilotUserId: 'whatsapp:' + number,
          })
        ).toBeNull();
        expect(
          (
            await clients[0]!.query(
              'SELECT access_expires_at FROM channel_users WHERE platform_user_id=$1',
              [number]
            )
          ).rows[0].access_expires_at
        ).toEqual(expiry);
      }
      expect(
        (await clients[0]!.query('SELECT count(*)::integer AS n FROM channel_access_notifications'))
          .rows[0].n
      ).toBe(200);
    }, 30000);
    it('serializes simultaneous first messages across independent connections', async () => {
      const ids = await Promise.all(repos.map((r) => r.createNewContact(input)));
      expect(ids.filter(Boolean)).toHaveLength(1);
      expect(
        (await clients[0]!.query('SELECT * FROM channel_access_notifications')).rows
      ).toHaveLength(2);
    });
    it.each(['pending', 'blocked', 'paid', 'manual'] as const)(
      'never enrolls an existing %s contact',
      async (mode) => {
        await clients[0]!.query(
          `INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,status,is_blocked,access_source,is_verified)
      VALUES('old',$1,'whatsapp',$2,'pending',$3,$4,$5)`,
          [
            input.ownpilotUserId,
            phone,
            mode === 'blocked',
            mode === 'paid' ? 'cakto' : mode === 'manual' ? 'manual' : null,
            mode === 'paid' || mode === 'manual',
          ]
        );
        expect(await repos[0]!.createNewContact(input)).toBeNull();
        expect((await row()).access_source).not.toBe('trial');
        expect((await clients[0]!.query('SELECT * FROM whatsapp_trial_claims')).rows).toHaveLength(
          0
        );
      }
    );
    it.each(['alias', 'history', 'owner', 'alternate', 'claimed'] as const)(
      'rejects a previously known %s identity',
      async (kind) => {
        if (kind === 'alias')
          await clients[0]!.query('INSERT INTO customer_phone_aliases VALUES($1,NOW())', [phone]);
        if (kind === 'history')
          await clients[0]!.query("INSERT INTO channel_messages VALUES('old','inbound',$1)", [
            phone,
          ]);
        if (kind === 'owner')
          await clients[0]!.query("INSERT INTO system_settings VALUES('owner_whatsapp',$1)", [
            phone,
          ]);
        if (kind === 'alternate')
          await clients[0]!
            .query(`INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id)
      VALUES('alternate','whatsapp:556799981234','whatsapp','556799981234')`);
        if (kind === 'claimed') {
          await repos[0]!.createNewContact(input);
          await clients[0]!.query('DELETE FROM channel_users');
        }
        await repos[0]!.createNewContact(input);
        expect(await row()).toMatchObject({
          is_verified: false,
          status: 'pending',
          access_source: null,
        });
      }
    );
    it('claims and begins only the due expiry, preserving normal access gating', async () => {
      await repos[0]!.createNewContact(input);
      await clients[0]!.query(
        "UPDATE channel_access_notifications SET status='delivered' WHERE kind='approved'"
      );
      const user = await row();
      const expiry = user.access_expires_at as Date;
      expect(await notices[0]!.claimDue(20, new Date(expiry.getTime() - 1))).toHaveLength(0);
      const [entry] = await notices[0]!.claimDue(20, expiry);
      expect(entry?.kind).toBe('trial_expired');
      expect(await notices[1]!.claimDue(20, expiry)).toHaveLength(0);
      expect(
        await notices[0]!.beginSend(
          entry!.id,
          entry!.leaseToken!,
          'channel.whatsapp',
          expiry,
          '5567999991111'
        )
      ).toBe(true);
      expect(
        await notices[1]!.beginSend(
          entry!.id,
          entry!.leaseToken!,
          'channel.whatsapp',
          expiry,
          '5567999991111'
        )
      ).toBe(false);
    });
    it('cancels a claimed trial expiry after a payment or administrative authorization', async () => {
      await repos[0]!.createNewContact(input);
      await clients[0]!.query(
        "UPDATE channel_access_notifications SET status='delivered' WHERE kind='approved'"
      );
      const user = await row();
      const [entry] = await notices[0]!.claimDue(20, user.access_expires_at);
      await clients[0]!.query(
        "UPDATE channel_users SET access_source='cakto',access_expires_at=NOW()+INTERVAL '30 days'"
      );
      expect(
        await notices[0]!.beginSend(
          entry!.id,
          entry!.leaseToken!,
          'channel.whatsapp',
          user.access_expires_at,
          '5567999991111'
        )
      ).toBe(false);
    });
    it('does not duplicate an expiry already answered through an incoming message', async () => {
      await repos[0]!.createNewContact(input);
      await clients[0]!.query(
        "UPDATE channel_access_notifications SET status='delivered' WHERE kind='approved'"
      );
      const user = await row();
      const [entry] = await notices[0]!.claimDue(20, user.access_expires_at);
      await clients[0]!.query(`UPDATE channel_users SET metadata=metadata || $1::jsonb`, [
        JSON.stringify({
          astraAccessNotices: { lastInactiveAt: user.access_expires_at.getTime() },
        }),
      ]);
      expect(
        await notices[0]!.beginSend(
          entry!.id,
          entry!.leaseToken!,
          'channel.whatsapp',
          user.access_expires_at,
          '5567999991111'
        )
      ).toBe(false);
    });
    it('allows the paid confirmation despite the previous trial welcome', async () => {
      await repos[0]!.createNewContact(input);
      await clients[0]!.query(`UPDATE channel_users SET access_source='cakto',
      access_expires_at=date_trunc('milliseconds',NOW())+INTERVAL '30 days',
      metadata='{"hasInteracted":true,"caktoManaged":true,"astraAccessNotices":{"firstAuthorized":true,"firstAuthorizedAsTrial":true}}'::jsonb`);
      const user = await row();
      await clients[0]!.query(
        `UPDATE channel_access_notifications n SET available_at=$1,
      access_expires_at=u.access_expires_at FROM channel_users u WHERE u.id=n.channel_user_id AND n.kind='approved'`,
        [user.access_granted_at]
      );
      const [entry] = await notices[0]!.claimDue(20, user.access_granted_at);
      expect(
        await notices[0]!.beginSend(
          entry!.id,
          entry!.leaseToken!,
          'channel.whatsapp',
          user.access_granted_at,
          '5567999991111'
        )
      ).toBe(true);
    });
    it('does not enqueue the paid 24-hour renewal offer for a trial', async () => {
      await repos[0]!.createNewContact(input);
      const user = await row();
      expect(
        await notices[0]!.queueExpiringWithin24Hours(
          new Date(user.access_expires_at.getTime() - 3600_000)
        )
      ).toBe(0);
    });
    it('upgrades legacy constraints twice while keeping old contacts ineligible', async () => {
      await clients[0]!
        .query(`ALTER TABLE channel_users DROP CONSTRAINT channel_users_access_source_check;
      ALTER TABLE channel_users ADD CONSTRAINT channel_users_access_source_check CHECK(access_source IN ('manual','cakto'));
      ALTER TABLE channel_access_notifications DROP CONSTRAINT channel_access_notifications_kind_check;
      ALTER TABLE channel_access_notifications ADD CONSTRAINT channel_access_notifications_kind_check CHECK(kind IN ('approved','renewed','expiring'));
      INSERT INTO channel_users(id,ownpilot_user_id,platform,platform_user_id,status) VALUES('old','whatsapp:${phone}','whatsapp','${phone}','pending')`);
      await clients[0]!.query(CHANNELS_MIGRATIONS_SQL);
      await clients[0]!.query(CHANNELS_MIGRATIONS_SQL);
      expect(await repos[0]!.createNewContact(input)).toBeNull();
      expect((await row()).is_verified).toBe(false);
      const newPhone = '5567999984321';
      expect(
        await repos[0]!.createNewContact({
          ...input,
          platformUserId: newPhone,
          ownpilotUserId: 'whatsapp:' + newPhone,
        })
      ).toBeTruthy();
    });
    it('rejects non-private and mismatched scopes without creating data', async () => {
      expect(await repos[0]!.createNewContact({ ...input, platform: 'telegram' })).toBeNull();
      expect(await repos[0]!.createNewContact({ ...input, ownpilotUserId: 'default' })).toBeNull();
      expect(
        await repos[0]!.createNewContact({ ...input, platformUserId: 'group@g.us' })
      ).toBeNull();
      expect(await row()).toBeUndefined();
    });
  }
);
