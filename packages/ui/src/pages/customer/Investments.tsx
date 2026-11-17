import { useEffect, useState } from 'react';
import { CustomerError, CustomerSkeleton } from './components';
import { useCustomerQuery } from './hooks';
import type { Customer } from './types';
import { fetchInvestmentBook, type InvestmentBook } from './investments/investment-api';
import InvestmentsPage from './investments/InvestmentsPage';

function InvestmentBookView({
  book,
  customer,
  notify,
}: {
  book: InvestmentBook;
  customer: Customer;
  notify: (message: string, error?: boolean) => void;
}) {
  const [current, setCurrent] = useState(() => ({ book, latestVersion: book.storageVersion }));
  useEffect(() => {
    setCurrent((previous) =>
      book.storageVersion > previous.latestVersion
        ? { book, latestVersion: book.storageVersion }
        : previous
    );
  }, [book]);
  return (
    <InvestmentsPage
      // A GET that catches up with a confirmed local save must retain its drafts.
      // Only a newer external book replaces the mounted page.
      key={current.book.storageVersion}
      accountId={customer.accountId}
      initialBook={current.book}
      onCommitted={(storageVersion) =>
        setCurrent((previous) =>
          storageVersion > previous.latestVersion
            ? { ...previous, latestVersion: storageVersion }
            : previous
        )
      }
      readonly={!customer.access.canWrite}
      hidden={customer.hideAmounts}
      notify={notify}
    />
  );
}

export function CustomerInvestments({
  customer,
  active,
  revision,
  notify,
}: {
  customer: Customer;
  active: boolean;
  revision: number;
  notify: (message: string, error?: boolean) => void;
}) {
  const book = useCustomerQuery(
    `investments-${customer.accountId}`,
    (signal) => fetchInvestmentBook(customer.accountId, signal),
    active,
    revision
  );
  if (!active) return null;
  if (!book.data)
    return book.error ? (
      <CustomerError error={book.error} onRetry={book.retry} />
    ) : (
      <CustomerSkeleton label="Carregando sua carteira…" />
    );
  return (
    <>
      {book.error && <CustomerError error={book.error} onRetry={book.retry} />}
      <InvestmentBookView
        key={customer.accountId}
        book={book.data}
        customer={customer}
        notify={notify}
      />
    </>
  );
}
