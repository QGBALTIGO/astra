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
  it('shows realized totals separately from pending values and hides amounts in summary, chart and recent list', async () => {
    await mount();
    expect(visiblePanel().textContent).toContain('4.963,61');
    expect(visiblePanel().textContent).toContain('150,00');
    expect(dom.container.querySelector('.ac-chart')).not.toBeNull();
    await dom.click(dom.button('Ocultar valores'));
    expect(api.updateProfile).toHaveBeenCalledWith({ hideAmounts: true });
    expect(visiblePanel().textContent).not.toMatch(/4\.963,61|5\.000,00|36,39|150,00|200,00/);
    expect(dom.container.querySelector('.ac-chart')).toBeNull();
    await dom.click(dom.container.querySelector<HTMLButtonElement>('.ac-transaction')!);
    expect(dom.container.querySelector('[role="dialog"]')?.textContent).not.toContain('36,39');
    expect(dom.button('Editar e mostrar valor')).toBeDefined();
  });
  it('preserves filters and scroll while moving through the five tabs', async () => {
    await mount('/cliente/transacoes');
    await dom.fill(dom.field('Buscar transações'), 'almoço');
    await dom.click(dom.button('Despesas'));
    const content = dom.container.querySelector<HTMLElement>('main.ac-content')!;
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
    expect(dom.container.querySelectorAll('nav a')).toHaveLength(5);
  });
  it('creates an exact decimal expense once and reuses the same idempotency key after a lost response', async () => {
    await mount('/cliente/transacoes');
    await dom.click(dom.button('Adicionar'));
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
    await dom.click(dom.button('Adicionar'));
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
    expect(dom.button('Adicionar').disabled).toBe(true);
    expect(visiblePanel().textContent).toContain('36,39');
    await dom.navigate('Categorias');
    expect(dom.button('Nova categoria').disabled).toBe(true);
    await dom.navigate('Agenda');
    expect(dom.button('Criar item').disabled).toBe(true);
    await dom.navigate('Perfil');
    expect(dom.button('Alterar telefone').disabled).toBe(true);
    expect(dom.button('Editar preferências').disabled).toBe(false);
    expect(dom.button('Exportar CSV').disabled).toBe(false);
    expect(dom.container.textContent).toContain('Acesso vencido');
    expect(
      dom.container.querySelector('a[href="https://astraacessor.vercel.app/"]')
    ).not.toBeNull();
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
    await dom.click(dom.button('Adicionar'));
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
    await dom.click(dom.button('Adicionar'));
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
    expect(dom.button('Adicionar').disabled).toBe(true);
    await dom.fill(dom.field('Buscar transações'), 'mercado');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(api.session).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(dom.button('Adicionar').disabled).toBe(false);
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
    await dom.click(dom.container.querySelectorAll<HTMLButtonElement>('.ac-chart-button')[1]!);
    expect(dom.container.querySelector('.ac-chart-insight')?.textContent).toContain('36,39');
    api.summary.mockResolvedValue({
      ...summaryFixture,
      expenses: 72.78,
      result: 4927.22,
      series: summaryFixture.series.map((day) => ({ ...day, expenses: 72.78 })),
    });
    await dom.click(dom.button('Atualizar meus dados'));
    expect(visiblePanel().textContent).toContain('4.927,22');
    expect(dom.container.querySelector('.ac-chart-insight')?.textContent).toContain('72,78');
    expect(summaryFixture.result).toBe(4963.61);
  });
});

describe('customer header actions and shared photo', () => {
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
      const actions = dom.container.querySelector('.ac-topbar-actions')!;
      expect(actions.querySelector('[aria-label="Atualizar meus dados"]')).not.toBeNull();
      expect(actions.querySelector('[aria-label="Abrir meu perfil"]')).not.toBeNull();
      expect(api.avatar).toHaveBeenCalledTimes(1);
      expect(dom.container.querySelectorAll('.ac-avatar img')).toHaveLength(2);

      await dom.click(dom.button('Abrir meu perfil'));
      expect(dom.container.querySelectorAll('.ac-avatar img')).toHaveLength(3);
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
