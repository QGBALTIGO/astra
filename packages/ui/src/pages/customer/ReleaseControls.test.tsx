// @vitest-environment happy-dom
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerProfile } from './Profile';
import { CustomerPlanning } from './Planning';
import { CustomerTransactions } from './Transactions';
import { monthPeriod } from './helpers';
import {
  categoryFixtures,
  customerFixture,
  mockCustomerApi,
  summaryFixture,
  testDom,
} from './test-fixtures';
import type { CustomerCategory } from './types';

let dom: ReturnType<typeof testDom>;
let api: ReturnType<typeof mockCustomerApi>;
let catalogue: CustomerCategory[];
beforeEach(() => {
  dom = testDom();
  api = mockCustomerApi();
  catalogue = structuredClone(categoryFixtures);
  api.categories.mockImplementation(async () => ({ categories: structuredClone(catalogue) }));
  api.createCategory.mockImplementation(async (input) => {
    const category = { ...input, id: `category-saved-${catalogue.length}`, archived: false };
    catalogue.push(category);
    return { category };
  });
  api.updateCategory.mockImplementation(async (id, patch) => {
    const category = catalogue.find((item) => item.id === id)!;
    Object.assign(category, patch);
    return { category: { ...category } };
  });
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
});
async function movement(type: 'income' | 'expense' = 'expense', categories = catalogue) {
  await dom.render(
    <CustomerTransactions
      customer={customerFixture}
      active
      revision={0}
      categories={categories}
      retryCategories={vi.fn()}
      filters={{ ...monthPeriod(customerFixture.timeZone), page: 1, pageSize: 20 }}
      onFilters={vi.fn()}
      onChanged={vi.fn()}
      openCreate={false}
      onCreateHandled={vi.fn()}
    />
  );
  await dom.click(dom.button('Nova transação'));
  await dom.fill(dom.field('Descrição'), 'Registro sintético de teste');
  await dom.fill(dom.field('Valor (R$)'), '123,45');
  if (type === 'income') await dom.click(dom.button('Entrada'));
}
async function custom(name: string) {
  const select = dom.field('Categoria') as HTMLSelectElement;
  const option = Array.from(select.options).find(
    (entry) => entry.textContent === 'Criar categoria…'
  )!;
  await dom.fill(select, option.value);
  await dom.fill(dom.field('Nome da nova categoria'), name);
}

describe('production transaction category parity', () => {
  for (const type of ['expense', 'income'] as const) {
    it(`registers Outros for ${type} with an empty catalogue using only a server category ID`, async () => {
      catalogue = [];
      await movement(type);
      await dom.submit();
      expect(api.createCategory).toHaveBeenCalledWith({
        name: 'Outros',
        type,
        color: type === 'income' ? '#167762' : '#697385',
      });
      expect(api.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId: 'category-saved-0', type, amount: 123.45 }),
        expect.any(String)
      );
      expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
    });
  }
  it('distinguishes the same category name across income and expenses in the global filter', async () => {
    catalogue.push(
      { id: 'other-income', name: 'Outros', type: 'income', color: '#167762', archived: false },
      { id: 'other-expense', name: 'Outros', type: 'expense', color: '#697385', archived: false }
    );
    await movement();
    await dom.click(dom.button('Cancelar'));
    await dom.click(dom.button('Filtros'));
    const options = Array.from((dom.field('Categoria') as HTMLSelectElement).options);
    expect(options.find((option) => option.value === 'other-income')?.textContent).toBe(
      'Outros · Entrada'
    );
    expect(options.find((option) => option.value === 'other-expense')?.textContent).toBe(
      'Outros · Despesa'
    );
  });
  it('does not persist a typed category when the user cancels', async () => {
    await movement();
    await custom('Cuidados com os pets');
    await dom.click(dom.button('Cancelar'));
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.updateCategory).not.toHaveBeenCalled();
    expect(api.createTransaction).not.toHaveBeenCalled();
  });
  it('reuses the active matching name ignoring case, accents and repeated whitespace', async () => {
    catalogue.push({
      id: 'custom-active',
      name: 'Educação livre',
      type: 'expense',
      color: '#697385',
      archived: false,
    });
    await movement();
    await custom('  EDUCACAO   livre ');
    await dom.submit();
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.createTransaction.mock.calls[0]?.[0].categoryId).toBe('custom-active');
  });
  it('does not reuse the other transaction type and reactivates an archived match only on confirmation', async () => {
    catalogue.push({
      id: 'custom-archived',
      name: 'Trabalho extra',
      type: 'income',
      color: '#167762',
      archived: true,
    });
    await movement('income');
    await custom('Trabalho extra');
    expect(dom.container.textContent).toContain('Ao registrar, ela será reativada');
    expect(api.updateCategory).not.toHaveBeenCalled();
    await dom.submit();
    expect(api.updateCategory).toHaveBeenCalledWith('custom-archived', { archived: false });
    expect(api.createTransaction.mock.calls[0]?.[0].categoryId).toBe('custom-archived');
  });
  it('keeps a reactivated category selected when its transaction needs a retry', async () => {
    catalogue.push({
      id: 'archived-retry',
      name: 'Cuidados com os pets',
      type: 'expense',
      color: '#697385',
      archived: true,
    });
    await movement();
    await custom('Cuidados com os pets');
    api.createTransaction.mockRejectedValueOnce(new Error('Resposta não confirmada'));
    await dom.submit();
    expect(dom.field('Categoria').value).toBe('archived-retry');
    await dom.submit();
    expect(api.updateCategory).toHaveBeenCalledTimes(1);
    expect(api.createTransaction.mock.calls[1]?.[0].categoryId).toBe('archived-retry');
  });
  it('retains a saved category after a failed transaction and retries without creating it twice', async () => {
    await movement();
    await custom('Cuidados com os pets');
    api.createTransaction.mockRejectedValueOnce(new Error('Conexão interrompida'));
    await dom.submit();
    expect(dom.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(dom.container.textContent).toContain('A categoria “Cuidados com os pets” está salva.');
    expect(dom.field('Descrição').value).toBe('Registro sintético de teste');
    await dom.submit();
    expect(api.createCategory).toHaveBeenCalledTimes(1);
    expect(api.createTransaction).toHaveBeenCalledTimes(2);
    expect(api.createTransaction.mock.calls[0]?.[1]).toBe(api.createTransaction.mock.calls[1]?.[1]);
    expect(api.createTransaction.mock.calls[1]?.[0].categoryId).toBe('category-saved-3');
  });
  it('rejects an empty custom name before sending category or transaction mutations', async () => {
    await movement();
    await custom('   ');
    await dom.submit();
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.createTransaction).not.toHaveBeenCalled();
    expect(dom.container.textContent).toContain('Informe um nome de categoria');
  });
  it('recovers an uncertain category-create response by reading the saved category before registering', async () => {
    await movement();
    await custom('Cuidados com os pets');
    api.createCategory.mockImplementationOnce(async (input) => {
      catalogue.push({ ...input, id: 'uncertain-create', archived: false });
      throw new Error('Resposta perdida');
    });
    await dom.submit();
    expect(api.createCategory).toHaveBeenCalledTimes(1);
    expect(api.createTransaction.mock.calls[0]?.[0].categoryId).toBe('uncertain-create');
  });
});

