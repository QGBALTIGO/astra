// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerRoutes } from './CustomerApp';
import { mockCustomerApi, testDom, deferred } from './test-fixtures';
let dom: ReturnType<typeof testDom>, api: ReturnType<typeof mockCustomerApi>;
beforeEach(() => {
  dom = testDom();
  api = mockCustomerApi();
  api.connectedApps.mockResolvedValue({
    configured: true,
    timeZone: 'America/Cuiaba',
    apps: [
      {
        slug: 'googlecalendar',
        name: 'Google Agenda',
        status: 'connected',
        connectionId: 'ca_own',
        lastSyncedAt: '2026-11-13T13:00:00Z',
      },
      { slug: 'gmail', name: 'Gmail', status: 'needs_attention', connectionId: null },
    ],
  });
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
});
const mount = () =>
  dom.render(
    <MemoryRouter initialEntries={['/cliente/conexoes']}>
      <CustomerRoutes />
    </MemoryRouter>
  );
describe('customer connection cards', () => {
  it('puts the app status and refresh controls in its own card', async () => {
    await mount();
    const card = dom.container.querySelector('article[aria-label="Google Agenda"]');
    expect(card?.textContent).toContain('Conectado');
    expect(card?.textContent).toContain('09:00');
    expect(card?.textContent).toContain('Atualizar agora');
    expect(dom.container.querySelector('#conexoes')?.parentElement?.className).toBe('ac-page');
  });
  it('locks repeated refreshes while one is pending', async () => {
    const pending = deferred<{ updated: boolean }>();
    api.syncApp.mockReturnValue(pending.promise);
    await mount();
    await dom.click(dom.button('Atualizar agora'));
    expect(api.syncApp).toHaveBeenCalledTimes(1);
    expect(dom.button('Atualizando…').disabled).toBe(true);
  });
  it('keeps the error beside the app that failed', async () => {
    api.syncApp.mockRejectedValue(new Error('Não foi possível atualizar agora.'));
    await mount();
    await dom.click(dom.button('Atualizar agora'));
    expect(
      dom.container.querySelector('article[aria-label="Google Agenda"] [role="alert"]')?.textContent
    ).toContain('atualizar');
    expect(dom.container.querySelector('article[aria-label="Gmail"] [role="alert"]')).toBeNull();
  });
  it('does not turn an in-progress sync into a false success', async () => {
    api.syncApp.mockResolvedValue({ updated: false, cached: true });
    await mount();
    await dom.click(dom.button('Atualizar agora'));
    expect(
      dom.container.querySelector('article[aria-label="Google Agenda"] [role="status"]')
        ?.textContent
    ).toContain('em andamento');
  });
  it('offers a private Telegram linking command with its expiry explained', async () => {
    await mount();
    await dom.click(dom.button('Gerar código de vínculo'));
    expect(api.telegramLink).toHaveBeenCalledTimes(1);
    expect(dom.container.textContent).toContain('/connect TESTE-FICTICIO');
    expect(dom.container.textContent).toContain('10 minutos');
  });
});
