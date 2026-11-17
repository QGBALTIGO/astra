import { useId, useRef, useState, type FormEvent } from 'react';
import { Archive, Check, ChevronRight, Edit3, Plus, Trash2 } from '../../components/icons';
import { ArrowRight, RotateCcw } from 'lucide-react';
import {
  ApprovedHeading,
  ApprovedCategoryIcon,
  ApprovedBadge,
  ApprovedEmpty,
  collectCustomerTransactions,
} from './approved-finance-ui';
import { customerApi } from './api';
import { CustomerDialog, CustomerError, CustomerSkeleton, PeriodPicker } from './components';
import { categoryColor, money, validPeriod, periodLabel } from './helpers';
import { useCustomerQuery } from './hooks';
import type {
  Customer,
  CustomerCategory,
  CustomerPeriod,
  CustomerTransactionFilters,
} from './types';

export function CustomerCategories({
  customer,
  active,
  revision,
  period,
  onPeriod,
  categories,
  categoriesError,
  retryCategories,
  categoriesLoading,
  onChanged,
  onDrillDown,
}: {
  customer: Customer;
  active: boolean;
  revision: number;
  period: CustomerPeriod;
  onPeriod: (period: CustomerPeriod) => void;
  categories: CustomerCategory[];
  categoriesError?: Error;
  retryCategories: () => void;
  categoriesLoading: boolean;
  onChanged: (message: string) => void;
  onDrillDown: (filters: Partial<CustomerTransactionFilters>) => void;
}) {
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [periodOpen, setPeriodOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const archiveLock = useRef(false);
  const transactions = useCustomerQuery(
    `category-transactions:${period.from}:${period.to}:${type}`,
    (signal) => collectCustomerTransactions({ ...period, type, page: 1, pageSize: 100 }, signal),
    active && validPeriod(period),
    revision
  );
  const [editor, setEditor] = useState<{ category?: CustomerCategory } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const totals = categories
    .filter((category) => category.type === type)
    .map((category) => ({
      ...category,
      total:
        transactions.data
          ?.filter((row) => row.categoryId === category.id && row.status === 'settled')
          .reduce((sum, row) => sum + row.amount, 0) ?? 0,
    }))
    .sort((a, b) => b.total - a.total);
  const total = totals.reduce((sum, category) => sum + category.total, 0);
  const shown = categories.filter(
    (category) => category.type === type && (showArchived || !category.archived)
  );
  const inspect = (categoryId: string) =>
    onDrillDown({ ...period, type, status: 'settled', categoryId });
  const archive = async (category: CustomerCategory) => {
    if (!customer.access.canWrite || archiveLock.current) return;
    archiveLock.current = true;
    setArchiveBusy(category.id);
    setArchiveError(null);
    try {
      await customerApi.updateCategory(category.id, { archived: !category.archived });
      onChanged(
        category.archived
          ? 'Categoria restaurada.'
          : 'Categoria arquivada. Seu histórico foi preservado.'
      );
    } catch (failure) {
      setArchiveError(
        failure instanceof Error ? failure.message : 'Não foi possível atualizar a categoria.'
      );
    } finally {
      archiveLock.current = false;
      setArchiveBusy(null);
    }
  };
  let offset = 0;
  return (
    <div className="finance-page">
      <ApprovedHeading
        eyebrow="CADA COISA EM SEU LUGAR"
        title="Categorias"
        description="Organize seus movimentos do seu jeito. Enxergue o que mais importa."
        action={
          <button
            className="primary-button"
            type="button"
            disabled={!customer.access.canWrite}
            onClick={() => setEditor({})}
          >
            <Plus size={18} />
            Nova categoria
          </button>
        }
      />
      {categoriesError ? <CustomerError error={categoriesError} onRetry={retryCategories} /> : null}
      {archiveError ? <CustomerError error={archiveError} /> : null}
      <div className="finance-categories-layout">
        <section className="panel finance-distribution">
          <div className="section-heading">
            <div>
              <h2>{type === 'expense' ? 'Para onde vai o dinheiro' : 'De onde vem o dinheiro'}</h2>
              <p>Distribuição dos valores realizados</p>
            </div>
          </div>
          {transactions.error ? (
            <CustomerError error={transactions.error} onRetry={transactions.retry} />
          ) : transactions.loading && !transactions.data ? (
            <CustomerSkeleton />
          ) : transactions.data && total > 0 ? (
            <>
              <div className="finance-donut">
                <svg
                  viewBox="0 0 240 240"
                  role="img"
                  aria-label={`Distribuição de ${type === 'expense' ? 'despesas' : 'entradas'} realizadas por categoria`}
                >
                  <circle
                    cx="120"
                    cy="120"
                    r="94"
                    fill="none"
                    stroke="var(--line)"
                    strokeWidth="24"
                  />
                  {totals
                    .filter((category) => category.total > 0)
                    .map((category) => {
                      const percentage = category.total / total,
                        oldOffset = offset;
                      offset += percentage * 590.62;
                      return (
                        <circle
                          key={category.id}
                          cx="120"
                          cy="120"
                          r="94"
                          fill="none"
                          stroke={categoryColor(category.color)}
                          strokeWidth="24"
                          strokeDasharray={`${Math.max(0, percentage * 590.62 - 4)} 590.62`}
                          strokeDashoffset={-oldOffset}
                          transform="rotate(-90 120 120)"
                        >
                          <title>
                            {category.name}: {money(category.total, customer.hideAmounts)} (
                            {(percentage * 100).toFixed(1)}%)
                          </title>
                        </circle>
                      );
                    })}
                </svg>
                <div>
                  <span>Total realizado</span>
                  <strong>{money(total, customer.hideAmounts)}</strong>
                  <small>
                    <button
                      className="text-button"
                      type="button"
                      aria-label="Escolher período das categorias"
                      onClick={() => setPeriodOpen(true)}
                    >
                      {periodLabel(period)}
                    </button>
                  </small>
                </div>
              </div>
              <div className="finance-distribution-legend">
                {totals
                  .filter((category) => category.total > 0)
                  .map((category) => (
                    <button key={category.id} type="button" onClick={() => inspect(category.id)}>
                      <span
                        className="finance-color-dot"
                        style={{ background: categoryColor(category.color) }}
                      />
                      <span>{category.name}</span>
                      <strong>
                        {customer.hideAmounts
                          ? '••%'
                          : `${Math.round((category.total / total) * 100)}%`}
                      </strong>
                      <ChevronRight size={14} />
                    </button>
                  ))}
              </div>
            </>
          ) : transactions.data ? (
            <ApprovedEmpty
              title="Um novo olhar para seus registros"
              description="A distribuição aparece assim que você tiver movimentações realizadas."
              action={
                <button className="text-button" type="button" onClick={() => setPeriodOpen(true)}>
                  Escolher período
                </button>
              }
            />
          ) : null}
        </section>
        <section className="finance-category-manager">
          <div className="finance-category-header">
            <div
              className="segmented-control ac-segmented tabs"
              role="group"
              aria-label="Tipo de categoria"
            >
              <button
                type="button"
                className={type === 'expense' ? 'active' : ''}
                aria-pressed={type === 'expense'}
                onClick={() => setType('expense')}
              >
                Despesas
              </button>
              <button
                type="button"
                className={type === 'income' ? 'active' : ''}
                aria-pressed={type === 'income'}
                onClick={() => setType('income')}
              >
                Entradas
              </button>
            </div>
            <label className="finance-checkbox">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              Incluir arquivadas
            </label>
          </div>
          {categoriesLoading && !categories.length ? (
            <CustomerSkeleton />
          ) : (
            <div className="finance-category-grid">
              {shown.map((category) => {
                const spent = totals.find((value) => value.id === category.id)?.total ?? 0,
                  count = transactions.data?.filter((row) => row.categoryId === category.id).length;
                return (
                  <article
                    className={`panel finance-category-card ${category.archived ? 'archived' : ''}`}
                    key={category.id}
                  >
                    <div className="finance-category-top">
                      <ApprovedCategoryIcon
                        name={category.name}
                        color={categoryColor(category.color)}
                      />
                      <div className="finance-card-controls">
                        <button
                          className="icon-button"
                          type="button"
                          aria-label={`Editar categoria ${category.name}`}
                          disabled={!customer.access.canWrite}
                          onClick={() => setEditor({ category })}
                        >
                          <Edit3 size={15} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          aria-label={`${category.archived ? 'Restaurar' : 'Arquivar'} ${category.name}`}
                          disabled={!customer.access.canWrite || archiveBusy !== null}
                          onClick={() => void archive(category)}
                        >
                          {category.archived ? <RotateCcw size={15} /> : <Archive size={15} />}
                        </button>
                      </div>
                    </div>
                    <h3>
                      {category.name}
                      {category.archived ? <ApprovedBadge>Arquivada</ApprovedBadge> : null}
                    </h3>
                    <strong className="finance-category-total">
                      {transactions.data ? money(spent, customer.hideAmounts) : '—'}
                    </strong>
                    <div className="finance-category-progress">
                      <span
                        style={{
                          width: `${total ? (spent / total) * 100 : 0}%`,
                          background: categoryColor(category.color),
                        }}
                      />
                    </div>
                    <div className="finance-category-bottom">
                      <span>
                        {count === undefined ? '—' : count}{' '}
                        {count === 1 ? 'transação' : 'transações'}
                      </span>
                      <button
                        className="text-button"
                        type="button"
                        aria-label={`Ver movimentações de ${category.name}`}
                        onClick={() => inspect(category.id)}
                      >
                        <ArrowRight size={17} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {!categoriesLoading && !shown.length ? (
            <div className="panel">
              <ApprovedEmpty
                title="Sua organização, suas categorias"
                description="Crie categorias com nomes e cores que fazem sentido para você."
                action={
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!customer.access.canWrite}
                    onClick={() => setEditor({})}
                  >
                    Criar categoria
                  </button>
                }
              />
            </div>
          ) : null}
        </section>
      </div>
      {periodOpen ? (
        <CustomerDialog title="Período das categorias" onClose={() => setPeriodOpen(false)}>
          <PeriodPicker value={period} onChange={onPeriod} timeZone={customer.timeZone} />
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={() => setPeriodOpen(false)}>
              Concluir
            </button>
          </div>
        </CustomerDialog>
      ) : null}
      {editor ? (
        <CategoryEditor
          canWrite={customer.access.canWrite}
          category={editor.category}
          initialType={type}
          categories={categories}
          onClose={() => setEditor(null)}
          onChanged={(message) => {
            setEditor(null);
            onChanged(message);
          }}
        />
      ) : null}
    </div>
  );
}

function CategoryEditor({
  canWrite,
  category,
  initialType = 'expense',
  categories,
  onClose,
  onChanged,
}: {
  canWrite: boolean;
  category?: CustomerCategory;
  initialType?: 'income' | 'expense';
  categories: CustomerCategory[];
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(category?.name ?? '');
  const [type, setType] = useState<'income' | 'expense'>(category?.type ?? initialType);
  const [color, setColor] = useState(categoryColor(category?.color));
  const [archived, setArchived] = useState(category?.archived ?? false);
  const [removing, setRemoving] = useState(false);
  const [transferToId, setTransferToId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || !canWrite) return;
    if (!removing && (!name.trim() || !/^#[\da-f]{6}$/i.test(color))) {
      setError('Informe o nome e uma cor válida para a categoria.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (removing && category) {
        const result = await customerApi.deleteCategory(category.id, transferToId || undefined);
        onChanged(
          result.archived
            ? 'Categoria arquivada. Seu histórico foi preservado.'
            : transferToId
              ? 'Registros transferidos e categoria removida.'
              : 'Categoria removida.'
        );
      } else if (category) {
        await customerApi.updateCategory(category.id, { name: name.trim(), color, archived });
        onChanged('Categoria atualizada.');
      } else {
        await customerApi.createCategory({ name: name.trim(), type, color });
        onChanged('Categoria criada.');
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Não foi possível atualizar a categoria.'
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <CustomerDialog
      title={removing ? 'Remover categoria' : category ? 'Editar categoria' : 'Nova categoria'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button
            className={'primary-button' + (removing ? ' danger-button' : '')}
            type="submit"
            form={id}
            disabled={busy || !canWrite}
          >
            {busy
              ? 'Salvando…'
              : removing
                ? transferToId
                  ? 'Transferir e remover'
                  : 'Remover categoria'
                : 'Salvar categoria'}
          </button>
        </>
      }
    >
      <form id={id} className="approved-finance-form" onSubmit={submit} aria-busy={busy} noValidate>
        <fieldset disabled={busy || !canWrite}>
          {removing ? (
            <>
              <p className="ac-body-copy">
                Escolha outra categoria para receber os registros de “{category?.name}”. Sem um
                destino, uma categoria em uso será arquivada para preservar seu histórico.
              </p>
              <label className="field">
                Transferir os registros para
                <select
                  value={transferToId}
                  onChange={(event) => setTransferToId(event.target.value)}
                >
                  <option value="">Não transferir; preservar o histórico</option>
                  {categories
                    .filter(
                      (item) =>
                        item.id !== category?.id && item.type === category?.type && !item.archived
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <button className="ac-text-button" type="button" onClick={() => setRemoving(false)}>
                Voltar à edição
              </button>
            </>
          ) : (
            <>
              <label className="field">
                Nome da categoria
                <input
                  name="categoryName"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={80}
                  placeholder="Ex.: Alimentação"
                />
              </label>
              <div className="form-grid">
                <label className="field">
                  Tipo
                  <select
                    value={type}
                    disabled={Boolean(category)}
                    onChange={(event) => setType(event.target.value as 'income' | 'expense')}
                  >
                    <option value="expense">Despesas</option>
                    <option value="income">Entradas</option>
                  </select>
                </label>
                <label className="field">
                  Cor
                  <input
                    type="color"
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    aria-label="Cor da categoria"
                  />
                </label>
              </div>
              {category ? (
                <>
                  <label className="ac-checkbox-label">
                    <input
                      type="checkbox"
                      checked={archived}
                      onChange={(event) => setArchived(event.target.checked)}
                    />
                    <Archive aria-hidden="true" />
                    Arquivar categoria
                  </label>
                  <p className="ac-field-help">
                    Os registros continuam no histórico. Categorias arquivadas não aparecem em novas
                    transações.
                  </p>
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() => setRemoving(true)}
                  >
                    <Trash2 aria-hidden="true" />
                    Remover ou transferir registros
                  </button>
                </>
              ) : (
                <p className="ac-field-help">
                  <Check aria-hidden="true" />A categoria também será usada nos seus registros pelo
                  WhatsApp.
                </p>
              )}
            </>
          )}
        </fieldset>
        {error ? <CustomerError error={error} /> : null}
      </form>
    </CustomerDialog>
  );
}
