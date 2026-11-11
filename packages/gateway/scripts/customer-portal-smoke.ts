/** Real PostgreSQL checks for the portal's shared ledger and durable agenda.
 * Called only by the isolated migration smoke harness; never starts a worker
 * or resolves a real WhatsApp transport. Every record has a random test scope.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getAdapter } from '../src/db/adapters/index.js';
import type { DatabaseAdapter } from '../src/db/adapters/types.js';
import {
  CustomerFinanceRepository,
  type CustomerTransactionInput,
} from '../src/db/repositories/customer-finance.js';
import { ExpensesRepository } from '../src/db/repositories/expenses.js';
import { CustomerAgendaRepository } from '../src/db/repositories/customer-agenda.js';
import { CustomerPlanningRepository } from '../src/db/repositories/customer-planning.js';

export async function verifyCustomerPortalPersistence(adapter: DatabaseAdapter): Promise<void> {
  assert.equal(await getAdapter(), adapter, 'All nested repositories must use the smoke adapter');
  const existing = await adapter.queryOne<{ accounts: number; recipients: number }>(
    `SELECT (SELECT COUNT(*)::integer FROM customer_accounts) AS accounts,
      (SELECT COUNT(*)::integer FROM channel_users WHERE platform = 'whatsapp') AS recipients`
  );
  assert.deepEqual(
    existing,
    { accounts: 0, recipients: 0 },
    'Portal smoke requires an isolated database'
  );
  const namespace = `smoke:customer-portal:${randomUUID()}`;
  const userA = `${namespace}:a`;
  const userB = `${namespace}:b`;
  const scopes = [userA, userB];
  const finance = new CustomerFinanceRepository(userA);
  const replica = new CustomerFinanceRepository(userA);
  const otherFinance = new CustomerFinanceRepository(userB);
  const expenses = new ExpensesRepository(userA);
  const agenda = new CustomerAgendaRepository(userA, 'America/Campo_Grande');
  const otherAgenda = new CustomerAgendaRepository(userB, 'America/Campo_Grande');
  const channel = { pluginId: 'channel.whatsapp.smoke', phoneNumber: '5511999990171' };
  const day = '2090-01-02';
  const from = '2090-01-01';
  const to = '2090-01-03';
  const countAgenda = () =>
    adapter.queryOne<{
      events: number;
      tasks: number;
      reminders: number;
      links: number;
      requests: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM calendar_events WHERE user_id = $1) AS events,
        (SELECT COUNT(*)::integer FROM tasks WHERE user_id = $1) AS tasks,
        (SELECT COUNT(*)::integer FROM channel_reminders WHERE user_id = $1) AS reminders,
        (SELECT COUNT(*)::integer FROM customer_agenda_links WHERE user_id = $1) AS links,
        (SELECT COUNT(*)::integer FROM customer_agenda_requests WHERE user_id = $1) AS requests`,
      [userA]
    );

  try {
    // A pre-portal WhatsApp expense must retain its ID and amount during backfill.
    const legacy = await expenses.create({
      date: day,
      amount: 0.1,
      category: 'food',
      description: 'Almoço legado',
    });
    const categories = await finance.listCategories();
    const linkedLegacy = await finance.getTransaction(legacy.id);
    assert.ok(linkedLegacy);
    assert.equal(linkedLegacy.amount, 0.1);
    assert.equal(linkedLegacy.type, 'expense');
    assert.equal(linkedLegacy.status, 'settled');
    const expenseCategory = categories.find((category) => category.id === linkedLegacy.categoryId);
    const incomeCategory = categories.find((category) => category.type === 'income');
    assert.ok(expenseCategory && incomeCategory);
    assert.deepEqual(
      await replica.listCategories(),
      categories,
      'Categories retain stable scoped IDs across replicas'
    );
    const input: CustomerTransactionInput = {
      description: 'Salário',
      amount: 100.3,
      type: 'income',
      status: 'settled',
      categoryId: incomeCategory.id,
      date: day,
    };
    const [income, duplicate] = await Promise.all([
      finance.createTransaction(input, 'smoke-income-001'),
      replica.createTransaction(input, 'smoke-income-001'),
    ]);
    assert.equal(income.id, duplicate.id, 'Concurrent keyed creation must commit once');
    await assert.rejects(finance.createTransaction({ ...input, amount: 101 }, 'smoke-income-001'), {
      status: 409,
    });
    const pendingExpense = await finance.createTransaction({
      ...input,
      description: 'Internet',
      amount: 0.2,
      type: 'expense',
      status: 'pending',
      categoryId: expenseCategory.id,
    });
    await finance.createTransaction({
      ...input,
      description: 'Serviço a receber',
      amount: 25,
      status: 'pending',
    });
    const summary = await finance.summary(from, to);
    assert.deepEqual(
      {
        income: summary.income,
        expenses: summary.expenses,
        result: summary.result,
        pendingIncome: summary.pendingIncome,
        pendingExpenses: summary.pendingExpenses,
      },
      { income: 100.3, expenses: 0.1, result: 100.2, pendingIncome: 25, pendingExpenses: 0.2 }
    );
    assert.deepEqual(summary.series, [
      { date: from, income: 0, expenses: 0 },
      { date: day, income: 100.3, expenses: 0.1 },
      { date: to, income: 0, expenses: 0 },
    ]);
    assert.equal(summary.categories[0]?.total, 0.1);
    assert.equal(summary.categories[0]?.percentage, 100);
    assert.equal((await expenses.getSummary(from, to)).totalAmount, 0.1);
    assert.equal(
      await expenses.count(),
      1,
      'Legacy expense tools exclude income and pending amounts'
    );
    assert.deepEqual(
      (await expenses.list()).map((row) => row.id),
      [legacy.id]
    );
    assert.equal((await finance.listTransactions({ status: 'pending' })).total, 2);

    const otherCategories = await otherFinance.listCategories();
    const otherIncome = otherCategories.find((category) => category.type === 'income');
    assert.ok(otherIncome);
    const foreign = await otherFinance.createTransaction(
      { ...input, categoryId: otherIncome.id },
      'smoke-income-001'
    );
    assert.notEqual(
      foreign.id,
      income.id,
      'Request keys are scoped to the authenticated data user'
    );
    assert.equal(await finance.getTransaction(foreign.id), null);
    assert.equal(await finance.updateTransaction(foreign.id, { amount: 15 }), null);
    assert.equal(await finance.deleteTransaction(foreign.id), false);
    await assert.rejects(finance.createTransaction({ ...input, categoryId: otherIncome.id }), {
      status: 409,
    });
    await assert.rejects(
      adapter.execute('UPDATE expenses SET category_id = $1 WHERE id = $2 AND user_id = $3', [
        otherIncome.id,
        income.id,
        userA,
      ]),
      (error: unknown) =>
        !!error && typeof error === 'object' && 'code' in error && error.code === '23503',
      'Composite category foreign key must reject cross-user references'
    );

    const [custom, customDuplicate] = await Promise.all([
      finance.createCategory(
        { name: 'Restaurantes', type: 'expense', color: '#123456' },
        'smoke-category-001'
      ),
      replica.createCategory(
        { name: 'Restaurantes', type: 'expense', color: '#123456' },
        'smoke-category-001'
      ),
    ]);
    assert.equal(custom.id, customDuplicate.id);
    await assert.rejects(
      finance.createCategory(
        { name: 'Outro nome', type: 'expense', color: '#123456' },
        'smoke-category-001'
      ),
      { status: 409 }
    );
    await finance.updateTransaction(legacy.id, { categoryId: custom.id });
    await finance.updateCategory(custom.id, { name: 'Refeições' });
    assert.equal((await finance.getTransaction(legacy.id))?.categoryName, 'Refeições');
    assert.equal((await expenses.get(legacy.id))?.categoryName, 'Refeições');
    assert.equal((await expenses.getSummary(from, to)).byCategory['Refeições']?.amount, 0.1);
    await assert.rejects(finance.deleteCategory(custom.id, otherIncome.id), { status: 409 });
    assert.deepEqual(await finance.deleteCategory(custom.id, expenseCategory.id), {
      deleted: false,
      archived: true,
    });
    assert.equal((await finance.getTransaction(legacy.id))?.categoryId, expenseCategory.id);
    await assert.rejects(
      finance.createTransaction({ ...input, type: 'expense', categoryId: custom.id }),
      { status: 409 }
    );

    // Agenda bills mutate the existing financial row; they never create a payment copy.
    const bills = await agenda.list(from, to);
    assert.ok(bills.some((item) => item.kind === 'bill' && item.id === pendingExpense.id));
    assert.equal(
      (await agenda.update('bill', pendingExpense.id, { completed: true }, null)).completed,
      true
    );
    assert.equal((await finance.getTransaction(pendingExpense.id))?.status, 'settled');
    const paidSummary = await finance.summary(from, to);
    assert.equal(paidSummary.expenses, 0.3, '0.10 + 0.20 remains an exact monetary total');
    assert.equal(paidSummary.result, 100);
    await agenda.update('bill', pendingExpense.id, { completed: false }, null);
    assert.equal((await finance.getTransaction(pendingExpense.id))?.status, 'pending');
    await assert.rejects(otherAgenda.update('bill', pendingExpense.id, { completed: true }, null), {
      status: 404,
    });
    const settlement = {
      description: 'Internet',
      type: 'expense' as const,
      date: day,
      sourceKey: '1'.repeat(64),
    };
    const [settled, settledReplay] = await Promise.all([
      finance.settleFromChannel(settlement),
      replica.settleFromChannel(settlement),
    ]);
    assert.deepEqual(
      new Set([settled.outcome, settledReplay.outcome]),
      new Set(['settled', 'duplicate'])
    );
    assert.ok('transaction' in settled && 'transaction' in settledReplay);
    assert.equal(settled.transaction.id, pendingExpense.id);
    assert.equal(settledReplay.transaction.id, pendingExpense.id);

    const providerKey = '2'.repeat(64);
    const oldChannel = await expenses.createFromChannel(
      { date: day, amount: 7.25, description: 'Mensagem antiga', category: 'food' },
      providerKey
    );
    const newChannel = await finance.createFromChannel(
      {
        description: 'Mensagem antiga',
        amount: 7.25,
        type: 'expense',
        status: 'settled',
        categoryKey: 'food',
        date: day,
      },
      providerKey
    );
    assert.equal(
      newChannel.transaction.id,
      oldChannel.expense.id,
      'Both WhatsApp paths share the provider ID key space'
    );
    assert.equal(newChannel.created, false);
    assert.equal(await finance.deleteTransaction(oldChannel.expense.id), true);
    await assert.rejects(
      expenses.createFromChannel(
        { date: day, amount: 7.25, description: 'Mensagem antiga', category: 'food' },
        providerKey
      )
    );
    assert.equal(await finance.getTransaction(oldChannel.expense.id), null);
    const deleted = await finance.createTransaction(
      { ...input, description: 'Excluir' },
      'smoke-deleted-001'
    );
    await finance.deleteTransaction(deleted.id);
    await assert.rejects(
      replica.createTransaction({ ...input, description: 'Excluir' }, 'smoke-deleted-001'),
      { status: 409 }
    );
    const exported = await finance.exportTransactions();
    assert.equal(
      exported.length,
      4,
      'Export contains the whole active BRL ledger, including pending income'
    );
    assert.ok(exported.some((row) => row.status === 'pending' && row.type === 'income'));
    assert.ok(!exported.some((row) => row.id === foreign.id || row.id === deleted.id));

    const eventInput = {
      kind: 'event' as const,
      title: 'Dentista',
      startAt: '2090-01-02T09:00:00-04:00',
      endAt: '2090-01-02T10:00:00-04:00',
      reminderAt: '2090-01-02T08:45:00-04:00',
    };
    const agendaReplica = new CustomerAgendaRepository(userA, 'America/Campo_Grande');
    const [event, eventDuplicate] = await Promise.all([
      agenda.create(eventInput, channel, 'smoke-event-001'),
      agendaReplica.create(
        { ...eventInput, startAt: '2090-01-02T13:00:00Z' },
        channel,
        'smoke-event-001'
      ),
    ]);
    assert.equal(
      event.id,
      eventDuplicate.id,
      'Equivalent offset and UTC instants share the same idempotency payload'
    );
    assert.equal(event.startAt, '2090-01-02T13:00:00.000Z');
    assert.equal(event.endAt, '2090-01-02T14:00:00.000Z');
    assert.equal(event.reminderAt, '2090-01-02T12:45:00.000Z');
    const storedEvent = await adapter.queryOne<{ start: string; end: string }>(
      `SELECT TO_CHAR(start_time, 'YYYY-MM-DD HH24:MI:SS') AS start,
        TO_CHAR(end_time, 'YYYY-MM-DD HH24:MI:SS') AS end FROM calendar_events WHERE id = $1 AND user_id = $2`,
      [event.id, userA]
    );
    assert.deepEqual(storedEvent, { start: '2090-01-02 13:00:00', end: '2090-01-02 14:00:00' });
    assert.deepEqual(await countAgenda(), {
      events: 1,
      tasks: 0,
      reminders: 1,
      links: 1,
      requests: 1,
    });
    await assert.rejects(
      otherAgenda.update('event', event.id, { title: 'Outro cliente' }, channel),
      { status: 404 }
    );
    assert.equal(await otherAgenda.delete('event', event.id), false);
    await assert.rejects(
      agenda.create({ ...eventInput, title: 'Outro título' }, channel, 'smoke-event-001'),
      { status: 409 }
    );
    const rescheduled = await agenda.update(
      'event',
      event.id,
      { reminderAt: '2090-01-02T08:30:00-04:00' },
      channel
    );
    assert.equal(rescheduled.reminderAt, '2090-01-02T12:30:00.000Z');
    const reminderStatuses = await adapter.query<{ status: string; count: number }>(
      'SELECT status, COUNT(*)::integer AS count FROM channel_reminders WHERE user_id = $1 GROUP BY status ORDER BY status',
      [userA]
    );
    assert.deepEqual(reminderStatuses, [
      { status: 'cancelled', count: 1 },
      { status: 'pending', count: 1 },
    ]);

    const task = await agenda.create(
      {
        kind: 'task',
        title: 'Separar documentos',
        dueDate: day,
        reminderAt: '2090-01-02T08:00:00-04:00',
      },
      channel,
      'smoke-task-001'
    );
    assert.equal(task.reminderAt, '2090-01-02T12:00:00.000Z');
    const taskRow = await adapter.queryOne<{ reminder: string }>(
      `SELECT TO_CHAR(reminder_at, 'YYYY-MM-DD HH24:MI:SS') AS reminder FROM tasks WHERE id = $1 AND user_id = $2`,
      [task.id, userA]
    );
    assert.equal(taskRow?.reminder, '2090-01-02 12:00:00');
    assert.equal((await agenda.update('task', task.id, { completed: true }, null)).completed, true);
    const listed = await agenda.list(from, to);
    assert.ok(
      listed.some((item) => item.id === event.id && item.startAt === '2090-01-02T13:00:00.000Z')
    );
    assert.ok(listed.some((item) => item.id === task.id && item.completed && !item.reminderAt));
    const beforeRollback = await countAgenda();
    await assert.rejects(
      agenda.create(
        { ...eventInput, title: 'Rollback sem transporte' },
        null,
        'smoke-rollback-001'
      ),
      { status: 503 }
    );
    assert.deepEqual(
      await countAgenda(),
      beforeRollback,
      'Failure after event/link creation rolls the whole agenda operation back'
    );
    assert.equal((await agenda.exportRecords()).events.length, 1);
    assert.equal(await agenda.delete('event', event.id), true);
    assert.equal(await agenda.delete('task', task.id), true);

    // End-to-end customer planning uses the same scoped PostgreSQL adapter.
    const planning = new CustomerPlanningRepository(userA);
    const otherPlanning = new CustomerPlanningRepository(userB);
    const originalLedger = await finance.summary(from, to);
    const goal = await planning.create({
      kind: 'goal', title: 'Reserva de emergência', amount: 2000, progress: 450.25,
    });
    assert.equal(goal.amount, 2000);
    assert.equal(goal.progress, 450.25);
    const budget = await planning.create({
      kind: 'budget', title: 'Alimentação mensal', amount: 350, categoryId: expenseCategory.id,
    });
    assert.equal(budget.categoryId, expenseCategory.id);
    const installment = await planning.create({
      kind: 'installment', title: 'Parcelas do carro', amount: 470,
      installmentsTotal: 12, installmentsPaid: 3, nextDueDate: '2090-02-01',
    });
    assert.equal(installment.installmentsPaid, 3);
    const subscription = await planning.create({
      kind: 'subscription', title: 'Internet mensal', amount: 99.9,
      nextDueDate: '2090-02-05',
    });
    assert.equal(subscription.nextDueDate, '2090-02-05');
    assert.equal((await planning.list()).length, 4);
    assert.deepEqual(await otherPlanning.list(), []);
    assert.equal(await otherPlanning.get(goal.id), null);
    assert.equal(await otherPlanning.update(goal.id, {
      kind: 'goal', title: 'Invasão', amount: 20, progress: 0,
    }), null);
    assert.equal(await otherPlanning.delete(goal.id), false);
    await assert.rejects(planning.create({
      kind: 'goal', title: 'Meta inconsistente', amount: 50, progress: 60,
    }));
    const updated = await planning.update(subscription.id, {
      kind: 'subscription', title: 'Internet mensal', amount: 105,
      nextDueDate: '2090-03-05',
    });
    assert.equal(updated?.amount, 105);
    assert.equal(await planning.delete(subscription.id), true);
    assert.equal(await planning.get(subscription.id), null);
    assert.deepEqual(
      await finance.summary(from, to),
      originalLedger,
      'Goals and manual plans must never mutate actual customer finance entries'
    );
    console.log('[smoke] Customer planning CRUD, cents, isolation and unchanged ledger passed');

    console.log(
      '[smoke] Customer shared ledger totals, scope, idempotency, categories, agenda UTC, bills and rollback passed'
    );
  } finally {
    // Delete only this invocation's synthetic scopes, in foreign-key order.
    for (const table of [
      'customer_plans',
      'customer_agenda_requests',
      'customer_agenda_links',
      'customer_finance_operations',
      'expenses',
      'customer_categories',
      'calendar_events',
      'tasks',
      'channel_reminders',
    ]) {
      await adapter.execute(`DELETE FROM ${table} WHERE user_id = ANY($1::text[])`, [scopes]);
    }
  }
}
