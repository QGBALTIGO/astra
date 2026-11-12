import { useId, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Filter,
  Plus,
  Receipt,
  Search,
  Trash2,
} from '../../components/icons';
import { customerApi } from './api';
import {
  CustomerConfirm,
  CustomerDialog,
  CustomerEmpty,
  CustomerError,
  CustomerSkeleton,
  PeriodPicker,
  SourceLabel,
} from './components';
import {
  amountInput,
  categoryColor,
  dateInZone,
  dateLabel,
  money,
  parseAmount,
  transactionStatus,
  validDate,
  validPeriod,
} from './helpers';
import { useCustomerQuery } from './hooks';
import type {
  Customer,
  CustomerCategory,
  CustomerTransaction,
  CustomerTransactionFilters,
  TransactionInput,
} from './types';

export function TransactionRows({
  transactions,
  hidden,
  onOpen,
}: {
  transactions: CustomerTransaction[];
  hidden: boolean;
  onOpen: (transaction: CustomerTransaction) => void;
}) {
  return (
    <ul className="ac-transactions">
      {transactions.map((item) => (
        <li key={item.id}>
          <button type="button" className="ac-transaction" onClick={() => onOpen(item)}>
            <span className={'ac-transaction-icon ac-transaction-icon--' + item.type}>
              <Receipt aria-hidden="true" />
            </span>
            <span className="ac-transaction-info">
              <strong>{item.description}</strong>
              <span>
                <span
                  className="ac-category-dot"
                  style={{ backgroundColor: categoryColor(item.categoryColor) }}
                />
                {item.categoryName}
                <span aria-hidden="true"> · </span>
                {dateLabel(item.date)}
              </span>
            </span>
            <span className="ac-transaction-value">
              <strong className={item.type === 'income' ? 'ac-income-text' : ''}>
                {item.type === 'income' ? '+ ' : '− '}
                {money(item.amount, hidden)}
              </strong>
              <span className={'ac-status ac-status--' + item.status}>
                {transactionStatus(item)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface TransactionsProps {
  customer: Customer;
  active: boolean;
  revision: number;
  categories: CustomerCategory[];
  categoriesError?: Error;
  retryCategories: () => void;
  filters: CustomerTransactionFilters;
  onFilters: (filters: CustomerTransactionFilters) => void;
  onChanged: (message: string) => void;
  openCreate: boolean;
  onCreateHandled: () => void;
}
export function CustomerTransactions({
  customer,
  active,
  revision,
  categories,
  categoriesError,
  retryCategories,
  filters,
  onFilters,
  onChanged,
  openCreate,
  onCreateHandled,
}: TransactionsProps) {
  const [selected, setSelected] = useState<CustomerTransaction | null>(null);
  const [create, setCreate] = useState(false);
  const [moreFilters, setMoreFilters] = useState(false);
  const response = useCustomerQuery(
    `transactions:${JSON.stringify(filters)}`,
    (signal) => customerApi.transactions(filters, signal),
    active && validPeriod(filters),
    revision
  );
  const setFilter = (change: Partial<CustomerTransactionFilters>) =>
    onFilters({ ...filters, ...change, page: 1 });
  const closeCreate = () => {
    setCreate(false);
    onCreateHandled();
  };
  const canWrite = customer.access.canWrite;
  return (
    <div className="ac-page">
      <header className="ac-page-heading">
        <div>
          <p className="ac-eyebrow">SEU DINHEIRO, EM ORDEM</p>
          <h1>Transações</h1>
          <p>Confira e ajuste o que você registra no Astra.</p>
        </div>
        <button
          className="ac-button"
          type="button"
          disabled={!canWrite}
          onClick={() => setCreate(true)}
        >
          <Plus aria-hidden="true" />
          Adicionar
        </button>
      </header>
      <PeriodPicker
        value={filters}
        timeZone={customer.timeZone}
        onChange={(period) => setFilter(period)}
      />
      <section className="ac-card ac-card--flush" aria-label="Transações do período">
        <div className="ac-filter-bar">
          <form
            className="ac-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              response.retry();
            }}
          >
            <Search aria-hidden="true" />
            <label className="ac-sr-only" htmlFor="customer-transaction-search">
              Buscar transações
            </label>
            <input
              id="customer-transaction-search"
              type="search"
              placeholder="Buscar descrição"
              maxLength={160}
              value={filters.search ?? ''}
              onChange={(event) => setFilter({ search: event.target.value || undefined })}
            />
            <button type="submit" className="ac-button ac-button--quiet">
              Buscar
            </button>
          </form>
          <button
            type="button"
            className="ac-button ac-button--secondary"
            aria-expanded={moreFilters}
            onClick={() => setMoreFilters((value) => !value)}
          >
            <Filter aria-hidden="true" />
            Filtros
            {filters.categoryId || filters.status ? <span className="ac-filter-indicator" /> : null}
          </button>
        </div>
        <div className="ac-segmented" aria-label="Tipo de transação">
          {(
            [
              ['', 'Todas'],
              ['income', 'Entradas'],
              ['expense', 'Despesas'],
            ] as const
          ).map(([type, label]) => (
            <button
              key={type}
              type="button"
              aria-pressed={(filters.type ?? '') === type}
              onClick={() => setFilter({ type: type || undefined, categoryId: undefined })}
            >
              {label}
            </button>
          ))}
        </div>
        {moreFilters || filters.categoryId || filters.status ? (
          <div className="ac-filter-fields">
            <label>
              Categoria
              <select
                value={filters.categoryId ?? ''}
                onChange={(event) => setFilter({ categoryId: event.target.value || undefined })}
              >
                <option value="">Todas as categorias</option>
                {categories
                  .filter((category) => !filters.type || category.type === filters.type)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                      {category.archived ? ' (arquivada)' : ''}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Situação
              <select
                value={filters.status ?? ''}
                onChange={(event) =>
                  setFilter({
                    status:
                      (event.target.value as CustomerTransactionFilters['status']) || undefined,
                  })
                }
              >
                <option value="">Todas as situações</option>
                <option value="settled">Realizadas</option>
                <option value="pending">Pendentes</option>
              </select>
            </label>
            <button
              type="button"
              className="ac-button ac-button--quiet"
              onClick={() => {
                setFilter({
                  type: undefined,
                  status: undefined,
                  categoryId: undefined,
                  search: undefined,
                });
              }}
            >
              Limpar filtros
            </button>
          </div>
        ) : null}
        {categoriesError ? (
          <CustomerError error={categoriesError} onRetry={retryCategories} />
        ) : null}
        {response.error ? <CustomerError error={response.error} onRetry={response.retry} /> : null}
        {response.loading && !response.data ? (
          <CustomerSkeleton />
        ) : response.data ? (
          <>
            <div className="ac-list-caption" aria-live="polite">
              {response.data.total} {response.data.total === 1 ? 'movimentação' : 'movimentações'}
              {response.loading ? ' · Atualizando…' : ''}
            </div>
            {response.data.transactions.length ? (
              <TransactionRows
                transactions={response.data.transactions}
                hidden={customer.hideAmounts}
                onOpen={setSelected}
              />
            ) : (
              <CustomerEmpty title="Nenhuma transação neste período">
                Registre pelo WhatsApp ou adicione uma movimentação aqui. Você também pode ajustar
                os filtros.
              </CustomerEmpty>
            )}
            <div className="ac-pagination">
              <span>
                Página {response.data.page} de{' '}
                {Math.max(1, Math.ceil(response.data.total / response.data.pageSize))}
              </span>
              <button
                type="button"
                className="ac-icon-button"
                aria-label="Página anterior"
                disabled={filters.page <= 1 || response.loading}
                onClick={() => onFilters({ ...filters, page: filters.page - 1 })}
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <button
                type="button"
                className="ac-icon-button"
                aria-label="Próxima página"
                disabled={
                  filters.page * filters.pageSize >= response.data.total || response.loading
                }
                onClick={() => onFilters({ ...filters, page: filters.page + 1 })}
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          </>
        ) : null}
      </section>
      {selected ? (
        <TransactionDetail
          transaction={selected}
          customer={customer}
          categories={categories}
          onClose={() => setSelected(null)}
          onChanged={(message) => {
            setSelected(null);
            onChanged(message);
          }}
        />
      ) : null}
      {create || openCreate ? (
        <TransactionEditor
          customer={customer}
          categories={categories}
          initialStatus={openCreate ? filters.status : undefined}
          onClose={closeCreate}
          onSaved={() => {
            closeCreate();
            onChanged('Transação adicionada.');
          }}
        />
      ) : null}
    </div>
  );
}

export function TransactionDetail({
  transaction,
  customer,
  categories,
  onClose,
  onChanged,
}: {
  transaction: CustomerTransaction;
  customer: Customer;
  categories: CustomerCategory[];
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const remove = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await customerApi.deleteTransaction(transaction.id);
      onChanged('Transação excluída.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível excluir.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (editing)
    return (
      <TransactionEditor
        transaction={transaction}
        customer={customer}
        categories={categories}
        onClose={() => setEditing(false)}
        onSaved={() => onChanged('Transação atualizada.')}
      />
    );
  if (deleting)
    return (
      <CustomerConfirm
        title="Excluir transação?"
        action="Excluir transação"
        onClose={() => setDeleting(false)}
        onConfirm={() => void remove()}
        busy={busy}
        error={error}
      >
        A movimentação “{transaction.description}” será removida dos seus registros e dos totais do
        Astra.
      </CustomerConfirm>
    );
  return (
    <CustomerDialog
      title="Detalhes da transação"
      onClose={onClose}
      footer={
        customer.access.canWrite ? (
          <>
            <button
              className="ac-button ac-button--quiet ac-danger-text"
              type="button"
              onClick={() => setDeleting(true)}
            >
              <Trash2 aria-hidden="true" />
              Excluir
            </button>
            <button className="ac-button" type="button" onClick={() => setEditing(true)}>
              <Edit3 aria-hidden="true" />
              {customer.hideAmounts ? 'Editar e mostrar valor' : 'Editar'}
            </button>
          </>
        ) : (
          <button className="ac-button ac-button--secondary" type="button" onClick={onClose}>
            Fechar
          </button>
        )
      }
    >
      <div className="ac-detail-hero">
        <span className={'ac-status ac-status--' + transaction.status}>
          {transactionStatus(transaction)}
        </span>
        <h3>{transaction.description}</h3>
        <p className="ac-detail-amount">{money(transaction.amount, customer.hideAmounts)}</p>
      </div>
      <dl className="ac-detail-grid">
        <div>
          <dt>Tipo</dt>
          <dd>{transaction.type === 'expense' ? 'Despesa' : 'Entrada'}</dd>
        </div>
        <div>
          <dt>Data</dt>
          <dd>{dateLabel(transaction.date)}</dd>
        </div>
        <div>
          <dt>Categoria</dt>
          <dd>{transaction.categoryName}</dd>
        </div>
        <div>
          <dt>Origem</dt>
          <dd>
            <SourceLabel source={transaction.source} />
          </dd>
        </div>
      </dl>
      {transaction.notes ? (
        <div className="ac-notes">
          <h4>Observações</h4>
          <p>{transaction.notes}</p>
        </div>
      ) : null}
    </CustomerDialog>
  );
}

function TransactionEditor({
  transaction,
  customer,
  categories,
  initialStatus,
  onClose,
  onSaved,
}: {
  transaction?: CustomerTransaction;
  customer: Customer;
  categories: CustomerCategory[];
  initialStatus?: 'pending' | 'settled';
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [amount, setAmount] = useState(transaction ? amountInput(transaction.amount) : '');
  const [type, setType] = useState<'income' | 'expense'>(transaction?.type ?? 'expense');
  const [status, setStatus] = useState<'settled' | 'pending'>(
    transaction?.status ?? initialStatus ?? 'settled'
  );
  const [categoryId, setCategoryId] = useState(transaction?.categoryId ?? '');
  const [date, setDate] = useState(transaction?.date ?? dateInZone(new Date(), customer.timeZone));
  const [notes, setNotes] = useState(transaction?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const requestKey = useRef(crypto.randomUUID());
  const allowedCategories = categories.filter(
    (category) =>
      category.type === type && (!category.archived || category.id === transaction?.categoryId)
  );
  const selectedCategory = allowedCategories.some((category) => category.id === categoryId)
    ? categoryId
    : (allowedCategories[0]?.id ?? '');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || !customer.access.canWrite) return;
    const value = parseAmount(amount);
    if (!description.trim() || !value || !validDate(date) || !selectedCategory) {
      setError(
        'Preencha descrição, valor válido em reais, categoria e data. Use vírgula para os centavos.'
      );
      return;
    }
    const body: TransactionInput = {
      description: description.trim(),
      amount: value,
      type,
      status,
      categoryId: selectedCategory,
      date,
      notes: notes.trim() || null,
    };
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (transaction) await customerApi.updateTransaction(transaction.id, body);
      else await customerApi.createTransaction(body, requestKey.current);
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível salvar a transação.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <CustomerDialog
      title={transaction ? 'Editar transação' : 'Adicionar transação'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button
            className="ac-button ac-button--secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            <ArrowLeft aria-hidden="true" />
            Cancelar
          </button>
          <button
            className="ac-button"
            form={id}
            type="submit"
            disabled={busy || !customer.access.canWrite || !selectedCategory}
          >
            <Check aria-hidden="true" />
            {busy ? 'Salvando…' : 'Salvar transação'}
          </button>
        </>
      }
    >
      <form id={id} className="ac-form" onSubmit={submit} noValidate aria-busy={busy}>
        <fieldset disabled={busy}>
          <label>
            Descrição
            <input
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={160}
              required
              placeholder="Ex.: Almoço, salário, mercado"
            />
          </label>
          <div className="ac-form-grid">
            <label>
              Valor (R$)
              <input
                name="amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0,00"
                maxLength={20}
                required
              />
            </label>
            <label>
              Tipo
              <select
                value={type}
                onChange={(event) => {
                  setType(event.target.value as 'income' | 'expense');
                  setCategoryId('');
                }}
              >
                <option value="expense">Despesa</option>
                <option value="income">Entrada</option>
              </select>
            </label>
          </div>
          <div className="ac-form-grid">
            <label>
              Categoria
              <select
                value={selectedCategory}
                onChange={(event) => setCategoryId(event.target.value)}
                required
              >
                {!allowedCategories.length ? (
                  <option value="">Crie uma categoria primeiro</option>
                ) : null}
                {allowedCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.archived ? ' (arquivada)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Data
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
          </div>
          <label>
            Situação
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as 'settled' | 'pending')}
            >
              <option value="settled">{type === 'expense' ? 'Pago' : 'Recebido'}</option>
              <option value="pending">{type === 'expense' ? 'A pagar' : 'A receber'}</option>
            </select>
          </label>
          <p className="ac-field-help">
            Pendências ficam separadas dos valores realizados no resumo.
          </p>
          <label>
            Observações <span className="ac-label-optional">(opcional)</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={2000}
              rows={3}
            />
          </label>
        </fieldset>
        {error ? <CustomerError error={error} /> : null}
      </form>
    </CustomerDialog>
  );
}
