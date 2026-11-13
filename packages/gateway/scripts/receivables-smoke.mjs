import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const mod = (p) => import(new URL('../src/' + p, import.meta.url).href);

export async function verifyReceivablePersistence(db) {
  const { CustomerReceivablesRepository } = await mod('db/repositories/customer-receivables.ts');
  const { CustomerFinanceRepository } = await mod('db/repositories/customer-finance.ts');
  const id = 'lab:receivable:' + randomUUID();
  const repo = new CustomerReceivablesRepository(id);
  const first = {
    borrower: 'Cliente Alfa',
    principal: 500,
    total: 700,
    installments: 10,
    startDate: '2026-11-14',
    localTime: '18:00',
    skipSunday: true,
  };
  const plans = [
    first,
    { ...first, borrower: 'Cliente Beta', principal: 800, total: 1120, localTime: '14:30' },
    { ...first, borrower: 'Cliente Gama', principal: 1250, total: 1750, localTime: '20:00' },
  ];
  const channel = {
    pluginId: 'channel.whatsapp.synthetic',
    chatId: 'synthetic',
    timeZone: 'America/Cuiaba',
  };
  try {
    const initial = await repo.create(plans, channel);
    assert.equal(initial.length, 3);
    assert.equal(
      initial.reduce((n, p) => n + Number(p.remaining_cents), 0),
      357000
    );
    assert.equal(
      initial.reduce((n, p) => n + Number(p.paid_cents), 0),
      0
    );
    await Promise.all([repo.create(plans, channel), repo.create(plans, channel)]);
    const count = await db.queryOne(
      'SELECT count(*)::int AS count FROM expenses WHERE user_id=$1',
      [id]
    );
    assert.equal(count.count, 30);
    const reminders = await db.query(
      'SELECT remind_at FROM channel_reminders WHERE user_id=$1 ORDER BY remind_at',
      [id]
    );
    assert.equal(reminders.length, 30);
    assert.ok(
      reminders.every(
        (r) =>
          new Intl.DateTimeFormat('en-US', { timeZone: 'America/Cuiaba', weekday: 'short' }).format(
            new Date(r.remind_at)
          ) !== 'Sun'
      )
    );
    assert.equal(new Date(reminders[0].remind_at).toISOString(), '2026-11-14T18:30:00.000Z');
    const plan = initial.find((p) => p.borrower === 'Cliente Alfa');
    const source = createHash('sha256').update('synthetic').digest('hex');
    await Promise.all([
      repo.receive(plan.id, 70, source, '2026-11-13'),
      repo.receive(plan.id, 70, source, '2026-11-13'),
    ]);
    const after = await repo.list();
    assert.equal(Number(after.find((p) => p.id === plan.id).remaining_cents), 63000);
    assert.equal(Number(after.find((p) => p.id === plan.id).paid_cents), 7000);
    const other = new CustomerReceivablesRepository(id + ':other');
    assert.deepEqual(await other.list(), []);
    await assert.rejects(other.receive(plan.id, 70, source, '2026-11-13'));
    await assert.rejects(
      repo.receive(plan.id, 71, createHash('sha256').update('bad').digest('hex'), '2026-11-13')
    );
    assert.equal(Number((await repo.list()).find((p) => p.id === plan.id).remaining_cents), 63000);
    const categories = await new CustomerFinanceRepository(id).listCategories();
    const income = categories.find((c) => c.type === 'income' && c.legacyKey === 'other');
    await new CustomerFinanceRepository(id).createTransaction({
      description: 'Pessoa de legado',
      amount: 10,
      type: 'income',
      status: 'pending',
      date: '2026-11-14',
      categoryId: income.id,
    });
    const before = (await repo.list()).length;
    await assert.rejects(
      repo.create(
        [
          { ...first, borrower: 'Novo empréstimo' },
          { ...first, borrower: 'Pessoa de legado' },
        ],
        channel
      )
    );
    assert.equal((await repo.list()).length, before);
    assert.equal(
      (
        await db.queryOne('SELECT count(*)::int AS count FROM channel_reminders WHERE user_id=$1', [
          id,
        ])
      ).count,
      30
    );
    const legacyScope = id + ':legacy';
    const legacyRepo = new CustomerReceivablesRepository(legacyScope);
    const legacyLedger = new CustomerFinanceRepository(legacyScope);
    const cats = await legacyLedger.listCategories();
    const cat = cats.find((c) => c.type === 'income' && c.legacyKey === 'other');
    const preserved = [];
    for (const p of plans) {
      const amount = p.total / p.installments;
      const money = new Intl.NumberFormat('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(p.total);
      const row = await legacyLedger.createTransaction({
        description: 'Parcela 1/10 - ' + p.borrower + ' (Total R$ ' + money + ')',
        amount,
        type: 'income',
        status: 'pending',
        date: '2026-11-14',
        categoryId: cat.id,
      });
      preserved.push(row.id);
    }
    const { ChannelRemindersRepository } = await mod('db/repositories/channel-reminders.ts');
    await new ChannelRemindersRepository().schedule({
      userId: legacyScope,
      title: 'Receber parcela de Cliente Alfa',
      remindAt: new Date('2026-11-14T22:00:00Z'),
      channelPluginId: channel.pluginId,
      platformChatId: channel.chatId,
      dedupeKey: randomUUID(),
    });
    await legacyRepo.create(plans, channel);
    assert.equal(
      (
        await db.queryOne('SELECT COUNT(*)::int AS count FROM expenses WHERE user_id=$1', [
          legacyScope,
        ])
      ).count,
      30
    );
    assert.equal(
      (
        await db.queryOne('SELECT COUNT(*)::int AS count FROM channel_reminders WHERE user_id=$1', [
          legacyScope,
        ])
      ).count,
      30
    );
    assert.equal(
      (
        await db.queryOne(
          'SELECT COUNT(*)::int AS count FROM expenses WHERE user_id=$1 AND id=ANY($2::text[])',
          [legacyScope, preserved]
        )
      ).count,
      3
    );
    console.log(
      JSON.stringify({
        partialRequestReconciled: true,
        oldInstallmentsPreserved: 3,
        totalInstallments: 30,
        totalReminders: 30,
      })
    );
    console.log(
      JSON.stringify({
        plans: 3,
        installments: 30,
        reminders: 30,
        skipSunday: true,
        correctCuiabaTime: true,
        concurrentReplaySafe: true,
        paymentReplaySafe: true,
        tenantIsolation: true,
        rollbackSafe: true,
        paidAmount: 70,
        remainingForFirst: 630,
      })
    );
  } finally {
    const scopes = [id, id + ':other', id + ':legacy'];
    await db.execute(
      'DELETE FROM customer_receivable_items WHERE plan_id IN (SELECT id FROM customer_receivable_plans WHERE user_id=ANY($1::text[]))',
      [scopes]
    );
    for (const table of [
      'customer_finance_operations',
      'customer_receivable_plans',
      'expenses',
      'channel_reminders',
      'customer_categories',
    ])
      await db.execute('DELETE FROM ' + table + ' WHERE user_id=ANY($1::text[])', [scopes]);
  }
}
