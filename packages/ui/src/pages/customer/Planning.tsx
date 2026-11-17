import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronRight, Edit3, Plus, Trash2 } from '../../components/icons';
import { Flag, ArrowRight, Check } from 'lucide-react';
import {
  ApprovedHeading,
  ApprovedCategoryIcon,
  ApprovedBadge,
  ApprovedEmpty,
} from './approved-finance-ui';
import { customerApi } from './api';
import { CustomerDialog, CustomerError, CustomerTabs } from './components';
import { amountInput, money, parseAmount, dateLabel } from './helpers';
import type {
  CustomerCategory,
  CustomerFinanceSummary,
  CustomerPlan,
  CustomerPlanInput,
  CustomerPlanKind,
} from './types';

const KINDS: { kind: CustomerPlanKind; label: string }[] = [
  { kind: 'goal', label: 'Metas' },
  { kind: 'budget', label: 'Orçamentos' },
  { kind: 'installment', label: 'Parcelas' },
  { kind: 'subscription', label: 'Assinaturas' },
];

export function planPercentage(value: number, target: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / target) * 100)));
}

export function planProgress(
  plan: CustomerPlan,
  summary: CustomerFinanceSummary | null | undefined
): { current: number; maximum: number; label: string } | null {
  if (plan.kind === 'goal') {
    return { current: plan.progress, maximum: plan.amount, label: 'Guardado manualmente' };
  }
  if (plan.kind === 'budget') {
    if (!summary) return null;
    return {
      current: summary.categories.find((entry) => entry.id === plan.categoryId)?.total ?? 0,
      maximum: plan.amount,
      label: 'Gasto realizado no período',
    };
  }
  if (plan.kind === 'installment') {
    return {
      current: plan.installmentsPaid ?? 0,
      maximum: plan.installmentsTotal ?? 1,
      label: 'Parcelas marcadas como pagas',
    };
  }
  return { current: 0, maximum: 1, label: 'Assinatura acompanhada manualmente' };
}

function planDescription(
  plan: CustomerPlan,
  summary: CustomerFinanceSummary | null | undefined,
  hidden: boolean
): string {
  if (plan.kind === 'subscription') {
    return `${money(plan.amount, hidden)} por mês${plan.nextDueDate ? ' · próxima renovação ' + plan.nextDueDate.split('-').reverse().join('/') : ''}`;
  }
  if (plan.kind === 'installment') {
    const remaining = Math.max(0, (plan.installmentsTotal ?? 0) - (plan.installmentsPaid ?? 0));
    return `${remaining} de ${plan.installmentsTotal ?? 0} parcelas restantes · ${money(remaining * plan.amount, hidden)} previsto`;
  }
  const progress = planProgress(plan, summary);
  if (!progress) return 'Gasto do período indisponível';
  return `${money(progress.current, hidden)} de ${money(progress.maximum, hidden)}`;
}

