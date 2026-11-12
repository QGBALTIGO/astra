import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { PostgresAdapter } from '../db/adapters/postgres-adapter.js';
import { CustomerAgendaRepository } from '../db/repositories/customer-agenda.js';
import { TasksRepository } from '../db/repositories/tasks.js';
import { PERSONAL_DATA_TABLES_SQL } from '../db/schema/personal-data.js';
import { CUSTOMER_PORTAL_TABLES_SQL } from '../db/schema/customer-portal.js';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';
import { tryPersonalTaskReply } from './personal-tasks.js';

const port = process.env.ASTRA_AUTH_TEST_PORT;
let db: PostgresAdapter;
vi.mock('../db/adapters/index.js', () => ({ getAdapter: () => db }));
vi.mock('../services/agent/service.js', () => ({
  getOrCreateChatAgent: () => {
    throw new Error('Unexpected model call');
  },
}));
type Platform = 'whatsapp' | 'telegram';
function message(
  user: string,
  text: string,
  id: string,
  platform: Platform = 'whatsapp'
): ChannelIncomingMessage {
  return {
    id,
    text,
    channelPluginId: 'channel.' + platform,
    platform,
    platformChatId: user,
    sender: { platform, platformUserId: user, displayName: 'Local' },
    timestamp: new Date(),
    metadata: platform === 'telegram' ? { chatType: 'private' } : { isGroup: false },
  };
}
const yes = async () => true;
function turn(m: ChannelIncomingMessage, user: string, bus: boolean, guard = yes) {
  return bus
    ? processViaBus(
        {
          process: () => {
            throw new Error('Unexpected model call');
          },
        } as never,
        m,
        { sessionId: 'isolated-' + user, conversationId: null },
        { ownpilotUserId: user },
        { sessionsRepo: {} as never, getChannel: () => undefined, isAccessAllowed: guard }
      )
    : processDirectAgent(m, user, guard);
}
const title = 'Pedir segunda via do boleto Limoeiro';
const phrases = [
  'Adiciona à minha lista de tarefas: ' + title + '.',
  'A tarefa ' + title + ' ficou pendente na minha lista?',
  'Já pedi a segunda via. Marca como concluída só a tarefa ' +
    title +
    ', se ela estiver na minha lista.',
  'Consulta a tarefa ' + title + '. Ela ainda está pendente, foi concluída ou não consta?',
];
describe.skipIf(!port)('personal task commands against disposable PostgreSQL', () => {
  const schema = 'lab_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    if (!/^\d+$/.test(port!) || +port! < 1024 || +port! > 65535)
      throw new Error('Expected an isolated loopback port');
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
  });
  afterAll(async () => {
    if (!db?.isConnected()) return;
    try {
      await db.exec('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await db.close();
    }
  });

  it.each(Array.from({ length: 500 }, (_, i) => i))(
    'adds, checks, completes and rechecks task for account %i',
    async (i) => {
      const user = 'account-' + i;
      const platform = i % 2 ? 'telegram' : 'whatsapp';
      const bus = i % 4 < 2;
      const send = (n: number) => turn(message(user, phrases[n]!, String(n), platform), user, bus);
      expect(await send(0)).toContain('Adicionei');
      expect(await send(1)).toContain('pendente');
      expect(await send(2)).toContain('Marquei como concluída');
      expect(await send(3)).toContain('está concluída');
      expect(await send(0)).toContain('já foi processada');
      const tasks = await new TasksRepository(user).list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ userId: user, title, status: 'completed' });
    }
  );
  it.each(['whatsapp', 'telegram'] as const)(
    'keeps a failed read informational on %s',
    async (platform) => {
      const failed = vi
        .spyOn(CustomerAgendaRepository.prototype, 'findChannelTask')
        .mockRejectedValue(new Error('timeout DSN_PRIVATE'));
      try {
        for (const path of [true, false]) {
          const answer = await turn(
            message('synthetic', 'Consulte a tarefa Regar', 'read', platform),
            'synthetic',
            path
          );
          expect(answer).toContain('lista de tarefas');
          expect(answer).not.toMatch(/confirmação|repetir|DSN_PRIVATE/i);
        }
      } finally {
        failed.mockRestore();
      }
    }
  );

  it('leaves both candidates intact and rejects a code belonging to another account', async () => {
    const owner = 'duplicate';
    const repo = new TasksRepository(owner);
    const [a, b] = await Promise.all([repo.create({ title }), repo.create({ title })]);
    const send = (user: string, text: string, id = randomUUID() as string) =>
      turn(message(user, text, id), user, true);
    expect(await send(owner, phrases[2]!)).toContain('#' + a.id);
    expect((await repo.get(b.id))?.status).toBe('pending');
    expect(await send('stranger', 'Conclua a tarefa #' + a.id)).toContain('não consta');
    expect(await send(owner, 'Conclua a tarefa #' + b.id)).toContain('Marquei');
    expect((await repo.get(a.id))?.status).toBe('pending');
  });
  it('deduplicates concurrent creates and protects a manually reopened task against replay', async () => {
    const user = 'replay';
    const create = message(user, phrases[0]!, 'c');
    const replies = await Promise.all([
      turn(create, user, false),
      turn(create, user, true),
      turn({ ...create, id: 'second-create' }, user, true),
    ]);
    expect(replies.filter((t) => t.includes('Adicionei'))).toHaveLength(1);
    const repo = new TasksRepository(user);
    const rows = await repo.list();
    expect(rows).toHaveLength(1);
    const complete = message(user, phrases[2]!, 'finish');
    expect(await turn(complete, user, true)).toContain('Marquei');
    await repo.update(rows[0]!.id, { status: 'pending' });
    expect(await turn(complete, user, false)).toContain('já foi processada');
    expect(await turn({ ...create, text: phrases[2]! }, user, true)).toContain('mudou');
    expect((await repo.get(rows[0]!.id))?.status).toBe('pending');
  });
  it('does not act on groups, revoked access or a conditional/compound request', async () => {
    const user = 'blocked';
    const input = message(user, phrases[0]!, 'one');
    expect(await turn({ ...input, metadata: { isGroup: true } }, user, false)).toContain('privada');
    expect(await turn({ ...input, platformChatId: 'another' }, user, true)).toContain('privada');
    expect(await turn(input, user, true, async () => false)).toContain('inativo');
    expect(
      await turn(input, user, false, vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false))
    ).toContain('inativo');
    for (const text of [
      'Conclua a tarefa Cobrar se o cliente pagar',
      'Crie a tarefa Orçamento e pague a fatura',
      'Crie a tarefa',
    ]) {
      expect(await turn({ ...input, text }, user, true)).toContain('Informe o título');
    }
    for (const text of [
      'Crie a tarefa Comprar pão amanhã às 10',
      'Crie a tarefa Refrigerante às 9',
      'Crie a tarefa Buscar o boleto na segunda-feira',
    ]) {
      expect(await tryPersonalTaskReply({ ...input, text }, user, yes)).toBeNull();
    }
    expect(await new TasksRepository(user).list()).toEqual([]);
  });
  it('honors the panel task reminder, rolls back a sending conflict and retries safely', async () => {
    const user = 'linked';
    const repo = new CustomerAgendaRepository(user, 'UTC');
    const task = await repo.create(
      { kind: 'task', title, reminderAt: '2090-01-01T12:00:00.000Z' },
      { pluginId: 'channel.whatsapp', phoneNumber: user },
      'form'
    );
    const reminder = (await db.queryOne<{ id: string }>(
      'SELECT id FROM channel_reminders WHERE user_id=$1',
      [user]
    ))!;
    await db.execute("UPDATE channel_reminders SET status='sending' WHERE id=$1", [reminder.id]);
    const m = message(user, phrases[2]!, 'finish');
    expect(await turn(m, user, false)).toContain('sendo enviado');
    const tasks = new TasksRepository(user);
    expect((await tasks.get(task.id))?.status).toBe('pending');
    await db.execute("UPDATE channel_reminders SET status='pending' WHERE id=$1", [reminder.id]);
    expect(await turn(m, user, true)).toContain('Marquei');
    expect(
      await db.queryOne('SELECT status FROM channel_reminders WHERE id=$1', [reminder.id])
    ).toEqual({ status: 'cancelled' });
    expect((await tasks.get(task.id))?.reminderAt).toBeUndefined();
  });
});
