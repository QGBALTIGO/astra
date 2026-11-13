import { describe, expect, it } from 'vitest';
import { parseReceivablePlans } from './receivable-routing.js';
import { receivableDates, type ReceivablePlan } from '../db/repositories/customer-receivables.js';
const first: ReceivablePlan = {
  borrower: 'Cliente Alfa',
  principal: 500,
  total: 700,
  installments: 10,
  startDate: '2026-11-14',
  localTime: '18:00',
  skipSunday: true,
};
const second: ReceivablePlan = {
  ...first,
  borrower: 'Cliente Beta',
  principal: 800,
  total: 1120,
  localTime: '14:30',
};
const third: ReceivablePlan = {
  ...first,
  borrower: 'Cliente Gama',
  principal: 1250,
  total: 1750,
  localTime: '20:00',
};
const request =
  'Emprestei e quero que registre. Cliente Alfa pegou 500 e paga 700 em 10 parcelas de 70, todo dia menos domingo, às 18h, começando amanhã. Cliente Beta pegou 800 e paga 1.120 em 10 parcelas de 112, todo dia menos domingo, às 14h30, começando amanhã. Cliente Gama pegou 1.250 e paga 1.750 em 10 parcelas de 175, todo dia menos domingo, às 20h, começando amanhã.';
describe('installment receivable requests', () => {
  it('keeps the three agreed totals, local hours and pending payment dates', () => {
    expect(
      parseReceivablePlans(
        JSON.stringify([first, second, third]),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toEqual([first, second, third]);
    expect(
      parseReceivablePlans(
        JSON.stringify(
          [first, second, third].map((p) => [
            p.borrower,
            p.principal,
            p.total,
            p.installments,
            p.startDate,
            p.localTime,
            p.skipSunday,
          ])
        ),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toEqual([first, second, third]);
    const dates = receivableDates(first, 'America/Cuiaba');
    expect(dates).toHaveLength(10);
    expect(dates[0]!.toISOString()).toBe('2026-11-14T22:00:00.000Z');
    expect(dates.at(-1)!.toISOString()).toBe('2026-11-25T22:00:00.000Z');
    expect(dates.every((d) => d.getUTCDay() !== 0)).toBe(true);
  });
  it('rejects amounts or hours exchanged between borrowers even when each occurs elsewhere in the request', () => {
    expect(
      parseReceivablePlans(
        JSON.stringify([{ ...first, principal: 800, total: 1120 }, second, third]),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
    expect(
      parseReceivablePlans(
        JSON.stringify([{ ...first, localTime: '14:30' }, second, third]),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
  });
  it('reads a JSON envelope but refuses omitted or duplicate clients and wrong Sunday rules', () => {
    const rows = [first, second, third];
    const counted = request.replace('Emprestei', 'Emprestei para 3 clientes');
    expect(
      parseReceivablePlans(
        JSON.stringify({ planos: rows }),
        counted,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toEqual(rows);
    expect(
      parseReceivablePlans(
        JSON.stringify({ planos: rows.slice(0, 2) }),
        counted,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
    expect(
      parseReceivablePlans(
        JSON.stringify({ planos: [first, first, third] }),
        counted,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
    expect(
      parseReceivablePlans(
        JSON.stringify({ planos: [{ ...first, skipSunday: false }, second, third] }),
        counted,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
  });
  it('rejects an invented date and installments that do not sum to the total', () => {
    expect(
      parseReceivablePlans(
        JSON.stringify([{ ...first, startDate: '2026-11-15' }]),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
    expect(() => receivableDates({ ...first, total: 700.01 }, 'America/Cuiaba')).toThrow();
  });
});
