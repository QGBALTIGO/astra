import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { PostgresAdapter } from '../db/adapters/postgres-adapter.js';
import { CustomerAgendaRepository } from '../db/repositories/customer-agenda.js';
import { createCalendarRepository } from '../db/repositories/calendar.js';
import { CUSTOMER_PORTAL_TABLES_SQL } from '../db/schema/customer-portal.js';
import { CUSTOMER_ACCOUNTS_TABLES_SQL } from '../db/schema/customer-accounts.js';
import { PERSONAL_DATA_TABLES_SQL } from '../db/schema/personal-data.js';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';
import { tryChannelCalendarMutation } from './calendar-mutation.js';

const port = process.env.ASTRA_AUTH_TEST_PORT;
let db: PostgresAdapter;
vi.mock('../db/adapters/index.js', () => ({ getAdapter: () => db }));
vi.mock('../services/agent/service.js', () => ({
  isDemoMode: () => {
    throw Error('Unexpected model boundary');
  },
  getOrCreateChatAgent: () => {
    throw Error('Unexpected model boundary');
  },
}));
const literal =
  'Marca na minha agenda para amanhã, sexta-feira, 13 de novembro, das 15h às 15h30 de Cuiabá: Revisão do orçamento Limoeiro.';
function incoming(
  actor: string,
  platform: 'whatsapp' | 'telegram' = 'whatsapp'
): ChannelIncomingMessage {
  return {
    id: randomUUID(),
    platform,
    channelPluginId: 'channel.' + platform,
    platformChatId: actor,
    sender: { platform, platformUserId: actor, displayName: 'Teste privado' },
    timestamp: new Date('2026-11-12T12:00:00Z'),
    text: literal,
    metadata: { isGroup: false, chatType: 'private' },
  };
}
const allowed = async () => true;
function turn(msg: ChannelIncomingMessage, actor: string, direct: boolean, guard = allowed) {
  if (direct) return processDirectAgent(msg, actor, guard);
  return processViaBus(
    {
      process() {
        throw Error('Unexpected model boundary');
      },
    } as never,
    msg,
    { sessionId: 'lab', conversationId: null },
    { ownpilotUserId: actor },
    { sessionsRepo: {} as never, getChannel: () => undefined, isAccessAllowed: guard }
  );
}
async function count(user: string) {
  return (await db.queryOne<{ n: number }>(
    'SELECT count(*)::int AS n FROM calendar_events WHERE user_id=$1',
    [user]
  ))!.n;
}

