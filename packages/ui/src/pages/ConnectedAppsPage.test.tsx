// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { ConnectedAppsPage } from './ConnectedAppsPage';

const svc = vi.hoisted(() => ({
  status: vi.fn(),
  apps: vi.fn(),
  connections: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../api', () => ({ composioApi: svc }));
vi.mock('../components/ConfirmDialog', () => ({ useDialog: () => ({ confirm: vi.fn() }) }));
vi.mock('../components/ToastProvider', () => ({
  useToast: () => ({ success: svc.success, error: svc.error }),
}));
vi.mock('../components/PageHomeTab', () => ({ PageHomeTab: () => null }));
vi.mock('../hooks/useSkipHome', () => ({
  useSkipHome: () => ({ skipHome: false, onSkipHomeChange: vi.fn() }),
}));
let root: Root | null;
const recommended = [
  { slug: 'googlecalendar', name: 'Google Agenda' },
  { slug: 'gmail', name: 'Gmail' },
];
async function renderPage(query = '?tab=apps') {
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/settings/connected-apps' + query] },
        createElement(ConnectedAppsPage)
      )
    );
  });
  return container;
}
beforeEach(() => {
  vi.clearAllMocks();
  svc.status.mockResolvedValue({ configured: false, recommendedApps: recommended });
  svc.apps.mockResolvedValue({ apps: [recommended[0]] });
  svc.connections.mockResolvedValue({ connections: [] });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('real connection states', () => {
  it('shows setup requirements and disables authorization until configured', async () => {
    const page = await renderPage();
    expect(page.textContent).toContain('Prepare as conexões gratuitas');
    const pending = [...page.querySelectorAll('button')].filter((b) =>
      b.textContent?.includes('Configuração pendente')
    );
    expect(pending).toHaveLength(2);
    expect(pending.every((b) => b.disabled)).toBe(true);
    expect(svc.apps).not.toHaveBeenCalled();
    expect(svc.connections).not.toHaveBeenCalled();
  });
  it('offers only apps confirmed available by the provider', async () => {
    svc.status.mockResolvedValue({ configured: true, recommendedApps: recommended });
    const page = await renderPage();
    expect(page.textContent).toContain('Google Agenda');
    expect(page.textContent).not.toContain('Gmail');
    expect(
      [...page.querySelectorAll('button')].filter((b) => b.textContent === 'Conectar conta')
    ).toHaveLength(1);
  });
  it('does not claim authorization from callback query parameters', async () => {
    svc.status.mockResolvedValue({ configured: true, recommendedApps: recommended });
    await renderPage('?tab=apps&connected=gmail&status=success');
    expect(svc.success).not.toHaveBeenCalled();
  });
  it('fails visibly and keeps authorization disabled when ownership cannot be checked', async () => {
    svc.status.mockResolvedValue({ configured: true, recommendedApps: recommended });
    svc.connections.mockRejectedValueOnce(new Error('provider unavailable'));
    const page = await renderPage();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain('verificar suas contas');
    expect(
      [...page.querySelectorAll('button')]
        .filter((b) => b.textContent?.includes('Configuração pendente'))
        .every((b) => b.disabled)
    ).toBe(true);
    expect(page.textContent).not.toContain('provider unavailable');
  });
});
