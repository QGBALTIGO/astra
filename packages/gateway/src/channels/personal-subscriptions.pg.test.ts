import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { PostgresAdapter } from '../db/adapters/postgres-adapter.js';
import { CustomerPlanningRepository } from '../db/repositories/customer-planning.js';
import { CUSTOMER_PORTAL_TABLES_SQL } from '../db/schema/customer-portal.js';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';
import { tryPersonalSubscriptionReply } from './personal-subscriptions.js';

// The same fixed loopback-only test role and database used by the verification suite.
const port = process.env.ASTRA_AUTH_TEST_PORT;
let db: PostgresAdapter;
vi.mock('../db/adapters/index.js', () => ({ getAdapter: () => db }));
vi.mock('../services/agent/service.js', () => ({
  getOrCreateChatAgent: () => {
    throw new Error('Unexpected LLM call');
  },
}));

type Platform = 'whatsapp' | 'telegram';
function incoming(
  text: string,
  platform: Platform,
  sender: string,
  id = randomUUID() as string
): ChannelIncomingMessage {
  return {
    id,
    text,
    platform,
    channelPluginId: 'channel.' + platform,
    platformChatId: sender,
    sender: { platform, platformUserId: sender, displayName: 'Teste local' },
    timestamp: new Date('2026-11-12T12:00:00Z'),
    metadata: platform === 'telegram' ? { chatType: 'private' } : { isGroup: false },
  };
}
function turn(message: ChannelIncomingMessage, userId: string, direct = true, active = true) {
  const guard = async () => active;
  if (direct) return processDirectAgent(message, userId, guard);
  const bus = {
    process: () => {
      throw new Error('Unexpected LLM call');
    },
  };
  return processViaBus(
    bus as never,
    message,
    { sessionId: 'lab', conversationId: null },
    { ownpilotUserId: userId },
    {
      sessionsRepo: {} as never,
      getChannel: () => undefined,
      isAccessAllowed: guard,
    }
  );
}

