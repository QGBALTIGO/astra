import { CustomerError, CustomerSkeleton } from './components';
import { useCustomerQuery } from './hooks';
import type { Customer } from './types';
import { fetchInvestmentBook } from './investments/investment-api';
import InvestmentsPage from './investments/InvestmentsPage';

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
  if (book.error) return <CustomerError error={book.error} onRetry={book.retry} />;
  if (!book.data) return <CustomerSkeleton label="Carregando sua carteira…" />;
  return (
    <InvestmentsPage
      // Query refreshes retain the prior book while loading. Adopt only a new
      // server version, preserving drafts when the stored book is unchanged.
      key={`${customer.accountId}-${book.data.storageVersion}`}
      accountId={customer.accountId}
      initialBook={book.data}
      readonly={!customer.access.canWrite}
      hidden={customer.hideAmounts}
      notify={notify}
    />
  );
}