describe('production profile and planning sections', () => {
  it('keeps private profile sections out of focus until selected and supports keyboard navigation', async () => {
    await dom.render(
      <MemoryRouter>
        <CustomerProfile
          customer={customerFixture}
          avatarUrl={null}
          active
          revision={0}
          onUpdated={vi.fn()}
          onChanged={vi.fn()}
          onSignOut={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(dom.container.textContent).not.toContain('Aparelhos conectados');
    await dom.click(dom.button('Privacidade'));
    expect(dom.container.textContent).toContain('Sessões e aparelhos');
    expect(dom.container.textContent).toContain('Exportar meus dados');
    const privacy = dom.button('Privacidade');
    await act(async () =>
      privacy.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    );
    expect(dom.button('Plano e acesso').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(dom.button('Plano e acesso'));
    expect(dom.container.textContent).toContain('Renovar meu plano');
    expect(dom.container.textContent).not.toContain('Sessões e aparelhos');
    const signOut = dom.container.querySelector('.profile-signout')!;
    expect(
      signOut.compareDocumentPosition(dom.container.querySelector('.settings-content')!) &
        Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy();
  });
  it('opens the selected standalone planning kind and retains the existing server creation contract', async () => {
    await dom.render(
      <CustomerPlanning
        plans={[]}
        summary={summaryFixture}
        categories={categoryFixtures}
        hidden={false}
        canWrite
        loading={false}
        onChanged={vi.fn()}
        standalone
      />
    );
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
    await dom.click(dom.button('Assinaturas'));
    await dom.click(dom.button('Nova assinatura'));
    expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain(
      'Nova assinatura'
    );
    await dom.fill(dom.field('Nome'), 'Serviço sintético');
    await dom.fill(dom.field('Valor mensal'), '25,00');
    await dom.submit();
    expect(api.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'subscription', title: 'Serviço sintético', amount: 25 })
    );
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('sends the selected approved goal symbol to the account API', async () => {
    await dom.render(
      <CustomerPlanning
        plans={[]}
        summary={summaryFixture}
        categories={categoryFixtures}
        hidden={false}
        canWrite
        loading={false}
        onChanged={vi.fn()}
        standalone
      />
    );
    await dom.click(dom.button('Nova meta'));
    await dom.fill(dom.field('Nome'), 'Viagem sintética');
    await dom.fill(dom.field('Valor da meta'), '8000,00');
    await dom.fill(dom.field('Valor guardado'), '100,00');
    await dom.fill(dom.field('Símbolo da meta'), 'plane');
    await dom.submit();
    expect(api.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'goal',
        title: 'Viagem sintética',
        icon: 'plane',
        amount: 8000,
        progress: 100,
      })
    );
  });
  it('does not advance an installment until its server update succeeds and retries the same target count', async () => {
    const changed = vi.fn();
    const plan = {
      id: 'installment-test',
      kind: 'installment' as const,
      title: 'Compra sintética',
      amount: 100,
      progress: 0,
      categoryId: null,
      installmentsTotal: 6,
      installmentsPaid: 2,
      nextDueDate: null,
      notes: 'Observação preservada',
      createdAt: '2026-11-10T12:00:00Z',
      updatedAt: '2026-11-10T12:00:00Z',
    };
    await dom.render(
      <CustomerPlanning
        plans={[plan]}
        summary={summaryFixture}
        categories={categoryFixtures}
        hidden={false}
        canWrite
        loading={false}
        onChanged={changed}
        standalone
      />
    );
    await dom.click(dom.button('Parcelas'));
    api.updatePlan.mockRejectedValueOnce(new Error('Resposta não confirmada'));
    await dom.click(dom.button('Marcar parcela paga'));
    expect(changed).not.toHaveBeenCalled();
    expect(dom.container.textContent).toContain('2 de 6 pagas');
    await dom.click(dom.button('Marcar parcela paga'));
    expect(api.updatePlan).toHaveBeenCalledTimes(2);
    expect(api.updatePlan.mock.calls[0]?.[1]).toEqual(api.updatePlan.mock.calls[1]?.[1]);
    expect(api.updatePlan.mock.calls[1]?.[1]).toMatchObject({
      installmentsPaid: 3,
      notes: 'Observação preservada',
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
