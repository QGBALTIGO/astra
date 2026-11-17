// @vitest-environment happy-dom
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerRoutes } from './CustomerApp';
import { CustomerApiError, CUSTOMER_SESSION_EXPIRED } from './api';
import {
  customerFixture,
  deferred,
  mockCustomerApi,
  summaryFixture,
  testDom,
} from './test-fixtures';
import type { Customer, CustomerTransaction } from './types';

let dom: ReturnType<typeof testDom>;
let api: ReturnType<typeof mockCustomerApi>;
beforeEach(() => {
  dom = testDom();
  api = mockCustomerApi();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mount(path = '/cliente') {
  await dom.render(
    <MemoryRouter initialEntries={[path]}>
      <CustomerRoutes />
    </MemoryRouter>
  );
}
function visiblePanel() {
  return dom.container.querySelector('.ac-tab-panel:not([hidden])')!;
}

describe('customer financial workspace', () => {
  it('keeps an incomplete custom period editable until a valid period is confirmed', async () => {
    await mount();
    const reads = api.summary.mock.calls.length;
    await dom.click(dom.button('Alterar mês do resumo'));
    await dom.fill(dom.field('Período'), 'custom');
    await dom.fill(dom.field('Data inicial'), '');
    expect(dom.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(dom.button('Concluir').disabled).toBe(true);
    expect(api.summary).toHaveBeenCalledTimes(reads);
    await dom.fill(dom.field('Data inicial'), '2026-10-05');
    await dom.fill(dom.field('Data final'), '2026-10-10');
    await dom.click(dom.button('Concluir'));
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
    expect(api.summary).toHaveBeenLastCalledWith(
      { from: '2026-10-05', to: '2026-10-10' },
      expect.any(AbortSignal)
    );
  });
  it('labels sparse financial bars with their actual dates', async () => {
    api.summary.mockResolvedValue({
      ...summaryFixture,
      series: [
        { date: '2026-11-05', income: 500, expenses: 20 },
        { date: '2026-11-10', income: 100, expenses: 30 },
      ],
    });
    await mount();
    const labels = Array.from(dom.container.querySelectorAll('.bar-column > span')).map(
      (node) => node.textContent
    );
    expect(labels).toEqual(['05 de nov.', '10 de nov.']);
  });
  it('opens global Home totals without carrying a previous transaction filter', async () => {
    await mount('/cliente/transacoes');
    await dom.click(dom.button('Despesas'));
    await dom.click(dom.button('Filtros'));
    await dom.fill(dom.field('Categoria'), 'food');
    await dom.fill(dom.field('Buscar transações'), 'almoço');
    await dom.navigate('Início');
    await dom.click(dom.button('Ver transações'));
    expect(api.transactions).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ categoryId: 'food' }),
      expect.any(AbortSignal)
    );
    const finalFilters = api.transactions.mock.calls.at(-1)?.[0];
    expect(finalFilters?.type).toBeUndefined();
    expect(finalFilters?.status).toBeUndefined();
    expect(finalFilters?.search).toBeUndefined();
    expect(dom.field('Buscar transações').value).toBe('');
  });
  it('only claims the agenda is empty after a successful read of the schedule', async () => {
    const request = deferred<{ items: [] }>();
    api.agenda.mockReturnValueOnce(request.promise).mockResolvedValue({ items: [] });
    await mount();
    expect(visiblePanel().textContent).not.toContain('Agenda em dia');
    await act(async () => request.reject(new Error('Agenda fora do ar')));
    expect(visiblePanel().textContent).toContain('Agenda fora do ar');
    expect(visiblePanel().textContent).not.toContain('Agenda em dia');
    await dom.click(dom.button('Tentar novamente'));
    expect(visiblePanel().textContent).toContain('Agenda em dia');
  });
  it('shows unknown budget spending without inventing a zero, then shows the verified zero on retry', async () => {
    api.plans.mockResolvedValue({
      plans: [
        {
          id: 'budget',
          kind: 'budget',
          title: 'Mercado',
          amount: 500,
          progress: 0,
          categoryId: 'groceries',
          installmentsTotal: null,
          installmentsPaid: null,
          nextDueDate: null,
          notes: null,
          createdAt: '2026-11-01',
          updatedAt: '2026-11-01',
        },
      ],
    });
    api.summary.mockRejectedValueOnce(new Error('Resumo fora do ar'));
    await mount('/cliente/planejamento');
    await dom.click(dom.button('Orçamentos'));
    const card = () => dom.container.querySelector('.finance-goal-card')!;
    expect(card().textContent).toContain('Gasto indisponível');
    expect(card().textContent).not.toContain('R$ 0,00');
    expect(card().querySelector('[role="progressbar"]')).toBeNull();
    await dom.click(dom.button('Tentar novamente'));
    expect(card().textContent?.replaceAll('\u00a0', ' ')).toContain('R$ 0,00');
    expect(card().textContent?.replaceAll('\u00a0', ' ')).toContain('de R$ 500,00');
    expect(card().querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
  });
  it('shows realized totals separately from pending values and hides amounts in summary, chart and recent list', async () => {
    await mount();
    expect(visiblePanel().textContent).toContain('4.963,61');
    expect(visiblePanel().textContent).toContain('150,00');
    expect(dom.container.querySelector('.bar-chart')).not.toBeNull();
    await dom.click(dom.button('Ocultar valores'));
    expect(api.updateProfile).toHaveBeenCalledWith({ hideAmounts: true });
    expect(visiblePanel().textContent).not.toMatch(/4\.963,61|5\.000,00|36,39|150,00|200,00/);
    expect(dom.container.querySelector('.bar-chart')).toBeNull();
    await dom.click(dom.container.querySelector<HTMLButtonElement>('.transaction-row')!);
    expect(dom.container.querySelector('[role="dialog"]')?.textContent).not.toContain('36,39');
    expect(dom.button('Editar e mostrar valor')).toBeDefined();
  });
  it('preserves filters and scroll while moving through customer sections', async () => {
    await mount('/cliente/transacoes');
    await dom.fill(dom.field('Buscar transações'), 'almoço');
    await dom.click(dom.button('Despesas'));
    const content = dom.container.querySelector<HTMLElement>('main.approved-content')!;
    content.scrollTop = 328;
    await act(async () => content.dispatchEvent(new Event('scroll', { bubbles: true })));
    await dom.navigate('Agenda');
    await dom.navigate('Perfil');
    await dom.navigate('Transações');
    expect(dom.field('Buscar transações').value).toBe('almoço');
    expect(dom.button('Despesas').getAttribute('aria-pressed')).toBe('true');
    expect(content.scrollTop).toBe(328);
    expect(api.transactions).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'almoço', type: 'expense', page: 1 }),
      expect.any(AbortSignal)
    );
    expect(dom.container.querySelectorAll('nav[aria-label="Navegação do cliente"] a')).toHaveLength(
      9
    );
    expect(dom.container.querySelectorAll('.ac-release-mobile-nav a')).toHaveLength(4);
    expect(dom.container.querySelector('nav a[href="/cliente/radar"]')).toBeTruthy();
  });
  it('creates an exact decimal expense once and reuses the same idempotency key after a lost response', async () => {
    await mount('/cliente/transacoes');
    await dom.click(dom.button('Nova transação'));
    await dom.fill(dom.field('Descrição'), 'Almoço do trabalho');
    await dom.fill(dom.field('Valor (R$)'), '36,39');
    const pending = deferred<{ transaction: CustomerTransaction }>();
    api.createTransaction.mockReturnValueOnce(pending.promise);
    await dom.submit();
    await dom.submit();
    expect(api.createTransaction).toHaveBeenCalledTimes(1);
    expect(dom.button('Salvando…').disabled).toBe(true);
    await act(async () =>
      pending.reject(
        new CustomerApiError(0, 'NETWORK_ERROR', 'Conexão interrompida. Tente novamente.')
      )
    );
    expect(dom.field('Descrição').value).toBe('Almoço do trabalho');
    expect(dom.field('Valor (R$)').value).toBe('36,39');
    await dom.submit();
    expect(api.createTransaction).toHaveBeenCalledTimes(2);
    expect(api.createTransaction.mock.calls[0]?.[1]).toBe(api.createTransaction.mock.calls[1]?.[1]);
    expect(api.createTransaction.mock.calls[1]?.[0]).toMatchObject({
      description: 'Almoço do trabalho',
      amount: 36.39,
      type: 'expense',
      status: 'settled',
      categoryId: 'food',
    });
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('rejects malformed amounts before any mutation', async () => {
    await mount('/cliente/transacoes');
    await dom.click(dom.button('Nova transação'));
    await dom.fill(dom.field('Descrição'), 'Almoço');
    await dom.fill(dom.field('Valor (R$)'), '36,399');
    await dom.submit();
    expect(api.createTransaction).not.toHaveBeenCalled();
    expect(dom.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(dom.field('Valor (R$)').value).toBe('36,399');
  });
  it('edits and deletes the same WhatsApp transaction only after explicit confirmation', async () => {
    await mount('/cliente/transacoes');
    await dom.click(dom.container.querySelector<HTMLButtonElement>('.ac-transaction')!);
    await dom.click(dom.button('Editar'));
    await dom.fill(dom.field('Valor (R$)'), '39,90');
    await dom.submit();
    expect(api.updateTransaction).toHaveBeenCalledWith(
      'expense-test',
      expect.objectContaining({ amount: 39.9 })
    );
    expect(api.createTransaction).not.toHaveBeenCalled();
    await dom.click(dom.container.querySelector<HTMLButtonElement>('.ac-transaction')!);
    await dom.click(dom.button('Excluir'));
    expect(api.deleteTransaction).not.toHaveBeenCalled();
    await dom.click(dom.button('Excluir transação'));
    expect(api.deleteTransaction).toHaveBeenCalledWith('expense-test');
  });
  it('transfers category records to a compatible destination before removing the category', async () => {
    await mount('/cliente/categorias');
    await dom.click(dom.button('Editar categoria Alimentação'));
    await dom.click(dom.button('Remover ou transferir registros'));
    const destination = dom.field('Transferir os registros para') as HTMLSelectElement;
    expect(Array.from(destination.options).map((option) => option.value)).toEqual([
      '',
      'transport',
    ]);
    await dom.fill(destination, 'transport');
    expect(api.deleteCategory).not.toHaveBeenCalled();
    await dom.submit();
    expect(api.deleteCategory).toHaveBeenCalledWith('food', 'transport');
    expect(dom.container.textContent).toContain('Registros transferidos');
  });
  it('keeps an expired customer in consultation mode across finance, categories and agenda', async () => {
    const expired: Customer = {
      ...customerFixture,
      access: { status: 'expired', expiresAt: '2020-01-01T00:00:00Z', canWrite: false },
    };
    api.session.mockResolvedValue({ customer: expired });
    api.profile.mockResolvedValue({ profile: expired });
    await mount('/cliente/transacoes');
    expect(dom.button('Nova transação').disabled).toBe(true);
    expect(visiblePanel().textContent).toContain('36,39');
    await dom.navigate('Categorias');
    expect(dom.button('Nova categoria').disabled).toBe(true);
    await dom.navigate('Agenda');
    expect(dom.button('Novo compromisso').disabled).toBe(true);
    await dom.navigate('Perfil');
    expect(dom.button('Alterar telefone').disabled).toBe(true);
    await dom.click(dom.button('Preferências'));
    expect(dom.button('Ocultar valores financeiros').disabled).toBe(false);
    await dom.click(dom.button('Privacidade'));
    await dom.click(dom.button('Exportar meus dados'));
    expect(dom.button('Exportar CSV').disabled).toBe(false);
    await dom.click(dom.button('Fechar'));
    await dom.click(dom.button('Plano e acesso'));
    expect(dom.container.querySelector('[data-status="expired"]')).not.toBeNull();
    expect(dom.container.textContent).toContain('Acesso somente leitura');
    const renewal = Array.from(dom.container.querySelectorAll('a')).find(
      (link) => link.textContent?.trim() === 'Renovar meu plano'
    );
    expect(renewal).toBeDefined();
    expect(renewal?.href).toMatch(/^https:\/\//);
  });
  it('shows actual read failures with retry, not a fabricated empty dashboard', async () => {
    api.summary.mockRejectedValueOnce(new Error('Não foi possível carregar seu resumo.'));
    await mount();
    expect(visiblePanel().textContent).toContain('Não foi possível carregar seu resumo.');
    expect(dom.container.querySelector('.ac-summary')).toBeNull();
    await dom.click(dom.button('Tentar novamente'));
    expect(visiblePanel().textContent).toContain('4.963,61');
  });
});

describe('customer refresh and session changes', () => {
  it('remounts account-scoped state if another tab replaces the customer cookie', async () => {
    await mount('/cliente/transacoes');
    await dom.fill(dom.field('Buscar transações'), 'private filter');
    await dom.click(dom.button('Nova transação'));
    await dom.fill(dom.field('Descrição'), 'Draft from previous account');
    api.session.mockResolvedValue({
      customer: {
        ...customerFixture,
        accountId: 'another-account',
        dataUserId: 'whatsapp:5511999995678',
        displayName: 'Outra conta',
      },
    });
    api.transactions.mockResolvedValue({ transactions: [], total: 0, page: 1, pageSize: 20 });
    api.summary.mockResolvedValue({
      ...summaryFixture,
      income: 0,
      expenses: 0,
      result: 0,
      pendingIncome: 0,
      pendingExpenses: 0,
      series: [],
      categories: [],
      recent: [],
    });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(dom.container.textContent).not.toContain('Draft from previous account');
    expect(dom.container.textContent).not.toContain('Marina');
    expect(dom.container.textContent).toContain('Outra conta');
    await dom.navigate('Transações');
    expect(dom.field('Buscar transações').value).toBe('');
  });
  it('reloads on focus and manually, preserves the visible list and keeps an in-progress form', async () => {
    await mount('/cliente/transacoes');
    await dom.fill(dom.field('Buscar transações'), 'almoço');
    await dom.click(dom.button('Nova transação'));
    await dom.fill(dom.field('Descrição'), 'Rascunho em andamento');
    const next = deferred<{ customer: Customer }>();
    api.session.mockReturnValueOnce(next.promise);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(dom.button('Atualizar meus dados').disabled).toBe(true);
    expect(dom.button('Atualizar meus dados').getAttribute('aria-busy')).toBe('true');
    expect(visiblePanel().textContent).toContain('Almoço');
    await act(async () => next.resolve({ customer: customerFixture }));
    expect(dom.field('Descrição').value).toBe('Rascunho em andamento');
    expect(dom.field('Buscar transações').value).toBe('almoço');
    await dom.click(dom.button('Fechar'));
    await dom.click(dom.button('Atualizar meus dados'));
    expect(api.session).toHaveBeenCalledTimes(3);
  });
  it('polls only while visible and reflects a renewed account without resetting filters', async () => {
    vi.useFakeTimers();
    api.session.mockResolvedValueOnce({
      customer: {
        ...customerFixture,
        access: { status: 'expired', expiresAt: '2020-01-01T00:00:00Z', canWrite: false },
      },
    });
    await mount('/cliente/transacoes');
    expect(dom.button('Nova transação').disabled).toBe(true);
    await dom.fill(dom.field('Buscar transações'), 'mercado');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(api.session).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(dom.button('Nova transação').disabled).toBe(false);
    expect(dom.field('Buscar transações').value).toBe('mercado');
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(api.session).toHaveBeenCalledTimes(3);
  });
  it('ignores a superseded session response and returns to login after revocation', async () => {
    await mount();
    const old = deferred<{ customer: Customer }>();
    const latest = deferred<{ customer: Customer }>();
    api.session.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    await act(async () => window.dispatchEvent(new Event('focus')));
    const staleSignal = api.session.mock.calls[1]?.[0];
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(staleSignal?.aborted).toBe(true);
    await act(async () => latest.resolve({ customer: customerFixture }));
    await act(async () =>
      old.resolve({ customer: { ...customerFixture, displayName: 'Stale account' } })
    );
    expect(dom.container.textContent).not.toContain('Stale account');
    api.session.mockRejectedValue(new CustomerApiError(401, 'UNAUTHORIZED', 'Entre na sua conta.'));
    await act(async () => window.dispatchEvent(new Event(CUSTOMER_SESSION_EXPIRED)));
    expect(dom.container.querySelector('nav')).toBeNull();
    expect(dom.container.textContent).toContain('Entre no seu Astra');
  });
  it('uses new server data after refresh without mutating the stored fixture', async () => {
    await mount();
    await act(async () => dom.container.querySelector<HTMLButtonElement>('.bar-column')!.focus());
    expect(dom.container.querySelector('.chart-tooltip')?.textContent).toContain('36,39');
    api.summary.mockResolvedValue({
      ...summaryFixture,
      expenses: 72.78,
      result: 4927.22,
      series: summaryFixture.series.map((day) => ({ ...day, expenses: 72.78 })),
    });
    await dom.click(dom.button('Atualizar meus dados'));
    expect(visiblePanel().textContent).toContain('4.927,22');
    expect(dom.container.querySelector('.chart-tooltip')?.textContent).toContain('72,78');
    expect(summaryFixture.result).toBe(4963.61);
  });
});

describe('customer header actions and shared photo', () => {
  it('keeps values hidden when an older theme response arrives afterward', async () => {
    await mount();
    const themeResponse = deferred<{ profile: Customer }>();
    api.updateProfile
      .mockReturnValueOnce(themeResponse.promise)
      .mockResolvedValueOnce({ profile: { ...customerFixture, hideAmounts: true } });
    await dom.click(dom.button('Ativar tema escuro'));
    await dom.click(dom.button('Ocultar valores'));
    expect(dom.button('Mostrar valores')).toBeDefined();
    await act(async () =>
      themeResponse.resolve({ profile: { ...customerFixture, theme: 'dark', hideAmounts: false } })
    );
    expect(dom.button('Mostrar valores')).toBeDefined();
    expect(dom.container.querySelector('.home-summary-balance')?.textContent).toContain('••••');
    expect(
      dom.container.querySelector('#astra-approved-dashboard')?.getAttribute('data-theme')
    ).toBe('dark');
  });
  it('shares one private photo across header, sidebar and profile', async () => {
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce('blob:customer-photo')
      .mockReturnValue('blob:customer-photo-refresh');
    const revokeObjectURL = vi.fn();
    const originalURL = URL;
    vi.stubGlobal(
      'URL',
      class extends originalURL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      }
    );
    try {
      api.avatar.mockResolvedValue(new Blob(['synthetic-image'], { type: 'image/png' }));
      await mount();
      const actions = dom.container.querySelector('.topbar-actions')!;
      expect(actions.querySelector('[aria-label="Atualizar meus dados"]')).not.toBeNull();
      expect(actions.querySelector('[aria-label="Abrir perfil"]')).not.toBeNull();
      expect(api.avatar).toHaveBeenCalledTimes(1);
      expect(dom.container.querySelectorAll('.ac-avatar img')).toHaveLength(3);

      await dom.click(dom.button('Abrir meu perfil'));
      expect(
        dom.container.querySelector('.approved-profile .settings-panel .ac-avatar img')
      ).not.toBeNull();
      expect(api.avatar).toHaveBeenCalledTimes(1);
      for (const image of dom.container.querySelectorAll('.ac-avatar img')) {
        expect(image.getAttribute('src')).toBe('blob:customer-photo');
      }

      await dom.click(dom.button('Atualizar meus dados'));
      expect(api.avatar).toHaveBeenCalledTimes(2);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:customer-photo');
      expect(dom.button('Atualizar meus dados').getAttribute('aria-busy')).toBe('false');
    } finally {
      await dom.render(<div />);
      vi.unstubAllGlobals();
    }
  });
});