describe.skipIf(!port)(
  'natural personal calendar through both gateway entries and PostgreSQL',
  () => {
    const schema = 'cal_' + randomUUID().replaceAll('-', '');
    beforeAll(async () => {
      if (!/^\d+$/.test(port!) || +port! < 1024 || +port! > 65535)
        throw Error('Expected a disposable local PostgreSQL port');
      db = new PostgresAdapter({
        type: 'postgres',
        postgresUrl:
          'postgresql://astra_auth_lab@127.0.0.1:' +
          port +
          '/astra_auth_verification_lab?options=-c%20search_path%3D' +
          schema,
      });
      await db.initialize();
      await db.exec('CREATE SCHEMA ' + schema);
      await db.exec(PERSONAL_DATA_TABLES_SQL);
      await db.exec(CUSTOMER_PORTAL_TABLES_SQL);
      await db.exec('CREATE TABLE channel_users (id TEXT PRIMARY KEY)');
      await db.exec(CUSTOMER_ACCOUNTS_TABLES_SQL);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    });
    afterAll(async () => {
      vi.useRealTimers();
      if (db?.isConnected()) {
        try {
          await db.exec('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
        } finally {
          await db.close();
        }
      }
    });
    it.each(['whatsapp', 'telegram'] as const)(
      'saves once across direct and bus for %s and reads actual updated/deleted state on replay',
      async (platform) => {
        const user = platform + '-principal',
          msg = incoming(user, platform);
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) => turn(msg, user, i % 2 === 0))
        );
        expect(results.filter((t) => t.includes('Compromisso agendado'))).toHaveLength(1);
        expect(results.filter((t) => t.includes('já registrado'))).toHaveLength(11);
        for (const text of results) {
          expect(text).toContain('Revisão do orçamento Limoeiro');
          expect(text).toContain('13/11/2026, 15:00');
          expect(text).toContain('13/11/2026, 15:30');
          expect(text).toContain('America/Cuiaba');
        }
        expect(await count(user)).toBe(1);
        const dbRow = await db.queryOne<{
          id: string;
          zone: string;
          start: string;
          end: string;
          source: string;
        }>(
          "SELECT id, timezone AS zone, to_char(start_time,'YYYY-MM-DD HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end, external_source AS source FROM calendar_events WHERE user_id=$1",
          [user]
        );
        expect(dbRow).toMatchObject({
          zone: 'America/Cuiaba',
          start: '2026-11-13 19:00',
          end: '19:30',
          source: platform,
        });
        expect(
          await turn({ ...msg, text: literal.replace('Limoeiro', 'Floresta') }, user, false)
        ).toContain('outro agendamento');
        expect(await count(user)).toBe(1);
        const repo = createCalendarRepository(user);
        await repo.update(dbRow!.id, { title: 'Título atualizado' });
        expect(await turn(msg, user, true)).toContain('Título atualizado');
        await repo.delete(dbRow!.id);
        expect(await turn(msg, user, false)).toContain('excluído');
        expect(await count(user)).toBe(0);
      }
    );
    it('rechecks access after entering the DB transaction and isolates same delivery IDs by owner', async () => {
      const a = 'isolado-a',
        b = 'isolado-b',
        first = incoming(a);
      expect(
        await turn(first, a, true, vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false))
      ).toMatch(/inativo/);
      expect(await count(a)).toBe(0);
      const second = {
        ...incoming(b),
        id: first.id,
        text: literal.replace('Limoeiro', 'Floresta'),
      };
      await Promise.all([turn(first, a, false), turn(second, b, true)]);
      const rows = await db.query<{ id: string; title: string }>(
        'SELECT user_id AS id, title FROM calendar_events WHERE user_id IN ($1,$2) ORDER BY user_id',
        [a, b]
      );
      expect(rows.map((r) => [r.id, r.title])).toEqual([
        [a, 'Revisão do orçamento Limoeiro'],
        [b, 'Revisão do orçamento Floresta'],
      ]);
    });
    it('never writes for a group, missing stable key, conflict, question or negative', async () => {
      const user = 'negações',
        msg = incoming(user, 'telegram');
      const inputs = [
        { ...msg, metadata: { isGroup: true, chatType: 'group' } },
        { ...msg, platformChatId: '-123' },
        { ...msg, metadata: {} },
        { ...msg, id: '' },
        { ...msg, text: 'Se eu disser "' + literal + '", você faria isso?' },
        { ...msg, text: 'Não ' + literal },
        { ...msg, text: literal + '?' },
        { ...msg, text: literal.replace('sexta', 'sábado') },
      ];
      for (const input of inputs)
        expect(await turn(input, user, true)).not.toMatch(/Compromisso agendado/);
      expect(await count(user)).toBe(0);
      const photo = {
        ...msg,
        attachments: [{ type: 'image', url: 'urn:synthetic', mimeType: 'image/png' }],
      } as ChannelIncomingMessage;
      expect(await tryChannelCalendarMutation(photo, user, allowed)).toBeNull();
    });
    const acacia = 'Revisão do orçamento Acácia';
    const moveText =
      'Preciso mudar a Revisão do orçamento Acácia de sexta para 16h, mantendo meia hora. Se encontrar esse evento, remarca o mesmo; se não encontrar, me avisa.';
    const lookupText =
      'Confere na minha agenda se a Revisão do orçamento Acácia ficou marcada para sexta. Qual a data e que horas ela começa e termina?';
    it.each(['whatsapp', 'telegram'] as const)(
      'runs the complete R19 lifecycle on %s without a model or reminder',
      async (platform) => {
        const user = 'r19-' + platform,
          msg = incoming(user, platform),
          repo = createCalendarRepository(user);
        await db.execute('INSERT INTO channel_users(id) VALUES($1)', [user]);
        await db.execute(
          'INSERT INTO customer_accounts(id,channel_user_id,data_user_id,current_phone,time_zone) VALUES($1,$1,$1,$2,$3)',
          [user, platform === 'whatsapp' ? '5511000000001' : '5511000000002', 'America/Cuiaba']
        );
        const create = { ...msg, text: literal.replace('Limoeiro', 'Acácia') };
        const move = { ...msg, id: randomUUID(), text: moveText };
        const ask = { ...msg, id: randomUUID(), text: lookupText };
        expect(await turn(create, user, true)).toContain('Compromisso agendado');
        const [created] = await repo.list();
        expect(await turn(ask, user, false)).toContain('15:00');
        const replies = await Promise.all(
          Array.from({ length: 8 }, (_, i) => turn(move, user, i % 2 === 0))
        );
        expect(replies.filter((t) => t.includes('Compromisso remarcado'))).toHaveLength(1);
        for (const t of replies) {
          expect(t).toContain('16:00');
          expect(t).toContain('16:30');
          expect(t).toContain('America/Cuiaba');
        }
        const [updated] = await repo.list();
        expect(updated!.id).toBe(created!.id);
        expect(updated!.title).toBe(acacia);
        expect(new Date(updated!.startTime).toISOString()).toBe('2026-11-13T20:00:00.000Z');
        expect(new Date(updated!.endTime!).toISOString()).toBe('2026-11-13T20:30:00.000Z');
        const afterMove = await turn(ask, user, true);
        expect(afterMove).toContain('16:00');
        expect(afterMove).toContain('16:30');
        expect(await turn(move, user, false)).toContain('Horário atual');
        expect(await count(user)).toBe(1);
        expect(
          await turn(
            {
              ...msg,
              id: randomUUID(),
              text:
                'Exclua da minha agenda o compromisso de 13/11/2026 no fuso de Cuiabá: ' +
                acacia +
                '.',
            },
            user,
            true
          )
        ).toContain('excluído');
        expect(await turn(ask, user, false)).toContain('Não encontrei');
        expect(await turn(move, user, true)).toContain('excluído');
        const missing = { ...move, id: randomUUID() };
        expect(await turn(missing, user, false)).toContain('Não encontrei');
        expect(await count(user)).toBe(0);
        await turn({ ...create, id: randomUUID() }, user, true);
        expect(await turn(missing, user, true)).toContain('Não encontrei');
        expect(await turn(move, user, false)).toContain('excluído');
        expect(await turn(ask, user, true)).toContain('15:00');
        const reminders = await db.queryOne<{ n: number }>(
          'SELECT count(*)::int AS n FROM channel_reminders WHERE user_id=$1',
          [user]
        );
        expect(reminders!.n).toBe(0);
      }
    );
    it('refuses homonyms, group requests, revoked writes, incorrect durations and cross-owner lookups', async () => {
      const user = 'r19-escopo',
        other = 'r19-estrangeiro',
        msg = incoming(user, 'telegram'),
        repo = createCalendarRepository(user);
      const fixture = {
        title: acacia,
        startTime: '2026-11-13T19:00:00Z',
        endTime: '2026-11-13T19:30:00Z',
        timezone: 'America/Cuiaba',
      };
      await createCalendarRepository(other).create(fixture);
      const send = (text: string, overrides: Partial<ChannelIncomingMessage> = {}) =>
        turn({ ...msg, id: randomUUID(), text, ...overrides }, user, true);
      expect(await send(moveText)).toContain('Não encontrei');
      const a = await repo.create(fixture);
      const b = await repo.create({ ...fixture, title: 'a ' + acacia });
      const ambiguous = { ...msg, id: randomUUID(), text: moveText };
      expect(await turn(ambiguous, user, false)).toContain('mais de um');
      await repo.delete(b.id);
      expect(await turn(ambiguous, user, true)).toContain('mais de um');
      expect(await send(moveText, { metadata: { isGroup: true, chatType: 'group' } })).toContain(
        'privada'
      );
      expect(await send(moveText, { platformChatId: 'foreign' })).toContain('privada');
      expect(await send(moveText.replace('meia hora', '45 minutos'))).toContain(
        'duração cadastrada é diferente'
      );
      expect(
        await tryChannelCalendarMutation(
          { ...msg, text: moveText },
          user,
          vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
        )
      ).toContain('inativo');
      expect(new Date((await repo.get(a.id))!.startTime).toISOString()).toBe(
        '2026-11-13T19:00:00.000Z'
      );
      expect(await send(moveText.replace('16h', '16h de Brasília'))).toContain('15:00');
      const moved = { ...msg, id: randomUUID(), text: moveText };
      expect(await turn(moved, user, false)).toContain('16:00');
      expect(await turn({ ...moved, text: moveText.replace('16h', '17h') }, user, true)).toContain(
        'outro agendamento'
      );
      expect(
        new Date((await createCalendarRepository(other).list())[0]!.startTime).toISOString()
      ).toBe('2026-11-13T19:00:00.000Z');
    });
    it('preserves a linked reminder and rejects a move that would place it after the appointment', async () => {
      const user = 'r19-aviso',
        msg = incoming(user);
      const item = await new CustomerAgendaRepository(user, 'America/Cuiaba').create(
        {
          kind: 'event',
          title: acacia,
          startAt: '2026-11-13T19:00:00Z',
          endAt: '2026-11-13T19:30:00Z',
          reminderAt: '2026-11-13T18:45:00Z',
        },
        { pluginId: 'channel.whatsapp', phoneNumber: user },
        'portal'
      );
      const reminders = () =>
        db.query('SELECT id,status,remind_at FROM channel_reminders WHERE user_id=$1', [user]);
      const before = await reminders();
      expect(before).toHaveLength(1);
      expect(await turn({ ...msg, text: moveText }, user, false)).toContain('16:00');
      expect(await reminders()).toEqual(before);
      expect(
        await turn({ ...msg, id: randomUUID(), text: moveText.replace('16h', '14h') }, user, true)
      ).toContain('aviso vinculado');
      expect(
        new Date((await createCalendarRepository(user).get(item.id))!.startTime).toISOString()
      ).toBe('2026-11-13T20:00:00.000Z');
      expect(await reminders()).toEqual(before);
    });
    it('replays the original receipt across a reconstructed timestamp and never resolves a fresh relative day without one', async () => {
      const user = 'r19-tempo',
        msg = { ...incoming(user), text: moveText },
        repo = createCalendarRepository(user);
      const fixture = {
        title: acacia,
        startTime: '2026-11-13T19:00:00Z',
        endTime: '2026-11-13T19:30:00Z',
        timezone: 'America/Cuiaba',
      };
      const original = await repo.create(fixture);
      const fallback = { ...msg, metadata: { ...msg.metadata, estimatedTimestamp: true } };
      expect(await turn(fallback, user, true)).toContain('Qual é a data');
      expect(await turn(msg, user, false)).toContain('Compromisso remarcado');
      const otherWeek = await repo.create({
        ...fixture,
        startTime: '2026-11-20T19:00:00Z',
        endTime: '2026-11-20T19:30:00Z',
      });
      vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
      try {
        const later = { ...msg, timestamp: new Date() };
        for (const m of [later, { ...fallback, timestamp: new Date() }])
          expect(await turn(m, user, true)).toContain('13/11/2026, 16:00');
        expect(
          await turn({ ...later, text: moveText.replace('16h', '17h') }, user, true)
        ).toContain('outro agendamento');
        expect(new Date((await repo.get(otherWeek.id))!.startTime).toISOString()).toBe(
          '2026-11-20T19:00:00.000Z'
        );
        const fullDate = {
          ...fallback,
          id: randomUUID(),
          timestamp: new Date(),
          text: moveText.replace('sexta', '20/11/2026'),
        };
        expect(await turn(fullDate, user, false)).toContain('20/11/2026, 16:00');
      } finally {
        vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
      }
      expect(new Date((await repo.get(original.id))!.startTime).toISOString()).toBe(
        '2026-11-13T20:00:00.000Z'
      );
    });
    it('rolls back the move itself when the receipt cannot be persisted', async () => {
      const user = 'r19-rollback',
        msg = { ...incoming(user), text: moveText },
        repo = createCalendarRepository(user);
      const row = await repo.create({
        title: acacia,
        startTime: '2026-11-13T19:00:00Z',
        endTime: '2026-11-13T19:30:00Z',
        timezone: 'America/Cuiaba',
      });
      await db.exec(
        "CREATE FUNCTION r19_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER r19_fail BEFORE INSERT ON customer_agenda_requests FOR EACH ROW WHEN (NEW.user_id='r19-rollback') EXECUTE FUNCTION r19_fail()"
      );
      try {
        expect(await turn(msg, user, true)).toContain('confirmação desse compromisso');
        expect(new Date((await repo.get(row.id))!.startTime).toISOString()).toBe(
          '2026-11-13T19:00:00.000Z'
        );
      } finally {
        await db.exec('DROP TRIGGER r19_fail ON customer_agenda_requests');
      }
      expect(await turn(msg, user, false)).toContain('Compromisso remarcado');
      expect(await count(user)).toBe(1);
    });
    it('resolves civil dates in the saved time zone across midnight and honors DST ambiguity', async () => {
      const user = 'r19-fuso',
        msg = incoming(user),
        repo = createCalendarRepository(user);
      const early = await repo.create({
        title: acacia,
        startTime: '2026-11-13T04:10:00Z',
        endTime: '2026-11-13T04:40:00Z',
        timezone: 'America/Cuiaba',
      });
      expect(await turn({ ...msg, text: moveText }, user, true)).toContain('16:30');
      await repo.delete(early.id);
      const dst = await repo.create({
        title: acacia,
        startTime: '2026-11-01T18:00:00Z',
        endTime: '2026-11-01T18:30:00Z',
        timezone: 'America/New_York',
      });
      expect(
        await turn(
          { ...msg, id: randomUUID(), text: 'Remarque a ' + acacia + ' de 01/11/2026 para 01h30.' },
          user,
          false
        )
      ).toContain('ambíguo');
      expect(new Date((await repo.get(dst.id))!.startTime).toISOString()).toBe(
        '2026-11-01T18:00:00.000Z'
      );
    });
    it('deletes exactly one saved title/day and never deletes a replacement on redelivery', async () => {
      const a = 'remoção',
        b = 'outro',
        msg = incoming(a),
        other = incoming(b);
      const title = 'Revisão do orçamento Limoeiro';
      const del = {
        ...msg,
        id: randomUUID(),
        text:
          'Exclua da minha agenda o compromisso de 13/11/2026 no fuso de Cuiabá: ' + title + '.',
      };
      await turn(msg, a, true);
      await turn(other, b, false);
      const fresh = await Promise.all(
        Array.from({ length: 8 }, () => tryChannelCalendarMutation(del, a, allowed))
      );
      expect(fresh.filter((t) => t?.includes('Compromisso excluído'))).toHaveLength(1);
      expect(
        fresh.filter((t) => t?.includes('exclusão pedida nesta mensagem já foi registrada'))
      ).toHaveLength(7);
      expect(await count(a)).toBe(0);
      expect(await count(b)).toBe(1);
      await turn({ ...msg, id: randomUUID() }, a, false);
      expect(await turn(del, a, false)).toContain('já foi registrada');
      expect(await count(a)).toBe(1);
      expect(await turn({ ...del, id: msg.id }, a, false)).toContain('mensagem já foi usada');
      expect(await count(a)).toBe(1);
    });
    it('never broadens missing or ambiguous matches and retains their outcomes across replay', async () => {
      const a = 'homônimos',
        msg = incoming(a, 'telegram'),
        title = 'Revisão do orçamento Limoeiro';
      const del = {
        ...msg,
        id: randomUUID(),
        text:
          'Exclua da minha agenda o compromisso de 13/11/2026 no fuso de Cuiabá: ' + title + '.',
      };
      expect(await turn(del, a, true)).toContain('Não encontrei');
      await turn(msg, a, false);
      expect(await turn(del, a, false)).toContain('Não encontrei');
      await turn({ ...msg, id: randomUUID() }, a, true);
      const ambiguous = { ...del, id: randomUUID() };
      expect(await turn(ambiguous, a, true)).toContain('mais de um');
      const [row] = await createCalendarRepository(a).list();
      await createCalendarRepository(a).delete(row!.id);
      expect(await turn(ambiguous, a, false)).toContain('mais de um');
      for (const changes of [
        { text: del.text.replace('13/11', '14/11') },
        { text: del.text.replace(title, 'Revisão') },
        { text: del.text + '?' },
        { text: 'Não ' + del.text },
        { text: 'Se eu disser ' + del.text + ', o que acontece?' },
        { metadata: { chatType: 'group', isGroup: true } },
        { platformChatId: '-123' },
      ]) {
        expect(await turn({ ...del, id: randomUUID(), ...changes }, a, true)).not.toContain(
          'Compromisso excluído'
        );
      }
      expect(await count(a)).toBe(1);
    });
    it('rechecks the title after a concurrent owner edit and preserves portal-linked reminder handling', async () => {
      const a = 'concorrência',
        msg = incoming(a),
        title = 'Revisão do orçamento Limoeiro';
      await turn(msg, a, true);
      const [saved] = await createCalendarRepository(a).list();
      const del = {
        ...msg,
        id: randomUUID(),
        text:
          'Exclua da minha agenda o compromisso de 13/11/2026 no fuso de Cuiabá: ' + title + '.',
      };
      let locked!: () => void, release!: () => void;
      const waiting = new Promise<void>((r) => {
        locked = r;
      });
      const done = new Promise<void>((r) => {
        release = r;
      });
      const edit = db.transaction(async () => {
        await db.execute('UPDATE calendar_events SET title=$1 WHERE id=$2', [
          'Outro nome',
          saved!.id,
        ]);
        locked();
        await done;
      });
      await waiting;
      const remove = turn(del, a, false);
      try {
        let blocked = false;
        for (let n = 0; n < 120 && !blocked; n++) {
          const row = await db.queryOne<{ blocked: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM calendar_events%' AND query LIKE '%FOR UPDATE%') AS blocked"
          );
          blocked = row!.blocked;
          if (!blocked) await new Promise((r) => setTimeout(r, 15));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
        await edit;
      }
      expect(await remove).toContain('Não encontrei');
      expect(await count(a)).toBe(1);
      const repo = new CustomerAgendaRepository(a, 'America/Cuiaba');
      const item = await repo.create(
        {
          kind: 'event',
          title,
          startAt: '2026-11-13T19:00:00Z',
          endAt: '2026-11-13T19:30:00Z',
          reminderAt: '2026-11-13T18:30:00Z',
        },
        { pluginId: 'channel.whatsapp', phoneNumber: a },
        'portal-fixture'
      );
      const reminderId = (await db.queryOne<{ id: string }>(
        'SELECT reminder_id AS id FROM customer_agenda_links WHERE user_id=$1 AND item_id=$2',
        [a, item.id]
      ))!.id;
      expect(await turn({ ...del, id: randomUUID() }, a, false)).toContain('Compromisso excluído');
      expect(
        (
          await db.queryOne<{ status: string }>(
            'SELECT status FROM channel_reminders WHERE user_id=$1 AND id=$2',
            [a, reminderId]
          )
        )?.status
      ).toBe('cancelled');
      expect(await count(a)).toBe(1);
    });
    it('serializes independent connections, rolls back failed ledger inserts, and never backfills an expired appointment', async () => {
      const user = 'contencao',
        msg = incoming(user);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => tryChannelCalendarMutation(msg, user, allowed))
      );
      expect(results.filter((t) => t?.includes('Compromisso agendado'))).toHaveLength(1);
      expect(await count(user)).toBe(1);
      await db.exec(
        "CREATE FUNCTION fail_calendar_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$"
      );
      await db.exec(
        'CREATE TRIGGER fail_calendar_receipt BEFORE INSERT ON customer_agenda_requests FOR EACH ROW EXECUTE FUNCTION fail_calendar_receipt()'
      );
      const another = { ...msg, id: randomUUID() };
      try {
        expect(await turn(another, user, false)).toContain('confirmação desse compromisso');
        expect(await count(user)).toBe(1);
      } finally {
        await db.exec('DROP TRIGGER fail_calendar_receipt ON customer_agenda_requests');
      }
      expect(await turn(another, user, true)).toContain('Compromisso agendado');
      expect(await count(user)).toBe(2);
      const late = {
        ...msg,
        id: randomUUID(),
        text: literal.replace('amanhã, sexta-feira, 13 de novembro', '01/01/2025'),
      };
      expect(await turn(late, user, true)).toContain('já passou');
      expect(await count(user)).toBe(2);
    });
  }
);
