import { describe, expect, it } from 'vitest';
import {
  CustomerInvestmentsRepository,
  investmentBookHash,
  validateCustomerInvestmentBook,
} from './customer-investments.js';
import {
  addAccount,
  addAsset,
  addPortfolio,
  emptyInvestmentState,
  getSnapshot,
  saveOperation,
} from '../../services/investments/engine.js';

describe('investment book validation before storage', () => {
  it('keeps exact fixed-decimal arithmetic through server validation', () => {
    let state = addPortfolio(emptyInvestmentState(), { id: 'p', name: 'Carteira' });
    state = addAccount(state, { id: 'a', portfolioId: 'p', name: 'Custódia' });
    state = addAsset(state, { id: 's', symbol: 'PETR4', kind: 'stock', name: 'Ativo' });
    state = saveOperation(state, {
      id: 'cash',
      accountId: 'a',
      type: 'OPEN_CASH',
      date: '2026-01-02',
      sequence: 1,
      amount: '100',
    });
    state = saveOperation(state, {
      id: 'buy',
      accountId: 'a',
      type: 'BUY',
      date: '2026-01-02',
      sequence: 2,
      assetId: 's',
      quantity: '3',
      unitPrice: '0.1',
      fees: '0.01',
    });
    const validated = validateCustomerInvestmentBook(state);
    expect(getSnapshot(validated).cash).toBe('99.69');
    expect(getSnapshot(validated).positions[0]?.cost).toBe('0.31');
  });
  it('rejects missing IDs instead of generating a different ledger on each retry', () => {
    expect(() =>
      validateCustomerInvestmentBook({
        ...emptyInvestmentState(),
        portfolios: [{ name: 'Sem identidade' }],
      })
    ).toThrow(/identificadores/);
  });
  it('rejects unknown identity fields, invalid books and oversize documents', () => {
    expect(() =>
      validateCustomerInvestmentBook({ ...emptyInvestmentState(), userId: 'foreign' })
    ).toThrow(/desconhecidos/);
    expect(() =>
      validateCustomerInvestmentBook({ ...emptyInvestmentState(), operations: [{ id: 'bad' }] })
    ).toThrow();
    expect(() =>
      validateCustomerInvestmentBook({
        ...emptyInvestmentState(),
        portfolios: [{ id: 'x', name: 'x'.repeat(10 * 1024 * 1024) }],
      })
    ).toThrow(/10 MiB/);
  });
  it('hashes equivalent JSON key orders identically and separates financial changes', () => {
    const state = emptyInvestmentState();
    expect(investmentBookHash(state)).toBe(
      investmentBookHash({ ...state, ...Object.fromEntries(Object.entries(state).reverse()) })
    );
    expect(investmentBookHash(state)).not.toBe(
      investmentBookHash(addPortfolio(state, { id: 'p', name: 'Carteira' }))
    );
  });
  it('refuses empty and owner identities without touching a database', () => {
    expect(() => new CustomerInvestmentsRepository('')).toThrow();
    expect(() => new CustomerInvestmentsRepository('default')).toThrow();
  });
});
