import { randomUUID } from 'node:crypto';
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

describe.skipIf(!process.env.ASTRA_REVIEW_PG_PORT)(
  'first-contact WhatsApp trials on PostgreSQL',
  () => {
    const schema = 'trial_' + randomUUID().replaceAll('-', '');
    const clients: Client[] = [];
    const repos: WhatsAppTrialsRepository[] = [];
    const notices: ChannelAccessNotificationsRepository[] = [];
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
      await clients[0]!.query(`CREATE TABLE conversations(id TEXT PRIMARY KEY);
      CREATE TABLE system_settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE customer_phone_aliases(phone_number TEXT PRIMARY KEY,retired_at TIMESTAMPTZ);
      CREATE TABLE channel_messages(id TEXT PRIMARY KEY,direction TEXT,sender_id TEXT)`);
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
      }
    });
    beforeEach(async () => {
      await clients[0]!.query(`TRUNCATE channel_users CASCADE;
    TRUNCATE whatsapp_trial_claims,system_settings,customer_phone_aliases,channel_messages`);
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
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        kind: 'trial_expired',
        duration_days: 3,
        available_at: user.access_expires_at,
      });
      expect(await repos[1]!.createNewContact(input)).toBeNull();
      expect((await row()).access_expires_at).toEqual(user.access_expires_at);
    });
    it('serializes simultaneous first messages across independent connections', async () => {
      const ids = await Promise.all(repos.map((r) => r.createNewContact(input)));
      expect(ids.filter(Boolean)).toHaveLength(1);
      expect(
        (await clients[0]!.query('SELECT * FROM channel_access_notifications')).rows
      ).toHaveLength(1);
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
        `UPDATE channel_access_notifications n SET kind='approved',available_at=$1,
      access_expires_at=u.access_expires_at FROM channel_users u WHERE u.id=n.channel_user_id`,
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
