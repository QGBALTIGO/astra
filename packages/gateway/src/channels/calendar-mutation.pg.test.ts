import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { PostgresAdapter } from '../db/adapters/postgres-adapter.js';
import { CustomerAgendaRepository } from '../db/repositories/customer-agenda.js';
import { createCalendarRepository } from '../db/repositories/calendar.js';
import { CUSTOMER_PORTAL_TABLES_SQL } from '../db/schema/customer-portal.js';
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
        expect(await turn(another, user, false)).toContain('Não consegui confirmar');
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