describe.skipIf(!port)(
  'personal subscriptions through the messaging entrypoints + PostgreSQL',
  () => {
    const schema = 'lab_' + randomUUID().replaceAll('-', '');
    beforeAll(async () => {
      if (!/^\d+$/.test(port!) || +port! < 1024 || +port! > 65535)
        throw new Error('Expected a disposable loopback PostgreSQL port');
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
      await db.exec('CREATE TABLE channel_reminders(id text PRIMARY KEY)');
      await db.exec(CUSTOMER_PORTAL_TABLES_SQL);
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

    it.each(['whatsapp', 'telegram'] as const)(
      'handles monthly subscription requests as spoken in the %s conversation',
      async (platform) => {
        const key = 'planejamento-' + platform;
        const repo = new CustomerPlanningRepository(key);
        const msg = (text: string) => incoming(text, platform, key);
        expect(
          await turn(
            msg(
              'Para o Astra me avisar um dia antes de uma assinatura vencer, basta eu cadastrar a data de renovação ou preciso pedir um lembrete separado? Só quero entender como funciona.'
            ),
            key,
            false
          )
        ).toContain('Peça um lembrete separado');
        expect(await repo.list()).toEqual([]);
        const create = msg(
          'Coloca a Revista Limoeiro nas minhas assinaturas: R$ 19,90 por mês, próxima renovação dia 20 de novembro de 2026. Ainda não paguei nada. Quero acompanhar no meu planejamento.'
        );
        expect(await turn(create, key)).toContain('adicionada');
        expect(await turn(create, key, false)).toContain('já foi processada');
        expect(await repo.list()).toMatchObject([
          {
            title: 'Revista Limoeiro',
            kind: 'subscription',
            amount: 19.9,
            nextDueDate: '2026-11-20',
          },
        ]);
        const result = await turn(
          msg(
            'Qual valor mensal e qual próxima renovação aparecem em Assinaturas para a Revista Limoeiro? Consulta meu planejamento pra conferir.'
          ),
          key,
          false
        );
        expect(result).toContain('19,90');
        expect(result).toContain('20/11/2026');
        expect(
          await turn(msg('Muda o valor da assinatura Revista Limoeiro para R$ 21,90'), key)
        ).toContain('atualizada');
        expect(
          await turn(
            msg(
              'Quanto eu pago por mês na minha assinatura da Revista Limoeiro e quando ela renova?'
            ),
            key
          )
        ).toContain('21,90');
        expect(
          await turn(
            msg(
              'Remova do meu planejamento só a assinatura Revista Limoeiro, se ela estiver cadastrada. Não cancele nada no fornecedor.'
            ),
            key
          )
        ).toContain('Removi Revista Limoeiro');
        expect(await repo.list()).toEqual([]);
      }
    );

    it('requires an explicit single tracking request and a valid renewal date', async () => {
      const key = 'planejamento-sem-efeito';
      const msg = (text: string) => incoming(text, 'whatsapp', key);
      const prefix = 'Coloca o Jornal nas minhas assinaturas: R$ 15 por mês, renovação em ';
      for (const text of [prefix + '31 de fevereiro de 2026', prefix + '20 de novembo de 2026']) {
        expect(await turn(msg(text), key)).toContain('Para acompanhar');
      }
      for (const text of [
        'Se eu disser “' + prefix + '20/11/2026”, o que acontece?',
        'Não ' + prefix + '20/11/2026.',
        prefix + '20/11/2026. Pague agora.',
        'Remova do meu planejamento só a assinatura Jornal e cancele no fornecedor?',
      ]) {
        expect(await tryPersonalSubscriptionReply(msg(text), key, async () => true)).toBeNull();
      }
      expect(await new CustomerPlanningRepository(key).list()).toEqual([]);
    });

    it('clarifies same-name legacy subscriptions; an explicit code changes only that owner and kind', async () => {
      const repo = new CustomerPlanningRepository('legacy');
      const input = {
        kind: 'subscription' as const,
        title: 'Música',
        amount: 9.5,
        notes: 'plano familiar',
        nextDueDate: '2027-01-31',
      };
      const [a, b, goal] = await Promise.all([
        repo.create(input),
        repo.create({ ...input, title: 'Musica' }),
        repo.create({ ...input, kind: 'goal' }),
      ]);
      const send = (text: string, user = 'legacy') => turn(incoming(text, 'telegram', user), user);
      expect(await send('Cancele a assinatura música')).toContain('várias assinaturas');
      expect(await send('Minhas assinaturas')).toContain('#' + b.id);
      expect(await send('Remova a assinatura #' + a.id, 'other')).toContain('Não encontrei');
      expect(await send('Remova a assinatura #' + goal.id)).toContain('Não encontrei');
      expect(await send('Atualize a assinatura #' + a.id + ' para R$ 15,25')).toContain('15,25');
      expect(await repo.get(a.id)).toMatchObject({
        amount: 15.25,
        notes: 'plano familiar',
        nextDueDate: '2027-01-31',
      });
      expect(await send('Remova a assinatura #' + a.id)).toContain('Removi');
      expect(await repo.get(a.id)).toBeNull();
      expect(await repo.get(b.id)).toMatchObject({ amount: 9.5 });
      expect(await repo.get(goal.id)).not.toBeNull();
    });

    it('rejects groups, revoked access, invalid fields and mixed instructions', async () => {
      const key = 'guard';
      const create = incoming(
        'Cadastre a assinatura Música por R$ 29,90 em 12/12/2026',
        'whatsapp',
        key
      );
      expect(await turn(create, key, false, false)).toContain('inativo');
      const revoked = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
      expect(await processDirectAgent(create, key, revoked)).toContain('inativo');
      expect(
        await db.queryOne(
          'SELECT count(*)::int AS n FROM customer_subscription_requests WHERE user_id=$1',
          [key]
        )
      ).toEqual({ n: 0 });
      expect(await turn({ ...create, metadata: { isGroup: true } }, key)).toContain('privada');
      const tg = incoming('Minhas assinaturas', 'telegram', key);
      expect(await turn({ ...tg, metadata: { chatType: 'group' } }, key)).toContain('privada');
      expect(await turn({ ...tg, platformChatId: 'other' }, key)).toContain('privada');
      for (const text of [
        'Cadastre a assinatura Música por R$ 0 em 12/12/2026',
        'Cadastre a assinatura Música por R$ 99,999 em 12/12/2026',
        'Cadastre a assinatura Música por R$ 29,90 em 31/02/2026',
        'Cadastre a assinatura Música por R$ 29,90',
        'Atualize a assinatura Música para R$ 49,90 com renovação em',
        'Atualize a assinatura Música para 12/12/2026 e novo valor de',
        'Cadastre a assinatura Música por R$ 29,90 em 12/12/2026 e pague agora',
        'Atualize a assinatura Música para R$ 13 ou R$ 15',
        'Cadastre a assinatura Música por US$ 12 em 12/12/2026',
        'Remova a assinatura',
      ]) {
        expect(await turn({ ...create, text }, key), text).toContain('Para acompanhar');
      }
      for (const text of [
        'Paguei R$ 40 na assinatura',
        'Me lembre de renovar a assinatura amanhã',
        'Como renovar minha assinatura do Astra?',
      ]) {
        expect(
          await tryPersonalSubscriptionReply({ ...create, text }, key, async () => true)
        ).toBeNull();
      }
      expect(await new CustomerPlanningRepository(key).list()).toEqual([]);
    });

    it('shares the account limit with panel plans and pages all subscriptions with usable codes', async () => {
      const key = 'limit';
      await db.execute(
        "INSERT INTO customer_plans (id,user_id,kind,title,amount_cents) SELECT 'other-' || i, $1, 'goal', 'Reserva', 100 FROM generate_series(1,70) AS i",
        [key]
      );
      const repo = new CustomerPlanningRepository(key);
      for (let i = 0; i < 9; i++)
        await repo.create({
          kind: 'subscription',
          title: 'Clube / ' + i,
          amount: 1,
          nextDueDate: '2027-02-01',
        });
      const msg = (text: string) => turn(incoming(text, 'whatsapp', key), key);
      const first = await msg('Minhas assinaturas');
      expect(first).toContain('página 2');
      const second = await msg('Minhas assinaturas página 2');
      expect(second).toContain('Clube / 8');
      expect(second).toContain(' · #');
      await Promise.all([
        msg('Cadastre a assinatura Revista por R$ 12,10 em 01/01/2027'),
        repo
          .create({ kind: 'goal', title: 'Teste de limite', amount: 1 })
          .catch((error: Error) => error.message),
      ]);
      expect(
        await db.queryOne('SELECT count(*)::int AS n FROM customer_plans WHERE user_id = $1', [key])
      ).toEqual({ n: 80 });
      expect(await msg('Cadastre a assinatura Jornal por R$ 20 em 2027-12-31')).toContain('limite');
    });

    it('serializes duplicates and rejects changes to a previously used message ID', async () => {
      const key = 'replay';
      const msg = incoming(
        'Cadastre a assinatura Filme+ por R$ 12,90 em 29/02/2028',
        'whatsapp',
        key
      );
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_, i) => turn(msg, key, i % 2 === 0))
      );
      expect(replies.filter((item) => item.includes('adicionada'))).toHaveLength(1);
      expect(replies.filter((item) => item.includes('já foi processada'))).toHaveLength(7);
      expect(await turn({ ...msg, text: 'Cancele a assinatura Filme+' }, key)).toContain(
        'conteúdo'
      );
      expect(await turn({ ...msg, id: 'repeat-manual' }, key)).toContain('já acompanha');
      expect(
        await turn({ ...msg, text: 'Quando vence a minha assinatura Filme+?' }, key)
      ).toContain('29/02/2028');
      expect(
        await turn({ ...msg, id: 'remove', text: 'Cancele a assinatura Filme+' }, key)
      ).toContain('Removi');
      expect(await turn(msg, key)).toContain('já foi processada');
      expect(await new CustomerPlanningRepository(key).list()).toEqual([]);
    });

    it('rolls back the receipt when a subscription insert fails so the message can be retried', async () => {
      await db.exec(
        "CREATE FUNCTION fail_plan() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END; $$ LANGUAGE plpgsql; CREATE TRIGGER lab_fail_plan BEFORE INSERT ON customer_plans FOR EACH ROW WHEN (NEW.user_id = 'retry') EXECUTE FUNCTION fail_plan()"
      );
      const msg = incoming(
        'Cadastre a assinatura Revista por R$ 19,99 em 01/01/2027',
        'telegram',
        'retry'
      );
      try {
        expect(await turn(msg, 'retry')).toContain('Não consegui confirmar');
      } finally {
        await db.exec('DROP TRIGGER lab_fail_plan ON customer_plans');
      }
      expect(await turn(msg, 'retry')).toContain('adicionada');
    });

    const services = [
      'Música',
      'Revista',
      'Nuvem',
      'Bicicleta',
      'Academia',
      'Idiomas',
      'Cinema',
      'Biblioteca',
      'Jornal',
      'Desenho',
    ];
    // Produce an individually reported result for each isolated account and routine.
    it.each(Array.from({ length: 500 }, (_, i) => i))(
      'completes subscription routine %i',
      async (i) => {
        const platform = i % 2 ? 'telegram' : 'whatsapp';
        const key = 'fixture-' + i;
        const repo = new CustomerPlanningRepository(key);
        const title = services[i % services.length]!;
        const cents = (9 + i) * 100 + (i % 100);
        const price = (cents / 100).toFixed(2).replace('.', ',');
        const updated = ((cents + 100) / 100).toFixed(2).replace('.', ',');
        const send = (text: string, id: string) =>
          turn(incoming(text, platform, key, id), key, i % 4 < 2);
        const create =
          i % 3 === 0
            ? 'Coloca ' +
              title +
              ' nas minhas assinaturas: R$ ' +
              price +
              ' por mês, renovação dia 12 de dezembro de 2026.'
            : 'Cadastre a assinatura ' +
              title +
              ' por R$ ' +
              price +
              ' com renovação em 12/12/2026';
        expect(await send(create, 'create')).toContain('adicionada');
        expect(await send('Minhas assinaturas', 'list')).toContain('12/12/2026');
        expect(
          await send(
            'Atualize a assinatura ' +
              title +
              ' para R$ ' +
              updated +
              ' com renovação em 12/01/2027',
            'edit'
          )
        ).toContain('atualizada');
        expect((await repo.subscriptions())[0]).toMatchObject({
          title,
          amount: (cents + 100) / 100,
          nextDueDate: '2027-01-12',
        });
        expect(await send(create, 'create')).toContain('já foi processada');
        if (i % 3 === 0) {
          expect(await send('Cancele a assinatura ' + title, 'remove')).toContain('fornecedor');
          expect(await send(create, 'create')).toContain('já foi processada');
          expect(await repo.subscriptions()).toEqual([]);
        } else {
          expect(
            await send(
              'Atualize a renovação da assinatura ' + title + ' para 01/02/2027',
              'reschedule'
            )
          ).toContain('01/02/2027');
          expect(await repo.subscriptions()).toHaveLength(1);
        }
      }
    );
  }
);
