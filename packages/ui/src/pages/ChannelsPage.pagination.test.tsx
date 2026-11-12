// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelsApi } from '../api/endpoints/misc';
import type { ChannelUser, ChannelUsersPage } from '../api/types/channels';
import { DialogProvider } from '../components/ConfirmDialog';
import { ChannelsPage } from './ChannelsPage';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>();
  return {
    listeners,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    subscribe: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => {
        if (listeners.get(name) === listener) listeners.delete(name);
      };
    }),
  };
});

vi.mock('../hooks/useWebSocket', () => ({
  useGateway: () => ({ subscribe: mocks.subscribe }),
}));
vi.mock('../hooks/useSkipHome', () => ({
  useSkipHome: () => ({ skipHome: false, onSkipHomeChange: vi.fn() }),
}));
vi.mock('../components/ToastProvider', () => ({
  useToast: () => mocks.toast,
}));
vi.mock('../components/ChannelSetupModal', () => ({
  ChannelSetupModal: () => null,
}));
// Keep the real page, access panel and controls. Rendering hundreds of decorative
// SVG trees adds Happy DOM work unrelated to pagination and contends with the
// other package suites in CI; browser tests cover the actual icons and layout.
vi.mock('../components/icons', async (importOriginal) => {
  const icons = await importOriginal<typeof import('../components/icons')>();
  const DecorativeIcon = () => null;
  return Object.fromEntries(Object.keys(icons).map((name) => [name, DecorativeIcon]));
});

const list = vi.spyOn(channelsApi, 'list');
const getUsers = vi.spyOn(channelsApi, 'getUsers');
const getStats = vi.spyOn(channelsApi, 'getStats');
const getPairing = vi.spyOn(channelsApi, 'getPairing');
let root: Root | null = null;
let container: HTMLDivElement;
let allUsers: ChannelUser[];

function user(index: number): ChannelUser {
  return {
    id: 'user-' + index,
    platform: 'whatsapp',
    platformUserId: '5567' + String(900000000 + index),
    ownpilotUserId: 'whatsapp:5567' + String(900000000 + index),
    displayName: 'Cliente ' + String(index).padStart(3, '0'),
    isVerified: true,
    isBlocked: false,
    accessStatus: 'active',
    accessExpiresAt: '2099-12-10T16:00:00Z',
    lastSeenAt: '2026-11-10T16:00:00Z',
    hasInteracted: false,
  };
}

function page(users: ChannelUser[], offset: number): ChannelUsersPage {
  return { users, count: users.length, limit: 100, offset };
}

function rows() {
  return container.querySelectorAll('section[aria-label="Acesso ao WhatsApp"] li');
}

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label
  );
  if (!result) throw new Error('Button not found: ' + label);
  return result;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function selectChannel(name: string) {
  const element = [...container.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(name)
  );
  if (!element) throw new Error('Channel not found: ' + name);
  await click(element);
}

