// @vitest-environment happy-dom
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerRoutes } from './CustomerApp';
import { agendaFixture, deferred, mockCustomerApi, testDom } from './test-fixtures';

let dom: ReturnType<typeof testDom>;
let api: ReturnType<typeof mockCustomerApi>;
beforeEach(() => {
  dom = testDom();
  api = mockCustomerApi();
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
});
async function mount(path: string) {
  await dom.render(
    <MemoryRouter initialEntries={[path]}>
      <CustomerRoutes />
    </MemoryRouter>
  );
}

describe('customer agenda', () => {
  it('sends an appointment in the account timezone using only fields accepted by the strict API', async () => {
    await mount('/cliente/agenda');
    await dom.click(dom.button('Criar item'));
    await dom.fill(dom.field('Título'), 'Consulta');
    await dom.fill(dom.field('Início'), '2030-11-10T09:00');
    await dom.fill(dom.field('Término'), '2030-11-10T10:00');
    await dom.submit();
    expect(api.createAgenda).toHaveBeenCalledWith(
      {
        kind: 'event',
        title: 'Consulta',
        description: '',
        startAt: '2030-11-10T13:00:00.000Z',
        endAt: '2030-11-10T14:00:00.000Z',
        reminderAt: null,
      },
      expect.any(String)
    );
    expect(api.createAgenda.mock.calls[0]?.[0]).not.toHaveProperty('timeZone');
    expect(dom.container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('creates a date-only task without a fabricated start time and prevents duplicate submits', async () => {
    await mount('/cliente/agenda');
    await dom.click(dom.button('Criar item'));
    await dom.fill(dom.field('Tipo'), 'task');
    await dom.fill(dom.field('Título'), 'Separar documentos');
    await dom.fill(dom.field('Data da tarefa'), '2030-11-11');
    const pending = deferred<{ item: typeof agendaFixture }>();
    api.createAgenda.mockReturnValueOnce(pending.promise);
    await dom.submit();
    await dom.submit();
    expect(api.createAgenda).toHaveBeenCalledTimes(1);
    expect(api.createAgenda.mock.calls[0]?.[0]).toEqual({
      kind: 'task',
      title: 'Separar documentos',
      description: '',
      dueDate: '2030-11-11',
      reminderAt: null,
    });
    await act(async () => pending.reject(new Error('Não foi possível salvar.')));
    expect(dom.field('Título').value).toBe('Separar documentos');
    await dom.submit();
    expect(api.createAgenda.mock.calls[0]?.[1]).toBe(api.createAgenda.mock.calls[1]?.[1]);
  });
  it('creates a reminder without unrelated optional fields and labels its actual WhatsApp delivery status', async () => {
    api.agenda.mockResolvedValue({
      items: [
        {
          ...agendaFixture,
          kind: 'reminder',
          title: 'Tomar água',
          startAt: '2030-11-10T13:00:00Z',
          syncStatus: 'pending',
        },
      ],
    });
    await mount('/cliente/agenda');
    expect(dom.container.textContent).toContain('Lembrete agendado');
    expect(dom.container.textContent).not.toContain('Sincronizando');
    await dom.click(dom.container.querySelector<HTMLButtonElement>('.ac-agenda-item-main')!);
    expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain(
      'Lembrete no WhatsApp'
    );
    expect(dom.container.querySelector('[role="dialog"]')?.textContent).not.toContain(
      'Google Agenda'
    );
    await dom.click(dom.button('Fechar'));
    await dom.click(dom.button('Criar item'));
    await dom.fill(dom.field('Tipo'), 'reminder');
    await dom.fill(dom.field('Título'), 'Lembrar da consulta');
    await dom.fill(dom.field('Quando lembrar'), '2030-11-10T08:30');
    await dom.submit();
    expect(api.createAgenda.mock.calls[0]?.[0]).toEqual({
      kind: 'reminder',
      title: 'Lembrar da consulta',
      description: '',
      startAt: '2030-11-10T12:30:00.000Z',
    });
  });
  it('completes the existing task and settles a bill without creating a duplicate record', async () => {
    await mount('/cliente/agenda');
    await dom.click(dom.button('Concluir tarefa Organizar a semana'));
    expect(api.completeTask).toHaveBeenCalledWith('task-test', true);
    api.agenda.mockResolvedValue({
      items: [{ ...agendaFixture, id: 'bill-transaction', kind: 'bill', title: 'Conta de luz' }],
    });
    await dom.click(dom.button('Atualizar meus dados'));
    await dom.click(dom.container.querySelector<HTMLButtonElement>('.ac-agenda-item-main')!);
    await dom.click(dom.button('Marcar como paga'));
    expect(api.completeBill).not.toHaveBeenCalled();
    await dom.click(dom.button('Marcar como paga'));
    expect(api.completeBill).toHaveBeenCalledWith('bill-transaction', true);
    expect(api.createTransaction).not.toHaveBeenCalled();
    expect(api.createAgenda).not.toHaveBeenCalled();
  });
  it('routes a new due bill to a pending expense in the finance form', async () => {
    await mount('/cliente/agenda');
    await dom.click(dom.button('Criar item'));
    await dom.fill(dom.field('Tipo'), 'bill');
    await dom.submit();
    expect(dom.field('Situação').value).toBe('pending');
    expect(dom.field('Tipo').value).toBe('expense');
    expect(api.createAgenda).not.toHaveBeenCalled();
  });
});

describe('customer profile', () => {
  it('shows real integration availability with no placebo Google connection button', async () => {
    await mount('/cliente/perfil');
    expect(dom.container.textContent).toContain('WhatsApp');
    expect(dom.container.textContent).toContain('Conectado');
    expect(dom.container.textContent).toContain('Indisponível');
    expect(
      Array.from(dom.container.querySelectorAll('button')).some((button) =>
        /conectar.*google/i.test(button.textContent ?? '')
      )
    ).toBe(false);
    expect(
      Array.from(dom.container.querySelectorAll('a')).some((anchor) =>
        /cakto|checkout/i.test(anchor.href)
      )
    ).toBe(false);
  });
  it('saves account timezone, theme and privacy preferences without accepting phone or user IDs', async () => {
    await mount('/cliente/perfil');
    await dom.click(dom.button('Editar preferências'));
    await dom.fill(dom.field('Como você quer ser chamado?'), 'Marina Costa');
    await dom.fill(dom.field('Fuso horário'), 'America/Manaus');
    await dom.click(
      dom.container.querySelector<HTMLInputElement>('input[type="radio"][value="dark"]')!
    );
    await dom.click(dom.field('Ocultar valores ao usar o painel'));
    await dom.submit();
    expect(api.updateProfile).toHaveBeenCalledWith({
      displayName: 'Marina Costa',
      timeZone: 'America/Manaus',
      theme: 'dark',
      hideAmounts: true,
    });
    expect(dom.container.querySelector('.astra-customer')?.getAttribute('data-theme')).toBe('dark');
    expect(dom.container.textContent).toContain('Marina Costa');
  });
  it('requires confirmation to revoke other sessions and keeps the current one signed in', async () => {
    await mount('/cliente/perfil');
    await dom.click(dom.button('Encerrar outras sessões'));
    expect(api.revokeOtherSessions).not.toHaveBeenCalled();
    const dialog = dom.container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Este aparelho continuará conectado');
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Encerrar outras sessões'
    )!;
    await dom.click(confirm);
    expect(api.revokeOtherSessions).toHaveBeenCalledTimes(1);
    expect(api.logout).not.toHaveBeenCalled();
    expect(dom.container.querySelector('nav')).not.toBeNull();
  });
});