export function CustomerPlanning({
  plans,
  summary,
  categories,
  hidden,
  canWrite,
  loading,
  error,
  onChanged,
  openSignal = 0,
  standalone = false,
  periodControl,
  summaryError,
  onRetrySummary,
}: {
  plans: CustomerPlan[];
  summary: CustomerFinanceSummary | null | undefined;
  categories: CustomerCategory[];
  hidden: boolean;
  canWrite: boolean;
  loading: boolean;
  error?: Error;
  onChanged: (message: string) => void;
  openSignal?: number;
  standalone?: boolean;
  periodControl?: ReactNode;
  summaryError?: Error;
  onRetrySummary?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [selectedKind, setSelectedKind] = useState<CustomerPlanKind>('goal');
  const [editing, setEditing] = useState<CustomerPlan | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [removing, setRemoving] = useState<CustomerPlan | null>(null);
  const [paying, setPaying] = useState<{ plan: CustomerPlan; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [progress, setProgress] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [totalInstallments, setTotalInstallments] = useState('12');
  const [paidInstallments, setPaidInstallments] = useState('0');
  const [nextDueDate, setNextDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [goalIcon, setGoalIcon] = useState<NonNullable<CustomerPlanInput['icon']>>('flag');
  const formId = useId();
  const lock = useRef(false);
  useEffect(() => {
    if (openSignal > 0) {
      setOpen(true);
      setShowForm(false);
      setRemoving(null);
      setMessage(null);
    }
  }, [openSignal]);
  const expenseCategories = categories.filter(
    (category) => category.type === 'expense' && !category.archived
  );
  const selected = plans.filter((plan) => plan.kind === selectedKind);

  const startEdit = (kind: CustomerPlanKind, plan?: CustomerPlan) => {
    if (!canWrite) return;
    setSelectedKind(kind);
    setEditing(plan ?? null);
    setTitle(plan?.title ?? '');
    setAmount(plan ? amountInput(plan.amount) : '');
    setProgress(plan && plan.progress > 0 ? amountInput(plan.progress) : '');
    setCategoryId(plan?.categoryId ?? expenseCategories[0]?.id ?? '');
    setTotalInstallments(String(plan?.installmentsTotal ?? 12));
    setPaidInstallments(String(plan?.installmentsPaid ?? 0));
    setNextDueDate(plan?.nextDueDate ?? '');
    setNotes(plan?.notes ?? '');
    setGoalIcon(plan?.icon ?? 'flag');
    setMessage(null);
    setShowForm(true);
    setOpen(false);
  };

  const closeForm = () => {
    if (busy) return;
    setShowForm(false);
    setOpen(true);
    setMessage(null);
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || lock.current) return;
    const parsedAmount = parseAmount(amount);
    const parsedProgress =
      progress.trim() === '' || /^0(?:,0{1,2})?$/.test(progress.trim()) ? 0 : parseAmount(progress);
    if (
      !title.trim() ||
      parsedAmount === null ||
      (selectedKind === 'goal' && parsedProgress === null)
    ) {
      setMessage('Informe um nome e valores em reais com até duas casas decimais.');
      return;
    }
    if (selectedKind === 'budget' && !categoryId) {
      setMessage('Cadastre ou selecione uma categoria de despesa.');
      return;
    }
    const total = Number(totalInstallments);
    const paid = Number(paidInstallments);
    if (
      selectedKind === 'installment' &&
      (!Number.isInteger(total) ||
        total < 1 ||
        total > 360 ||
        !Number.isInteger(paid) ||
        paid < 0 ||
        paid > total)
    ) {
      setMessage('Confira o total e a quantidade de parcelas já pagas.');
      return;
    }
    if (selectedKind === 'goal' && parsedProgress! > parsedAmount) {
      setMessage('O valor guardado não pode ultrapassar a meta.');
      return;
    }
    const payload: CustomerPlanInput = {
      kind: selectedKind,
      title: title.trim(),
      amount: parsedAmount,
      progress: selectedKind === 'goal' ? parsedProgress! : 0,
      categoryId: selectedKind === 'budget' ? categoryId : null,
      installmentsTotal: selectedKind === 'installment' ? total : null,
      installmentsPaid: selectedKind === 'installment' ? paid : null,
      nextDueDate: nextDueDate || null,
      notes: notes.trim() || null,
      ...(selectedKind === 'goal' ? { icon: goalIcon } : {}),
    };
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      if (editing) await customerApi.updatePlan(editing.id, payload);
      else await customerApi.createPlan(payload);
      setShowForm(false);
      setOpen(true);
      onChanged(editing ? 'Planejamento atualizado.' : 'Planejamento criado.');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Não foi possível salvar o planejamento.'
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function remove() {
    if (!canWrite || !removing || lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await customerApi.deletePlan(removing.id);
      setRemoving(null);
      setOpen(true);
      onChanged('Planejamento excluído.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível excluir.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const cardControls = (plan: CustomerPlan) => (
    <div className="finance-card-controls">
      <button
        className="icon-button"
        type="button"
        aria-label={`Editar planejamento ${plan.title}`}
        disabled={!canWrite}
        onClick={() => startEdit(plan.kind, plan)}
      >
        <Edit3 size={15} />
      </button>
      <button
        className="icon-button"
        type="button"
        aria-label={`Excluir planejamento ${plan.title}`}
        disabled={!canWrite}
        onClick={() => {
          setMessage(null);
          setRemoving(plan);
          setOpen(false);
        }}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
  const markInstallmentPaid = async (plan: CustomerPlan) => {
    if (!canWrite || lock.current || (plan.installmentsPaid ?? 0) >= (plan.installmentsTotal ?? 0))
      return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      if (!paying || paying.plan.id !== plan.id) return;
      await customerApi.payInstallment(
        plan.id,
        plan.installmentsPaid ?? 0,
        paying.key,
        plan.updatedAt
      );
      setPaying(null);
      onChanged('Parcela paga e despesa registrada.');
    } catch (failure) {
      setMessage(
        failure instanceof Error ? failure.message : 'Não foi possível atualizar a parcela.'
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const planningContent = (
    <>
      <div className="panel finance-planning-intro">
        <div className="finance-planning-intro-icon">
          <Flag size={24} />
        </div>
        <div>
          <h2>Seu futuro começa com os planos de hoje.</h2>
          <p>Metas, limites e compromissos que ajudam você a se organizar.</p>
        </div>
        <span className="finance-manual-label">
          <Check size={14} />
          Você no controle
        </span>
      </div>
      <CustomerTabs
        id="customer-planning"
        label="Áreas de planejamento"
        panelId="customer-planning-panel"
        items={KINDS.map((item) => ({ id: item.kind, label: item.label }))}
        value={selectedKind}
        onChange={(value) => {
          setSelectedKind(value);
          setMessage(null);
        }}
      />
      <div
        id="customer-planning-panel"
        role="tabpanel"
        aria-labelledby={`customer-planning-tab-${selectedKind}`}
      >
        {selectedKind === 'budget' && summaryError ? (
          <CustomerError error={summaryError} onRetry={onRetrySummary} />
        ) : null}
        {message && !showForm && !removing ? <CustomerError error={message} /> : null}
        <div className="finance-section-intro">
          <div>
            <h2>
              {selectedKind === 'goal'
                ? 'Suas próximas conquistas'
                : selectedKind === 'budget'
                  ? 'Mais intenção, menos surpresas'
                  : selectedKind === 'installment'
                    ? 'Uma parcela de cada vez'
                    : 'O que se repete merece atenção'}
            </h2>
            <p>
              {selectedKind === 'goal'
                ? 'Valores acompanhados manualmente. Nenhum dinheiro é movimentado.'
                : selectedKind === 'budget'
                  ? 'Limites comparados com as despesas realizadas no período selecionado.'
                  : selectedKind === 'installment'
                    ? 'Acompanhamento manual. As parcelas não geram transações automaticamente.'
                    : 'Organização manual das suas assinaturas. Nenhuma cobrança automática.'}
            </p>
            {selectedKind === 'budget' && periodControl ? (
              <button className="text-button" type="button" onClick={() => setPeriodOpen(true)}>
                Alterar período
              </button>
            ) : null}
          </div>
          {selectedKind === 'goal' ? (
            <span>
              {selected.length} {selected.length === 1 ? 'meta' : 'metas'}
            </span>
          ) : selectedKind === 'subscription' ? (
            <strong>
              {money(
                selected.reduce((total, plan) => total + plan.amount, 0),
                hidden
              )}{' '}
              <small>/ mês</small>
            </strong>
          ) : null}
        </div>
        {selectedKind === 'subscription' ? (
          <section className="panel finance-subscriptions">
            {selected.map((plan) => (
              <div className="finance-subscription-row" key={plan.id}>
                <ApprovedCategoryIcon name="Assinatura" />
                <div className="finance-subscription-name">
                  <strong>{plan.title}</strong>
                  <span>
                    {plan.nextDueDate
                      ? `Próxima renovação ${dateLabel(plan.nextDueDate)}`
                      : 'Renovação acompanhada manualmente'}{' '}
                    · mensal
                  </span>
                </div>
                <ApprovedBadge tone="success">Em acompanhamento</ApprovedBadge>
                <strong>{money(plan.amount, hidden)}</strong>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!canWrite}
                  onClick={() => startEdit(plan.kind, plan)}
                >
                  Atualizar
                </button>
                {cardControls(plan)}
              </div>
            ))}
            {!selected.length ? (
              <ApprovedEmpty
                title="Suas recorrências em um só lugar"
                description="Adicione suas assinaturas para acompanhar seus compromissos mensais."
                action={
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!canWrite}
                    onClick={() => startEdit('subscription')}
                  >
                    Adicionar assinatura
                  </button>
                }
              />
            ) : null}
          </section>
        ) : (
          <div className="finance-planning-grid">
            {selected.map((plan) => {
              const value = planProgress(plan, summary),
                percent = value ? planPercentage(value.current, value.maximum) : undefined,
                category = categories.find((item) => item.id === plan.categoryId),
                current = selectedKind === 'goal' ? plan.progress : value?.current;
              return (
                <article key={plan.id} className="panel finance-goal-card">
                  <div className="finance-category-top">
                    <ApprovedCategoryIcon
                      name={
                        selectedKind === 'goal'
                          ? (plan.icon ?? 'flag')
                          : selectedKind === 'budget'
                            ? category?.name
                            : 'Parcela'
                      }
                      color={category?.color}
                    />
                    {cardControls(plan)}
                  </div>
                  <h3>{selectedKind === 'budget' ? category?.name || plan.title : plan.title}</h3>
                  <div className="finance-goal-values">
                    <strong>
                      {selectedKind === 'installment'
                        ? money(plan.amount, hidden)
                        : current === undefined
                          ? '—'
                          : money(current, hidden)}
                    </strong>
                    <span>
                      {selectedKind === 'installment'
                        ? 'por parcela'
                        : `de ${money(plan.amount, hidden)}`}
                    </span>
                  </div>
                  {value ? (
                    <div
                      className={`finance-progress ${selectedKind === 'budget' && value && value.current >= value.maximum ? 'over' : ''}`}
                      role="progressbar"
                      aria-label={plan.title}
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span style={{ width: `${percent ?? 0}%` }} />
                    </div>
                  ) : null}

                  {selectedKind === 'goal' ? (
                    <>
                      <div className="finance-goal-meta">
                        <span>{hidden ? '••%' : `${percent ?? 0}%`} da meta</span>
                        <span>
                          {plan.progress >= plan.amount
                            ? 'Conquistada!'
                            : `Faltam ${money(plan.amount - plan.progress, hidden)}`}
                        </span>
                      </div>
                      <button
                        className="secondary-button finance-full-button"
                        type="button"
                        disabled={!canWrite}
                        onClick={() => startEdit(plan.kind, plan)}
                      >
                        Atualizar progresso
                        <ArrowRight size={16} />
                      </button>
                    </>
                  ) : selectedKind === 'budget' ? (
                    <>
                      <div className="finance-goal-meta">
                        <span>
                          {!value
                            ? 'Gasto indisponível'
                            : hidden
                              ? '••%'
                              : `${Math.round((value.current / value.maximum) * 100)}% utilizado`}
                        </span>
                        <span
                          className={
                            value && value.current >= value.maximum ? 'negative' : 'positive'
                          }
                        >
                          {!value
                            ? 'Atualize os dados'
                            : value.current >= value.maximum
                              ? `Excedeu ${money(value.current - value.maximum, hidden)}`
                              : `Restam ${money(value.maximum - value.current, hidden)}`}
                        </span>
                      </div>
                      <small className="finance-card-note">
                        Pendências não entram neste cálculo.
                      </small>
                    </>
                  ) : (
                    <>
                      <div className="finance-goal-meta">
                        <span>
                          {plan.installmentsPaid ?? 0} de {plan.installmentsTotal ?? 0} pagas
                        </span>
                        <span>
                          {plan.nextDueDate
                            ? `Vence em ${dateLabel(plan.nextDueDate)}`
                            : 'Sem vencimento definido'}
                        </span>
                      </div>
                      <div className="finance-installment-footer">
                        <span>
                          Restante{' '}
                          <strong>
                            {money(
                              Math.max(
                                0,
                                (plan.installmentsTotal ?? 0) - (plan.installmentsPaid ?? 0)
                              ) * plan.amount,
                              hidden
                            )}
                          </strong>
                        </span>
                        <button
                          className="text-button"
                          type="button"
                          disabled={
                            !canWrite ||
                            busy ||
                            (plan.installmentsPaid ?? 0) >= (plan.installmentsTotal ?? 0)
                          }
                          onClick={() => {
                            setMessage(null);
                            setPaying({ plan, key: crypto.randomUUID() });
                          }}
                        >
                          {(plan.installmentsPaid ?? 0) >= (plan.installmentsTotal ?? 0)
                            ? 'Concluído'
                            : 'Marcar parcela paga'}
                          <Check size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {!selected.length && selectedKind !== 'subscription' ? (
          <div className="panel">
            <ApprovedEmpty
              title={
                selectedKind === 'goal'
                  ? 'Qual será sua próxima conquista?'
                  : selectedKind === 'budget'
                    ? 'Dê um destino ao seu dinheiro'
                    : 'Parcelas organizadas, mente tranquila'
              }
              description={
                selectedKind === 'goal'
                  ? 'Crie uma meta e acompanhe cada passo até chegar lá.'
                  : selectedKind === 'budget'
                    ? 'Defina um limite por categoria e acompanhe os gastos realizados.'
                    : 'Cadastre uma compra para acompanhar quanto já pagou e o que falta.'
              }
              action={
                <button
                  className="primary-button"
                  type="button"
                  disabled={!canWrite}
                  onClick={() => startEdit(selectedKind)}
                >
                  {selectedKind === 'goal'
                    ? 'Criar primeira meta'
                    : selectedKind === 'budget'
                      ? 'Criar orçamento'
                      : 'Adicionar compra'}
                </button>
              }
            />
          </div>
        ) : null}
      </div>
    </>
  );

  const preview = plans
    .filter((plan) => plan.kind === 'goal' || plan.kind === 'budget')
    .slice(0, 2);
  return (
    <>
      {!standalone ? (
        <section className="ac-card ac-plan-hub" aria-label="Planejamento pessoal">
          <div className="ac-card-heading">
            <div>
              <p className="ac-eyebrow">UM PASSO DE CADA VEZ</p>
              <h2>Meu planejamento</h2>
              <p>Metas, limites, parcelas e assinaturas em um só espaço.</p>
            </div>
            <Flag aria-hidden="true" />
          </div>
          {error ? <CustomerError error={error} /> : null}
          {loading && !plans.length ? (
            <p className="ac-muted">Carregando seus planejamentos…</p>
          ) : null}
          {preview.length ? (
            <div className="ac-plan-preview">
              {preview.map((plan) => {
                const value = planProgress(plan, summary);
                return (
                  <button
                    type="button"
                    className="ac-plan-preview-item"
                    key={plan.id}
                    onClick={() => {
                      setSelectedKind(plan.kind);
                      setOpen(true);
                    }}
                  >
                    <span className="ac-plan-preview-title">
                      <strong>{plan.title}</strong>
                      <ChevronRight aria-hidden="true" />
                    </span>
                    {value && (
                      <span className="ac-plan-preview-progress">
                        <span
                          style={{ width: planPercentage(value.current, value.maximum) + '%' }}
                        />
                      </span>
                    )}
                    <small>
                      {hidden ? 'Valores ocultos' : planDescription(plan, summary, false)}
                    </small>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="ac-plan-hub-empty">
              {plans.length
                ? 'Seus parcelamentos e assinaturas já estão organizados.'
                : 'Comece com uma meta ou um orçamento para acompanhar sua evolução.'}
            </p>
          )}
          <button
            type="button"
            className="secondary-button ac-plan-hub-button"
            onClick={() => {
              setMessage(null);
              setOpen(true);
            }}
          >
            {plans.length ? 'Ver meus planejamentos' : 'Organizar meus objetivos'}
            <ChevronRight aria-hidden="true" />
          </button>
        </section>
      ) : (
        <div className="finance-page">
          <ApprovedHeading
            eyebrow="UM PLANO PARA CADA CONQUISTA"
            title="Planejamento"
            description="Transforme seus próximos passos em planos possíveis."
            action={
              <button
                className="primary-button"
                type="button"
                disabled={!canWrite || plans.length >= 80}
                onClick={() => startEdit(selectedKind)}
              >
                <Plus size={18} />
                {selectedKind === 'goal'
                  ? 'Nova meta'
                  : selectedKind === 'budget'
                    ? 'Novo orçamento'
                    : selectedKind === 'installment'
                      ? 'Nova compra'
                      : 'Nova assinatura'}
              </button>
            }
          />
          {error ? <CustomerError error={error} /> : null}
          {loading && !plans.length ? (
            <p role="status" className="ac-muted">
              Carregando seus planejamentos…
            </p>
          ) : null}
          {planningContent}
        </div>
      )}

      {!standalone && open && !showForm && !removing ? (
        <CustomerDialog title="Meu planejamento" onClose={() => setOpen(false)} wide>
          {planningContent}
        </CustomerDialog>
      ) : null}

      {periodOpen && periodControl ? (
        <CustomerDialog title="Período dos orçamentos" onClose={() => setPeriodOpen(false)}>
          {periodControl}
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={() => setPeriodOpen(false)}>
              Concluir
            </button>
          </div>
        </CustomerDialog>
      ) : null}
      {showForm ? (
        <CustomerDialog
          title={`${editing ? 'Editar' : selectedKind === 'budget' ? 'Novo' : 'Nova'} ${selectedKind === 'goal' ? 'meta' : selectedKind === 'budget' ? 'orçamento' : selectedKind === 'installment' ? 'compra' : 'assinatura'}`}

          onClose={closeForm}
          busy={busy}
          footer={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={closeForm}
              >
                Cancelar
              </button>
              <button
                type="submit"
                form={formId}
                className="primary-button"
                disabled={busy || !canWrite}
              >
                {busy
                  ? 'Salvando…'
                  : `Salvar ${selectedKind === 'goal' ? 'meta' : selectedKind === 'budget' ? 'orçamento' : selectedKind === 'installment' ? 'compra' : 'assinatura'}`}
              </button>
            </>
          }
        >
          <form
            id={formId}
            className="approved-finance-form"
            onSubmit={(event) => void save(event)}
          >
            <label className="field">
              Nome
              <input
                required
                maxLength={120}
                value={title}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={
                  selectedKind === 'goal'
                    ? 'Ex.: Reserva de emergência'
                    : selectedKind === 'budget'
                      ? 'Ex.: Alimentação mensal'
                      : selectedKind === 'installment'
                        ? 'Ex.: Parcela do carro'
                        : 'Ex.: Internet'
                }
              />
            </label>
            <div className={selectedKind === 'goal' ? 'form-grid' : undefined}>
              <label className="field">
                {selectedKind === 'goal'
                  ? 'Valor da meta (R$)'
                  : selectedKind === 'budget'
                    ? 'Limite mensal (R$)'
                    : selectedKind === 'installment'
                      ? 'Valor por parcela (R$)'
                      : 'Valor mensal (R$)'}
                <input
                  required
                  inputMode="decimal"
                  value={amount}
                  disabled={busy}
                  placeholder="0,00"
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              {selectedKind === 'goal' ? (
                <label className="field">
                  Valor guardado (R$)
                  <input
                    inputMode="decimal"
                    value={progress}
                    disabled={busy}
                    placeholder="0,00"
                    onChange={(event) => setProgress(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
            {selectedKind === 'goal' ? (
              <label className="field">
                Símbolo da meta
                <select
                  disabled={busy}
                  value={goalIcon}
                  onChange={(event) =>
                    setGoalIcon(event.target.value as NonNullable<CustomerPlanInput['icon']>)
                  }
                >
                  <option value="flag">Conquista</option>
                  <option value="shield">Reserva e segurança</option>
                  <option value="plane">Viagem</option>
                  <option value="laptop">Tecnologia</option>
                  <option value="home">Moradia</option>
                  <option value="education">Educação</option>
                </select>
              </label>
            ) : null}
            {selectedKind === 'budget' ? (
              <label className="field">
                Categoria de despesas
                <select
                  required
                  value={categoryId}
                  disabled={busy}
                  onChange={(event) => setCategoryId(event.target.value)}
                >
                  <option value="">Selecione a categoria</option>
                  {expenseCategories.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {selectedKind === 'installment' ? (
              <div className="ac-plan-form-pair">
                <label className="field">
                  Total de parcelas
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={360}
                    value={totalInstallments}
                    disabled={busy}
                    onChange={(event) => setTotalInstallments(event.target.value)}
                  />
                </label>
                <label className="field">
                  Já pagas
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={360}
                    value={paidInstallments}
                    disabled={busy}
                    onChange={(event) => setPaidInstallments(event.target.value)}
                  />
                </label>
              </div>
            ) : null}
            {selectedKind === 'installment' || selectedKind === 'subscription' ? (
              <label className="field">
                Próxima data (opcional)
                <input
                  type="date"
                  value={nextDueDate}
                  disabled={busy}
                  onChange={(event) => setNextDueDate(event.target.value)}
                />
              </label>
            ) : null}
            <label className="field">
              Observações (opcional)
              <textarea
                rows={2}
                maxLength={500}
                value={notes}
                disabled={busy}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
            <p className="ac-field-help">
              Planejamento manual: não cria cobranças nem altera seus lançamentos.
            </p>
            {message ? (
              <p role="alert" className="ac-field-error">
                {message}
              </p>
            ) : null}
          </form>
        </CustomerDialog>
      ) : null}
      {paying ? (
        <CustomerDialog
          title="Confirmar pagamento da parcela"
          busy={busy}
          onClose={() => {
            if (!busy) setPaying(null);
          }}
          footer={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setPaying(null)}
              >
                Cancelar
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={busy || !canWrite}
                onClick={() => void markInstallmentPaid(paying.plan)}
              >
                Confirmar pagamento
              </button>
            </>
          }
        >
          <p>
            Confirmar a parcela{' '}
            {Math.min((paying.plan.installmentsPaid ?? 0) + 1, paying.plan.installmentsTotal ?? 0)}{' '}
            de <strong>{paying.plan.title}</strong> e registrar uma despesa de{' '}
            <strong>{money(paying.plan.amount, hidden)}</strong>?
          </p>
          {message ? (
            <p className="ac-field-error" role="alert">
              {message}
            </p>
          ) : null}
        </CustomerDialog>
      ) : null}
      {removing ? (
        <CustomerDialog
          title="Excluir planejamento?"
          busy={busy}
          onClose={() => {
            if (!busy) {
              setRemoving(null);
              setOpen(true);
            }
          }}
          footer={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setRemoving(null);
                  setOpen(true);
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button danger-button"
                disabled={busy}
                onClick={() => void remove()}
              >
                Excluir planejamento
              </button>
            </>
          }
        >
          <p>
            Excluir <strong>{removing.title}</strong>? Seus lançamentos financeiros serão mantidos.
          </p>
          {message ? (
            <p role="alert" className="ac-field-error">
              {message}
            </p>
          ) : null}
        </CustomerDialog>
      ) : null}
    </>
  );
}
