import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  Calendar,
  ChevronRight,
  Edit3,
  Plus,
  Receipt,
  Repeat,
  Target,
  Trash2,
} from '../../components/icons';
import { customerApi } from './api';
import { CustomerDialog, CustomerError } from './components';
import { amountInput, money, parseAmount } from './helpers';
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
): { current: number; maximum: number; label: string } {
  if (plan.kind === 'goal') {
    return { current: plan.progress, maximum: plan.amount, label: 'Guardado manualmente' };
  }
  if (plan.kind === 'budget') {
    return {
      current: summary?.categories.find((entry) => entry.id === plan.categoryId)?.total ?? 0,
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
}) {
  const [open, setOpen] = useState(false);
  const [selectedKind, setSelectedKind] = useState<CustomerPlanKind>('goal');
  const [editing, setEditing] = useState<CustomerPlan | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [removing, setRemoving] = useState<CustomerPlan | null>(null);
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

  const preview = plans
    .filter((plan) => plan.kind === 'goal' || plan.kind === 'budget')
    .slice(0, 2);
  return (
    <>
      <section className="ac-card ac-plan-hub" aria-label="Planejamento pessoal">
        <div className="ac-card-heading">
          <div>
            <p className="ac-eyebrow">UM PASSO DE CADA VEZ</p>
            <h2>Meu planejamento</h2>
            <p>Metas, limites, parcelas e assinaturas em um só espaço.</p>
          </div>
          <Target aria-hidden="true" />
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
                  <span className="ac-plan-preview-progress">
                    <span style={{ width: planPercentage(value.current, value.maximum) + '%' }} />
                  </span>
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
          className="ac-button ac-button--secondary ac-plan-hub-button"
          onClick={() => {
            setMessage(null);
            setOpen(true);
          }}
        >
          {plans.length ? 'Ver meus planejamentos' : 'Organizar meus objetivos'}
          <ChevronRight aria-hidden="true" />
        </button>
      </section>

      {open && !showForm && !removing ? (
        <CustomerDialog title="Meu planejamento" onClose={() => setOpen(false)} wide>
          <p className="ac-muted ac-plan-intro">
            Acompanhe seus objetivos sem alterar o saldo financeiro automaticamente.
          </p>
          <div className="ac-plan-tabs" aria-label="Tipos de planejamento">
            {KINDS.map((item) => (
              <button
                key={item.kind}
                type="button"
                className={selectedKind === item.kind ? 'is-active' : ''}
                aria-pressed={selectedKind === item.kind}
                onClick={() => {
                  setSelectedKind(item.kind);
                  setMessage(null);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="ac-plan-actions">
            <strong>{KINDS.find((item) => item.kind === selectedKind)?.label}</strong>
            <button
              type="button"
              className="ac-button"
              disabled={!canWrite || plans.length >= 80}
              onClick={() => startEdit(selectedKind)}
            >
              <Plus aria-hidden="true" />
              Adicionar
            </button>
          </div>
          {selected.length ? (
            <div className="ac-plan-list">
              {selected.map((plan) => {
                const value = planProgress(plan, summary);
                const percent = planPercentage(value.current, value.maximum);
                return (
                  <div key={plan.id} className="ac-plan-row">
                    <div className="ac-plan-row-heading">
                      <strong>{plan.title}</strong>
                      <span>
                        {plan.kind === 'goal' ? (
                          <Target aria-hidden="true" />
                        ) : plan.kind === 'subscription' ? (
                          <Repeat aria-hidden="true" />
                        ) : plan.kind === 'installment' ? (
                          <Receipt aria-hidden="true" />
                        ) : (
                          <Calendar aria-hidden="true" />
                        )}
                      </span>
                    </div>
                    <p>{hidden ? 'Valores ocultos' : planDescription(plan, summary, false)}</p>
                    {plan.kind !== 'subscription' ? (
                      <div
                        className="ac-plan-progress"
                        role="progressbar"
                        aria-label={value.label}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent}
                      >
                        <span style={{ width: percent + '%' }} />
                      </div>
                    ) : null}
                    <small>
                      {plan.kind === 'budget'
                        ? 'Gasto do período atual, sem lançamentos pendentes'
                        : plan.kind === 'goal'
                          ? 'O valor guardado é informado por você.'
                          : plan.kind === 'installment'
                            ? 'Atualize a quantidade paga quando quiser.'
                            : 'Controle manual de renovação. Nenhuma cobrança automática.'}
                    </small>
                    <div className="ac-plan-row-actions">
                      <button
                        type="button"
                        className="ac-button ac-button--secondary"
                        disabled={!canWrite}
                        onClick={() => startEdit(plan.kind, plan)}
                      >
                        <Edit3 aria-hidden="true" />
                        Editar
                      </button>
                      <button
                        type="button"
                        className="ac-icon-button"
                        aria-label={'Excluir planejamento ' + plan.title}
                        disabled={!canWrite}
                        onClick={() => {
                          setMessage(null);
                          setRemoving(plan);
                          setOpen(false);
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="ac-plan-empty">
              Nenhum registro nesta área ainda.{' '}
              {canWrite ? 'Use Adicionar para começar.' : 'Sua conta está em modo de consulta.'}
            </p>
          )}
        </CustomerDialog>
      ) : null}

      {showForm ? (
        <CustomerDialog
          title={editing ? 'Editar planejamento' : 'Novo planejamento'}
          onClose={closeForm}
          busy={busy}
          footer={
            <>
              <button
                type="button"
                className="ac-button ac-button--secondary"
                disabled={busy}
                onClick={closeForm}
              >
                Cancelar
              </button>
              <button type="submit" form={formId} className="ac-button" disabled={busy}>
                {busy ? 'Salvando…' : 'Salvar'}
              </button>
            </>
          }
        >
          <form id={formId} className="ac-form ac-plan-form" onSubmit={(event) => void save(event)}>
            <label>
              Tipo
              <select
                aria-label="Tipo de planejamento"
                value={selectedKind}
                disabled={busy || !!editing}
                onChange={(event) => {
                  setSelectedKind(event.target.value as CustomerPlanKind);
                  setMessage(null);
                }}
              >
                {KINDS.map((item) => (
                  <option value={item.kind} key={item.kind}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
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
            <label>
              {selectedKind === 'goal'
                ? 'Meta (R$)'
                : selectedKind === 'budget'
                  ? 'Limite por período (R$)'
                  : selectedKind === 'installment'
                    ? 'Valor de cada parcela (R$)'
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
              <label>
                Valor já guardado (R$)
                <input
                  inputMode="decimal"
                  value={progress}
                  disabled={busy}
                  placeholder="0,00"
                  onChange={(event) => setProgress(event.target.value)}
                />
              </label>
            ) : null}
            {selectedKind === 'budget' ? (
              <label>
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
                <label>
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
                <label>
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
              <label>
                Próxima data (opcional)
                <input
                  type="date"
                  value={nextDueDate}
                  disabled={busy}
                  onChange={(event) => setNextDueDate(event.target.value)}
                />
              </label>
            ) : null}
            <label>
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
                className="ac-button ac-button--secondary"
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
                className="ac-button ac-button--danger"
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
