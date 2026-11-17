// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerReferrals } from './Referrals';
import { referralsApi, type CustomerReferralRecord, type ReferralDashboard } from './referrals-api';
import { customerFixture, deferred, testDom } from './test-fixtures';

let dom: ReturnType<typeof testDom>;
let dashboard: ReferralDashboard;
const notify = vi.fn();
const approved: CustomerReferralRecord = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  label: 'Convite AST-123456',
  status: 'approved',
  reward: 20,
  cycle: '2026-11',
  note: 'Assinatura validada.',
  createdAt: '2026-11-16T12:00:00Z',
  approvedAt: '2026-11-17T12:00:00Z',
  requestedAt: null,
  paidAt: null,
};
beforeEach(() => {
  dom = testDom();
  notify.mockClear();
  dashboard = {
    code: 'AST-AABBCCDDEEFF0011',
    link: 'https://app.astra.test/api/v1/customer/referrals/invite/AST-AABBCCDDEEFF0011',
    page: 1,
    pageSize: 20,
    total: 1,
    records: [structuredClone(approved)],
    available: 20,
    paid: 0,
    awaitingValidation: 0,
    rewardedThisCycle: 1,
    cycle: '2026-11',
    limit: 5,
    minReward: 20,
    maxReward: 100,
  };
  vi.spyOn(referralsApi, 'dashboard').mockImplementation(async () => structuredClone(dashboard));
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
});
const mount = () =>
  dom.render(
    <MemoryRouter>
      <div className="astra-customer ac-approved-ui" data-theme="light">
        <CustomerReferrals customer={customerFixture} active revision={0} notify={notify} />
      </div>
    </MemoryRouter>
  );
describe('approved referral UI using the real account ledger contracts', () => {
  it('shows an actual read failure without inventing empty rewards or sample records', async () => {
    vi.mocked(referralsApi.dashboard).mockRejectedValueOnce(
      new Error('Ledger temporariamente indisponível')
    );
    await mount();
    expect(dom.container.textContent).toContain('Ledger temporariamente indisponível');
    expect(dom.container.querySelector('.referral-numbers')).toBeNull();
    expect(dom.container.querySelector('.referral-record')).toBeNull();
  });
  it('waits for Pix request persistence, prevents double submits and preserves errors for retry', async () => {
    const pending = deferred<{ record: CustomerReferralRecord }>();
    const payout = vi.spyOn(referralsApi, 'payout').mockReturnValueOnce(pending.promise);
    await mount();
    await dom.click(dom.container.querySelector<HTMLButtonElement>('.referral-record')!);
    await dom.click(dom.button('Solicitar Pix'));
    await dom.fill(dom.field('Sua chave Pix'), 'qa@example.test');
    await dom.submit();
    await dom.submit();
    expect(payout).toHaveBeenCalledTimes(1);
    expect(payout).toHaveBeenCalledWith(customerFixture.accountId, approved.id, 'qa@example.test');
    expect(dom.button('Registrando…').disabled).toBe(true);
    await act(async () => pending.reject(new Error('Solicitação não registrada')));
    expect(dom.container.textContent).toContain('Solicitação não registrada');
    expect(dom.field('Sua chave Pix').value).toBe('qa@example.test');
    expect(notify).not.toHaveBeenCalled();
    dashboard.records = [{ ...approved, status: 'requested', requestedAt: '2026-11-17T13:00:00Z' }];
    payout.mockResolvedValueOnce({ record: dashboard.records[0]! });
    await dom.submit();
    expect(payout).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      'Solicitação de Pix registrada. Acompanhe o andamento pelo histórico.'
    );
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
    expect(dom.container.textContent).toContain('Pix solicitado');
  });
  it('uses server pagination and filter parameters for the current account', async () => {
    await mount();
    await dom.fill(dom.field('Mostrar'), 'ineligible');
    expect(referralsApi.dashboard).toHaveBeenLastCalledWith(
      customerFixture.accountId,
      expect.any(AbortSignal),
      1,
      'ineligible'
    );
  });
});
