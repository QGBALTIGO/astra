import { customerRequest } from '../api';
import { validateInvestmentState, type InvestmentState } from './investment-engine';

export type InvestmentBook = { state: InvestmentState; storageVersion: number };

export async function fetchInvestmentBook(
  accountId: string,
  signal: AbortSignal
): Promise<InvestmentBook> {
  const value = await customerRequest<InvestmentBook>('/investments/book', { accountId, signal });
  if (!Number.isSafeInteger(value.storageVersion) || value.storageVersion < 0)
    throw new Error(
      'Não foi possível validar a versão da carteira. Atualize para tentar novamente.'
    );
  return { state: validateInvestmentState(value.state), storageVersion: value.storageVersion };
}