async function renderPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/channels?tab=channels']}>
        <DialogProvider>
          <ChannelsPage />
        </DialogProvider>
      </MemoryRouter>
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  allUsers = Array.from({ length: 205 }, (_, index) => user(index));
  list.mockResolvedValue({
    channels: [
      { id: 'channel.whatsapp', type: 'whatsapp', name: 'WhatsApp principal', status: 'connected' },
      { id: 'channel.telegram', type: 'telegram', name: 'Telegram equipe', status: 'disconnected' },
    ],
    summary: { total: 2, connected: 1, disconnected: 1 },
    availableTypes: ['whatsapp', 'telegram'],
  });
  getUsers.mockReset();
  getUsers.mockImplementation(async (channelId, params) => {
    const offset = params?.offset ?? 0;
    if (channelId === 'channel.telegram') {
      return page(
        [{ ...user(999), platform: 'telegram', displayName: 'Contato Telegram' }],
        offset
      );
    }
    return page(allUsers.slice(offset, offset + 100), offset);
  });
  getStats.mockResolvedValue({
    totalMessages: 0,
    todayMessages: 0,
    weekMessages: 0,
    lastActivityAt: null,
  });
  getPairing.mockResolvedValue({ channels: [], hasAnyOwner: false });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe('ChannelsPage WhatsApp pagination', () => {
  it('loads beyond 100, preserves the visible list during loading and stops on a short page', async () => {
    await renderPage();
    expect(rows()).toHaveLength(100);
    expect(getUsers).toHaveBeenCalledWith('channel.whatsapp', { limit: 100, offset: 0 });
    let finish!: (result: ChannelUsersPage) => void;
    getUsers.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await click(button('Carregar mais números'));
    expect(rows()).toHaveLength(100);
    expect(button('Carregando mais números…').disabled).toBe(true);
    await click(button('Carregando mais números…'));
    expect(getUsers).toHaveBeenCalledTimes(2);
    await act(async () => finish(page(allUsers.slice(100, 200), 100)));
    expect(rows()).toHaveLength(200);
    expect(container.textContent).toContain('Cliente 000');
    expect(container.textContent).toContain('Cliente 199');
    await click(button('Carregar mais números'));
    expect(rows()).toHaveLength(205);
    expect(getUsers).toHaveBeenLastCalledWith('channel.whatsapp', { limit: 100, offset: 200 });
    expect(container.textContent).not.toContain('Carregar mais números');
  });

  it('deduplicates IDs when recent activity moves a number into two pages', async () => {
    await renderPage();
    getUsers.mockResolvedValueOnce(page([user(99), user(100), user(101)], 100));
    await click(button('Carregar mais números'));
    expect(rows()).toHaveLength(102);
    const names = [...rows()].map((row) => row.querySelector('p')?.textContent);
    expect(names.filter((name) => name === 'Cliente 099')).toHaveLength(1);
    expect(container.textContent).not.toContain('Carregar mais números');
  });

  it('retains loaded pages during a refresh and refreshes the full loaded window', async () => {
    await renderPage();
    await click(button('Carregar mais números'));
    expect(rows()).toHaveLength(200);
    let finish!: (result: ChannelUsersPage) => void;
    getUsers.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await act(async () =>
      mocks.listeners.get('channel:message')?.({ channelId: 'channel.whatsapp' })
    );
    expect(rows()).toHaveLength(200);
    expect(container.textContent).toContain('Cliente 199');
    expect(getUsers).toHaveBeenLastCalledWith('channel.whatsapp', { limit: 100, offset: 100 });
    const refreshed = allUsers.slice(0, 100);
    refreshed[0] = { ...refreshed[0]!, displayName: 'Nome atualizado' };
    await act(async () => finish(page(refreshed, 0)));
    expect(rows()).toHaveLength(200);
    expect(container.textContent).toContain('Nome atualizado');
    expect(container.textContent).toContain('Cliente 199');
  });

  it('does not drop a newly loaded page when an earlier background refresh finishes later', async () => {
    await renderPage();
    let finishRefresh!: (result: ChannelUsersPage) => void;
    getUsers.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRefresh = resolve;
      })
    );
    await act(async () =>
      mocks.listeners.get('channel:message')?.({ channelId: 'channel.whatsapp' })
    );
    await click(button('Carregar mais números'));
    expect(rows()).toHaveLength(200);
    await act(async () => finishRefresh(page(allUsers.slice(0, 100), 0)));
    expect(rows()).toHaveLength(200);
    expect(container.textContent).toContain('Cliente 199');
  });

  it('keeps earlier numbers and the same next offset available after an API error', async () => {
    await renderPage();
    getUsers.mockRejectedValueOnce(new Error('Temporarily unavailable'));
    await click(button('Carregar mais números'));
    expect(rows()).toHaveLength(100);
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Não foi possível carregar mais números. Tente novamente.'
    );
    expect(button('Carregar mais números').disabled).toBe(false);
    await click(button('Carregar mais números'));
    expect(getUsers).toHaveBeenLastCalledWith('channel.whatsapp', { limit: 100, offset: 100 });
    expect(rows()).toHaveLength(200);
  });

  it('ignores an old page after changing channels and returning to WhatsApp', async () => {
    await renderPage();
    let finish!: (result: ChannelUsersPage) => void;
    getUsers.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await click(button('Carregar mais números'));
    await selectChannel('Telegram equipe');
    expect(container.textContent).toContain('Contato Telegram');
    expect(rows()).toHaveLength(0);
    await selectChannel('WhatsApp principal');
    expect(rows()).toHaveLength(100);
    await act(async () => finish(page([{ ...user(700), displayName: 'Resposta antiga' }], 100)));
    expect(rows()).toHaveLength(100);
    expect(container.textContent).not.toContain('Resposta antiga');
    expect(button('Carregar mais números').disabled).toBe(false);
  });
});
