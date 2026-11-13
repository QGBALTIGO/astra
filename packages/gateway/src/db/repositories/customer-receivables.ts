import { createHash, randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import {
  CustomerFinanceError,
  CustomerFinanceRepository,
  customerMoneyCents,
} from './customer-finance.js';
import { ChannelRemindersRepository } from './channel-reminders.js';
import {
  addCalendarDays,
  customerLocalDateTime,
  validCalendarDay,
} from '../../services/customer-date.js';

export type ReceivablePlan = {
  borrower: string;
  principal: number;
  total: number;
  installments: number;
  startDate: string;
  localTime: string;
  skipSunday: boolean;
};
type SavedPlan = {
  id: string;
  borrower: string;
  principal_cents: string;
  total_cents: string;
  installments: number;
  local_time: string;
  time_zone: string;
  remaining_cents: string;
  paid_cents: string;
};
export function receivableDates(plan: ReceivablePlan, timeZone: string): Date[] {
  if (
    !validCalendarDay(plan.startDate) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(plan.localTime) ||
    !Number.isInteger(plan.installments) ||
    plan.installments < 1 ||
    plan.installments > 120 ||
    !plan.borrower?.trim() ||
    plan.borrower.length > 100 ||
    typeof plan.skipSunday !== 'boolean'
  )
    throw new CustomerFinanceError('Confira nome, data, horário e quantidade de parcelas.');
  const principal = customerMoneyCents(plan.principal),
    total = customerMoneyCents(plan.total);
  if (principal <= 0 || total <= 0 || total % plan.installments !== 0)
    throw new CustomerFinanceError('O total precisa coincidir com a soma das parcelas.');
  const dates: Date[] = [];
  let day = plan.startDate;
  while (dates.length < plan.installments) {
    if (!plan.skipSunday || new Date(day + 'T12:00:00Z').getUTCDay() !== 0)
      dates.push(customerLocalDateTime(day + 'T' + plan.localTime, timeZone));
    day = addCalendarDays(day, 1);
  }
  return dates;
}

export class CustomerReceivablesRepository extends BaseRepository {
  constructor(private readonly userId: string) {
    super();
    if (!userId?.trim()) throw new CustomerFinanceError('Conversa autenticada necessária.');
  }
  async list(): Promise<SavedPlan[]> {
    return this.query<SavedPlan>(
      `
      SELECT p.*, GREATEST(p.total_cents - COALESCE(SUM(e.amount * 100) FILTER (WHERE e.status = 'settled' AND e.deleted_at IS NULL),0),0)::text AS remaining_cents,
        COALESCE(SUM(e.amount * 100) FILTER (WHERE e.status = 'settled' AND e.deleted_at IS NULL),0)::text AS paid_cents
      FROM customer_receivable_plans p LEFT JOIN customer_receivable_items i ON i.plan_id=p.id
      LEFT JOIN expenses e ON e.id=i.transaction_id AND e.user_id=p.user_id
      WHERE p.user_id=$1 GROUP BY p.id ORDER BY p.created_at DESC LIMIT 100`,
      [this.userId]
    );
  }
  async receive(
    planId: string,
    amount: number,
    sourceKey: string,
    date: string
  ): Promise<SavedPlan[]> {
    const cents = customerMoneyCents(amount);
    if (!/^[a-f0-9]{64}$/i.test(sourceKey) || !validCalendarDay(date) || cents <= 0)
      throw new CustomerFinanceError('Confirme o valor recebido e a data.');
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [
        this.userId,
      ]);
      const replay = await this.queryOne<{ transaction_id: string }>(
        'SELECT transaction_id FROM customer_finance_operations WHERE user_id=$1 AND source_key=$2',
        [this.userId, sourceKey]
      );
      if (replay) return this.list();
      const items = await this.query<{ id: string; amount: string; reminder_id: string }>(
        `SELECT e.id,e.amount,i.reminder_id FROM customer_receivable_items i
        JOIN customer_receivable_plans p ON p.id=i.plan_id JOIN expenses e ON e.id=i.transaction_id AND e.user_id=p.user_id
        WHERE p.user_id=$1 AND p.id=$2 AND e.status='pending' AND e.deleted_at IS NULL AND e.transaction_type='income'
        ORDER BY i.sequence FOR UPDATE OF e`,
        [this.userId, planId]
      );
      const selected: typeof items = [];
      let sum = 0;
      for (const item of items) {
        if (sum >= cents) break;
        sum += customerMoneyCents(Number(item.amount));
        selected.push(item);
      }
      if (!selected.length || sum !== cents)
        throw new CustomerFinanceError(
          'Esse valor não corresponde a parcelas completas pendentes. Me diga qual parcela e quanto foi recebido para eu conferir antes de dar baixa.'
        );
      for (const item of selected) {
        await this.execute(
          `UPDATE expenses SET status='settled',date=$3,updated_at=NOW() WHERE user_id=$1 AND id=$2`,
          [this.userId, item.id, date]
        );
        await this.execute(
          `UPDATE channel_reminders SET status='cancelled',updated_at=NOW() WHERE user_id=$1 AND id=$2 AND status='pending'`,
          [this.userId, item.reminder_id]
        );
      }
      await this.execute(
        `INSERT INTO customer_finance_operations (user_id,source_key,transaction_id,kind) VALUES ($1,$2,$3,'settle')`,
        [this.userId, sourceKey, selected[0]!.id]
      );
      return this.list();
    });
  }
  async create(
    plans: ReceivablePlan[],
    channel: { pluginId: string; chatId: string; timeZone: string }
  ): Promise<SavedPlan[]> {
    if (!Array.isArray(plans) || !plans.length || plans.length > 10)
      throw new CustomerFinanceError('Envie de um a dez recebimentos por pedido.');
    const prepared = plans.map((plan) => ({
      plan,
      dates: receivableDates(plan, channel.timeZone),
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify([
            this.userId,
            plan.borrower.normalize('NFC').toLowerCase().trim(),
            customerMoneyCents(plan.principal),
            customerMoneyCents(plan.total),
            plan.installments,
            plan.startDate,
            plan.localTime,
            plan.skipSunday,
            channel.timeZone,
          ])
        )
        .digest('hex'),
    }));
    if (new Set(prepared.map((p) => p.fingerprint)).size !== prepared.length)
      throw new CustomerFinanceError('Há um recebimento repetido no pedido.');
    const categories = await new CustomerFinanceRepository(this.userId).listCategories();
    const category = categories.find(
      (c) => c.type === 'income' && c.legacyKey === 'other' && !c.archived
    );
    if (!category) throw new CustomerFinanceError('Categoria de entradas indisponível.');
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [
        this.userId,
      ]);
      for (const { plan, dates, fingerprint } of prepared) {
        const existing = await this.queryOne<{ id: string }>(
          'SELECT id FROM customer_receivable_plans WHERE user_id=$1 AND fingerprint=$2',
          [this.userId, fingerprint]
        );
        if (existing) continue;
        const previous = await this.query<{
          id: string;
          description: string;
          amount: string;
          date: string;
          status: string;
          currency: string;
        }>(
          `SELECT id,description,amount,date,status,currency FROM expenses WHERE user_id=$1 AND transaction_type='income' AND deleted_at IS NULL
          AND LOWER(description) LIKE '%' || LOWER($2) || '%' FOR UPDATE`,
          [this.userId, plan.borrower]
        );
        const legacy = new Map<number, string>();
        for (const row of previous) {
          const number = /^Parcela (\d+)\/(\d+) - (.+) \(Total R\$ ([\d.,]+)\)$/u.exec(
            row.description
          );
          const index = Number(number?.[1]),
            count = Number(number?.[2]);
          const total = number?.[4]?.replace(/\./g, '').replace(',', '.');
          const expected = dates[index - 1];
          const localDay = expected
            ? new Intl.DateTimeFormat('sv-SE', {
                timeZone: channel.timeZone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
              }).format(expected)
            : null;
          if (
            !number ||
            number[3] !== plan.borrower ||
            count !== plan.installments ||
            !expected ||
            Number(total) !== plan.total ||
            Number(row.amount) !== plan.total / plan.installments ||
            row.currency !== 'BRL' ||
            row.date !== localDay ||
            row.status !== 'pending' ||
            legacy.has(index)
          )
            throw new CustomerFinanceError(
              'Já há um lançamento diferente para ' +
                plan.borrower +
                '. Preciso conferir esse registro antes de criar parcelas.'
            );
          legacy.set(index, row.id);
        }
        const id = randomUUID();
        await this.execute(
          `INSERT INTO customer_receivable_plans (id,user_id,borrower,principal_cents,total_cents,installments,start_date,local_time,time_zone,skip_sunday,fingerprint)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            this.userId,
            plan.borrower,
            customerMoneyCents(plan.principal),
            customerMoneyCents(plan.total),
            plan.installments,
            plan.startDate,
            plan.localTime,
            channel.timeZone,
            plan.skipSunday,
            fingerprint,
          ]
        );
        const unit = customerMoneyCents(plan.total) / plan.installments;
        for (let index = 0; index < dates.length; index++) {
          const transactionId = legacy.get(index + 1) ?? randomUUID(),
            date = dates[index]!,
            sequence = index + 1;
          const description = plan.borrower + ' · parcela ' + sequence + '/' + plan.installments;
          const localDay = new Intl.DateTimeFormat('sv-SE', {
            timeZone: channel.timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(date);
          if (!legacy.has(sequence))
            await this.execute(
              `INSERT INTO expenses (id,user_id,date,amount,currency,category,category_id,description,source,transaction_type,status,notes)
            VALUES ($1,$2,$3,$4::numeric,'BRL','other',$5,$6,'channel','income','pending',$7)`,
              [
                transactionId,
                this.userId,
                localDay,
                (unit / 100).toFixed(2),
                category.id,
                description,
                'Valor emprestado: R$ ' +
                  plan.principal.toFixed(2) +
                  '; total a receber: R$ ' +
                  plan.total.toFixed(2),
              ]
            );
          const oldReminders = await this.query<{ id: string }>(
            `SELECT id FROM channel_reminders WHERE user_id=$1 AND channel_plugin_id=$2 AND platform_chat_id=$3 AND remind_at=$4 AND status IN ('pending','sending','delivered') AND LOWER(title) LIKE '%' || LOWER($5) || '%' AND LOWER(title) ~ '(parcela|pagamento|recebimento|receber|cobrar|cobran)' FOR UPDATE`,
            [this.userId, channel.pluginId, channel.chatId, date, plan.borrower]
          );
          if (oldReminders.length > 1)
            throw new CustomerFinanceError(
              'Há mais de um aviso nesse horário para ' +
                plan.borrower +
                '. Preciso conferir os avisos antes de criar outro.'
            );
          const reminder =
            oldReminders[0] ??
            (await new ChannelRemindersRepository().schedule({
              userId: this.userId,
              title:
                'Conferir recebimento de ' +
                description +
                ' · R$ ' +
                (unit / 100).toFixed(2).replace('.', ','),
              remindAt: date,
              channelPluginId: channel.pluginId,
              platformChatId: channel.chatId,
              dedupeKey: 'receivable:' + id + ':' + sequence,
            }));
          await this.execute(
            'INSERT INTO customer_receivable_items (plan_id,sequence,transaction_id,reminder_id) VALUES ($1,$2,$3,$4)',
            [id, sequence, transactionId, reminder.id]
          );
        }
      }
      return this.list();
    });
  }
}
