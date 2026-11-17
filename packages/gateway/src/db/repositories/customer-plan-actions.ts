/** One atomic, owner-scoped action shared by the dashboard and chat. */
import { createHash } from 'node:crypto';
import { BaseRepository } from './base.js';
import {
  CustomerPlanningRepository,
  subscriptionTitleKey,
  type CustomerPlanInput,
} from './customer-planning.js';
import {
  CustomerFinanceError,
  CustomerFinanceRepository,
  validateCustomerFinanceDate,
} from './customer-finance.js';

export function planningNameKey(value: string): string {
  return subscriptionTitleKey(value)
    .replace(/^(?:a |o )?(?:parcela|parcelas|financiamento)(?: (?:do|da|de))? /u, '')
    .replace(/^(?:meu|minha|do meu|da minha|do|da) /u, '');
}

export class CustomerPlanActions extends BaseRepository {
  constructor(private readonly userId: string) {
    super();
    if (!userId?.trim()) throw new CustomerFinanceError('Entre na sua conta para continuar.');
  }

  async findInstallments(name: string) {
    const key = planningNameKey(name);
    return (await new CustomerPlanningRepository(this.userId).list()).filter(
      (plan) => plan.kind === 'installment' && planningNameKey(plan.title) === key
    );
  }

  async addGoalSavings(id: string, amount: number, requestKey: string) {
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      Math.round(amount * 100) / 100 !== amount ||
      !/^[a-f0-9]{64}$/.test(requestKey)
    )
      throw new CustomerFinanceError('Confirme o valor guardado na meta.');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(['goal-saving', id, amount]))
      .digest('hex');
    const plans = new CustomerPlanningRepository(this.userId);
    return this.transaction(async () => {
      for (const scope of ['customer-finance:', 'customer-plans:'])
        await this.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          scope + this.userId,
        ]);
      const replay = await this.queryOne<{ fingerprint: string; plan_id: string }>(
        'SELECT fingerprint, plan_id FROM customer_planning_requests WHERE user_id = $1 AND request_key = $2',
        [this.userId, requestKey]
      );
      if (replay && replay.fingerprint !== fingerprint)
        throw new CustomerFinanceError('Esse pedido já foi usado.', 409);
      const plan = await plans.get(replay?.plan_id ?? id);
      if (!plan || plan.kind !== 'goal')
        throw new CustomerFinanceError('Meta não encontrada na sua conta.', 404);
      if (replay) return { plan, duplicate: true };
      const progress = (Math.round(plan.progress * 100) + Math.round(amount * 100)) / 100;
      if (progress > plan.amount)
        throw new CustomerFinanceError(
          'Esse valor ultrapassa o total da meta. Confira o valor guardado antes de atualizar.'
        );
      const updated = await plans.update(id, { ...plan, progress });
      if (!updated) throw new Error('Goal update not persisted');
      await this.execute(
        'INSERT INTO customer_planning_requests (user_id, request_key, fingerprint, plan_id) VALUES ($1, $2, $3, $4)',
        [this.userId, requestKey, fingerprint, id]
      );
      return { plan: updated, duplicate: false };
    });
  }

  async createPlan(input: CustomerPlanInput, requestKey: string) {
    if (!/^[a-f0-9]{64}$/.test(requestKey)) throw new CustomerFinanceError('Pedido inválido.');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const plans = new CustomerPlanningRepository(this.userId);
    return this.transaction(async () => {
      for (const scope of ['customer-finance:', 'customer-plans:'])
        await this.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          scope + this.userId,
        ]);
      const replay = await this.queryOne<{ fingerprint: string; plan_id: string }>(
        'SELECT fingerprint, plan_id FROM customer_planning_requests WHERE user_id=$1 AND request_key=$2',
        [this.userId, requestKey]
      );
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new CustomerFinanceError('Esse pedido já foi usado.', 409);
        const plan = await plans.get(replay.plan_id);
        if (!plan)
          throw new CustomerFinanceError(
            'Esse planejamento foi excluído. Não recriei o registro por uma mensagem repetida.',
            409
          );
        return { plan, duplicate: true };
      }
      const plan = await plans.create(input);
      await this.execute(
        'INSERT INTO customer_planning_requests (user_id,request_key,fingerprint,plan_id) VALUES ($1,$2,$3,$4)',
        [this.userId, requestKey, fingerprint, plan.id]
      );
      return { plan, duplicate: false };
    });
  }

  async payInstallment(
    id: string,
    date: string,
    requestKey: string,
    expectedPaid?: number,
    expectedUpdatedAt?: string
  ) {
    validateCustomerFinanceDate(date);
    if (
      !/^[a-f0-9]{64}$/.test(requestKey) ||
      (expectedPaid !== undefined && (!Number.isInteger(expectedPaid) || expectedPaid < 0))
    )
      throw new CustomerFinanceError('Confirme a parcela antes de registrar o pagamento.');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          id,
          expectedPaid ?? null,
          expectedPaid === undefined ? null : (expectedUpdatedAt ?? null),
        ])
      )
      .digest('hex');
    const finance = new CustomerFinanceRepository(this.userId);
    const categories = await finance.listCategories();
    const plans = new CustomerPlanningRepository(this.userId);
    return this.transaction(async () => {
      // Same order as category transfers and plan edits; no lost increments.
      for (const scope of ['customer-finance:', 'customer-plans:'])
        await this.queryOne('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          scope + this.userId,
        ]);
      const replay = await this.queryOne<{
        fingerprint: string;
        plan_id: string;
        transaction_id: string;
      }>(
        'SELECT fingerprint, plan_id, transaction_id FROM customer_planning_requests WHERE user_id = $1 AND request_key = $2',
        [this.userId, requestKey]
      );
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new CustomerFinanceError('Esse pedido já foi usado para outra alteração.', 409);
        const plan = await plans.get(replay.plan_id);
        const transaction = await finance.getTransaction(replay.transaction_id);
        if (!plan || !transaction)
          throw new CustomerFinanceError(
            'O registro desse pedido foi alterado ou excluído. Nenhum pagamento foi repetido.',
            409
          );
        return { plan, transaction, duplicate: true };
      }
      const locked = await this.queryOne<{ id: string }>(
        "SELECT id FROM customer_plans WHERE user_id = $1 AND id = $2 AND kind = 'installment' FOR UPDATE",
        [this.userId, id]
      );
      const plan = locked ? await plans.get(id) : null;
      if (!plan) throw new CustomerFinanceError('Parcela não encontrada na sua conta.', 404);
      const paid = plan.installmentsPaid ?? 0;
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== plan.updatedAt)
        throw new CustomerFinanceError(
          'O valor ou os dados dessa parcela mudaram. Atualize o painel antes de confirmar o pagamento.',
          409
        );
      if (expectedPaid !== undefined && expectedPaid !== paid)
        throw new CustomerFinanceError(
          'Essa parcela já foi atualizada em outro dispositivo. Confira o total antes de pagar a próxima.',
          409
        );
      if (paid >= (plan.installmentsTotal ?? 0))
        throw new CustomerFinanceError('Todas as parcelas já estão pagas.', 409);
      const category =
        categories.find((c) => c.id === plan.categoryId && c.type === 'expense' && !c.archived) ??
        categories.find((c) => c.legacyKey === 'other' && c.type === 'expense' && !c.archived);
      if (!category) throw new CustomerFinanceError('Escolha uma categoria de despesa ativa.');
      const transaction = await finance.createTransaction(
        {
          description: `${plan.title} · parcela ${paid + 1}/${plan.installmentsTotal}`.slice(
            0,
            160
          ),
          amount: plan.amount,
          type: 'expense',
          status: 'settled',
          categoryId: category.id,
          date,
          notes: null,
        },
        'planning-payment_' + requestKey
      );
      const updated = await plans.update(id, { ...plan, installmentsPaid: paid + 1 });
      if (!updated) throw new Error('Payment progress not persisted');
      await this.execute(
        'INSERT INTO customer_planning_requests (user_id, request_key, fingerprint, plan_id, transaction_id) VALUES ($1, $2, $3, $4, $5)',
        [this.userId, requestKey, fingerprint, id, transaction.id]
      );
      return { plan: updated, transaction, duplicate: false };
    });
  }
}
