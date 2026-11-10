import { useId, useRef, useState, type FormEvent } from 'react';
import { Archive, Check, ChevronRight, Edit3, Plus, Trash2 } from '../../components/icons';
import { customerApi } from './api';
import {
  CustomerDialog,
  CustomerEmpty,
  CustomerError,
  CustomerSkeleton,
  PeriodPicker,
} from './components';
import { categoryColor, money, validPeriod } from './helpers';
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
  const summary = useCustomerQuery(
    `categories:${period.from}:${period.to}`,
    (signal) => customerApi.summary(period, signal),
    active && validPeriod(period),
    revision
  );
  const [editor, setEditor] = useState<{ category?: CustomerCategory } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  return (
    <div className="ac-page">
      <header className="ac-page-heading">
        <div>
          <p className="ac-eyebrow">ENTENDA SEUS HÁBITOS</p>
          <h1>Categorias</h1>
          <p>Veja para onde seu dinheiro está indo.</p>
        </div>
        <button
          className="ac-button"
          type="button"
          disabled={!customer.access.canWrite}
          onClick={() => setEditor({})}
        >
          <Plus aria-hidden="true" />
          Nova categoria
        </button>
      </header>
      <PeriodPicker value={period} onChange={onPeriod} timeZone={customer.timeZone} />
      <section className="ac-card">
        <div className="ac-card-heading">
          <div>
            <h2>Distribuição das despesas</h2>
            <p>Toque em uma categoria para conferir seus registros.</p>
          </div>
          {summary.data ? (
            <strong className="ac-section-total">
              {money(summary.data.expenses, customer.hideAmounts)}
            </strong>
          ) : null}
        </div>
        {summary.error ? <CustomerError error={summary.error} onRetry={summary.retry} /> : null}
        {summary.loading && !summary.data ? (
          <CustomerSkeleton />
        ) : summary.data?.categories.length ? (
          <ul className="ac-distribution">
            {summary.data.categories.map((category) => (
              <li key={category.id}>
                <button
                  type="button"
                  onClick={() =>
                    onDrillDown({
                      ...period,
                      type: 'expense',
                      status: 'settled',
                      categoryId: category.id,
                    })
                  }
                >
                  <span className="ac-distribution-top">
                    <span>
                      <i style={{ backgroundColor: categoryColor(category.color) }} />
                      {category.name}
                    </span>
                    <strong>{money(category.total, customer.hideAmounts)}</strong>
                    <ChevronRight aria-hidden="true" />
                  </span>
                  <span className="ac-distribution-track">
                    <span
                      style={{
                        width: `${Math.min(100, Math.max(0, category.percentage))}%`,
                        backgroundColor: categoryColor(category.color),
                      }}
                    />
                  </span>
                  <small>
                    {customer.hideAmounts
                      ? 'Participação oculta'
                      : `${category.percentage.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% das despesas realizadas`}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        ) : summary.data ? (
          <CustomerEmpty title="Ainda não há despesas realizadas">
            As categorias ganham forma conforme você registra e organiza suas despesas.
          </CustomerEmpty>
        ) : null}
      </section>
      <section className="ac-card">
        <div className="ac-card-heading">
          <div>
            <h2>Suas categorias</h2>
            <p>Renomear mantém os registros vinculados.</p>
          </div>
          <label className="ac-checkbox-label">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Mostrar arquivadas
          </label>
        </div>
        {categoriesError ? (
          <CustomerError error={categoriesError} onRetry={retryCategories} />
        ) : categoriesLoading && !categories.length ? (
          <CustomerSkeleton />
        ) : (
          <ul className="ac-category-manager">
            {categories
              .filter((category) => showArchived || !category.archived)
              .map((category) => (
                <li key={category.id}>
                  <span
                    className="ac-category-swatch"
                    style={{ backgroundColor: categoryColor(category.color) }}
                  />
                  <div>
                    <strong>{category.name}</strong>
                    <span>
                      {category.type === 'expense' ? 'Despesas' : 'Entradas'}
                      {category.archived ? ' · Arquivada' : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ac-icon-button"
                    aria-label={'Editar categoria ' + category.name}
                    disabled={!customer.access.canWrite}
                    onClick={() => setEditor({ category })}
                  >
                    <Edit3 aria-hidden="true" />
                  </button>
                </li>
              ))}
          </ul>
        )}
      </section>
      {editor ? (
        <CategoryEditor
          canWrite={customer.access.canWrite}
          category={editor.category}
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
  categories,
  onClose,
  onChanged,
}: {
  canWrite: boolean;
  category?: CustomerCategory;
  categories: CustomerCategory[];
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(category?.name ?? '');
  const [type, setType] = useState<'income' | 'expense'>(category?.type ?? 'expense');
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
          <button
            className="ac-button ac-button--secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            className={'ac-button' + (removing ? ' ac-button--danger' : '')}
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
      <form id={id} className="ac-form" onSubmit={submit} aria-busy={busy} noValidate>
        <fieldset disabled={busy || !canWrite}>
          {removing ? (
            <>
              <p className="ac-body-copy">
                Escolha outra categoria para receber os registros de “{category?.name}”. Sem um
                destino, uma categoria em uso será arquivada para preservar seu histórico.
              </p>
              <label>
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
              <label>
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
              <div className="ac-form-grid">
                <label>
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
                <label>
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
                    className="ac-button ac-button--quiet ac-danger-text"
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
