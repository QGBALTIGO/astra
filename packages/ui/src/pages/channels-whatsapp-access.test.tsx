// @vitest-environment happy-dom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
import type { ChannelUser } from '../api/types/channels';
import { DialogProvider } from '../components/ConfirmDialog';
import { WhatsAppAccessPanel } from './channels-whatsapp-access';
import { WhatsAppAuthorizeModal } from './channels-whatsapp-access-modal';
import { ChannelDetail } from './channels-detail';

vi.mock('../components/ToastProvider', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const post = vi.spyOn(apiClient, 'post');
let root: Root | null = null;
let container: HTMLDivElement;

function user(overrides: Partial<ChannelUser> = {}): ChannelUser {
  return {
    id: 'channel-user-1',
    platform: 'whatsapp',
    platformUserId: '5567999998888',
    ownpilotUserId: 'whatsapp:5567999998888',
    displayName: 'Ana',
    isVerified: true,
    isBlocked: false,
    lastSeenAt: '2026-11-10T16:00:00Z',
    accessStatus: 'active',
    accessGrantedAt: '2026-11-10T16:00:00Z',
    accessExpiresAt: '2099-12-10T16:00:00Z',
    hasInteracted: false,
    ...overrides,
  };
}

async function render(element: ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<DialogProvider>{element}</DialogProvider>);
  });
}

async function input(selector: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === text
  );
  if (!result) throw new Error('Button not found: ' + text);
  return result;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function submit() {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function panel(
  users: ChannelUser[],
  overrides: Partial<React.ComponentProps<typeof WhatsAppAccessPanel>> = {}
) {
  return (
    <WhatsAppAccessPanel
      users={users}
      isLoading={false}
      onChanged={vi.fn()}
      onBlockUser={vi.fn()}
      onUnblockUser={vi.fn()}
      onDeleteUser={vi.fn()}
      {...overrides}
    />
  );
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ user: user() });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('WhatsApp authorization form', () => {
  it('normalizes a Brazilian number and grants 30 days by default with an optional name', async () => {
    const onAuthorized = vi.fn();
    const onClose = vi.fn();
    await render(<WhatsAppAuthorizeModal onAuthorized={onAuthorized} onClose={onClose} />);
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Autorizar número no WhatsApp'
    );
    const phoneInput = container.querySelector<HTMLInputElement>('input[type="tel"]')!;
    expect(document.activeElement).toBe(phoneInput);
    expect(phoneInput.labels?.[0]?.textContent).toContain('Número do WhatsApp');
    await input('input[type="tel"]', '(67) 99999-8888');
    await input('input[type="text"]', '  Ana  ');
    expect(container.textContent).toContain('Número que será autorizado: +55 (67) 99999-8888');
    await submit();
    expect(post).toHaveBeenCalledWith('/channels/auth/users', {
      platform: 'whatsapp',
      phoneNumber: '+5567999998888',
      displayName: 'Ana',
      durationDays: 30,
    });
    expect(onAuthorized).toHaveBeenCalledWith(expect.objectContaining({ id: 'channel-user-1' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('sends explicit null for unlimited access and accepts an international number', async () => {
    await render(<WhatsAppAuthorizeModal onAuthorized={vi.fn()} onClose={vi.fn()} />);
    await input('input[type="tel"]', '+1 (212) 555-0123');
    await click(container.querySelector<HTMLInputElement>('input[value="unlimited"]')!);
    await submit();
    expect(post).toHaveBeenCalledWith('/channels/auth/users', {
      platform: 'whatsapp',
      phoneNumber: '+12125550123',
      displayName: undefined,
      durationDays: null,
    });
  });

  it.each([
    '',
    'abc5567999998888',
    '+55 99999-8888',
    '55+67999998888',
    '+012345678901',
    '+1234567890123456',
    '+55 (20) 99999-8888',
    '+55 (67) 88888-8888',
  ])('rejects invalid phone input %j without making a request', async (phone) => {
    await render(<WhatsAppAuthorizeModal onAuthorized={vi.fn()} onClose={vi.fn()} />);
    await input('input[type="tel"]', phone);
    await submit();
    expect(post).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Número que será autorizado:');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('número válido');
    expect(container.querySelector('input[type="tel"]')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the number, name and duration when the API rejects an authorization', async () => {
    post.mockRejectedValueOnce(new Error('Este número pertence ao proprietário.'));
    const onClose = vi.fn();
    await render(<WhatsAppAuthorizeModal onAuthorized={vi.fn()} onClose={onClose} />);
    await input('input[type="tel"]', '+55 (67) 99999-8888');
    await input('input[type="text"]', 'Ana');
    await click(container.querySelector<HTMLInputElement>('input[value="unlimited"]')!);
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'pertence ao proprietário'
    );
    expect(container.querySelector<HTMLInputElement>('input[type="tel"]')?.value).toBe(
      '+55 (67) 99999-8888'
    );
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Ana');
    expect(container.querySelector<HTMLInputElement>('input[value="unlimited"]')?.checked).toBe(
      true
    );
    expect(button('Autorizar número').disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    await submit();
    expect(post).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('prevents duplicate submissions and closing while an authorization is pending', async () => {
    let finish!: (value: unknown) => void;
    post.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const onClose = vi.fn();
    await render(<WhatsAppAuthorizeModal onAuthorized={vi.fn()} onClose={onClose} />);
    await input('input[type="tel"]', '67999998888');
    await submit();
    expect(button('Autorizando…').disabled).toBe(true);
    expect(button('Cancelar').disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="tel"]')?.disabled).toBe(true);
    expect(container.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
    await submit();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(post).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish({ user: user() }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('WhatsApp access management', () => {
  it('opens authorization from the empty list', async () => {
    await render(panel([]));
    expect(container.textContent).toContain('Nenhum número cadastrado ainda');
    await click(button('Autorizar número'));
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Autorizar número no WhatsApp'
    );
  });

  it('keeps the authorize button visible while the list loads', async () => {
    await render(panel([], { isLoading: true }));
    expect(button('Autorizar número')).toBeTruthy();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Carregando acessos…');
  });

  it('shows an accessible loading state for the next page without hiding existing numbers', async () => {
    await render(
      panel([user()], {
        hasMore: true,
        isLoadingMore: true,
        onLoadMore: vi.fn(),
      })
    );
    expect(container.querySelector('li')?.textContent).toContain('Ana');
    expect(button('Carregando mais números…').disabled).toBe(true);
    expect(button('Carregando mais números…').getAttribute('aria-busy')).toBe('true');
  });

  it.each([
    ['active', 'Autorizado'],
    ['pending', 'Pendente'],
    ['expired', 'Expirado'],
    ['revoked', 'Revogado'],
    ['blocked', 'Bloqueado'],
  ] as const)(
    'shows the %s state and distinguishes a number that has never sent a message',
    async (state, label) => {
      await render(panel([user({ accessStatus: state, isVerified: state === 'active' })]));
      expect(container.querySelector('li')?.textContent).toContain(label);
      expect(container.querySelector('li')?.textContent).toContain('Ainda não conversou');
      expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(
        '2099-12-10T16:00:00Z'
      );
    }
  );

  it('updates the status when a visible authorization reaches its expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T16:00:00Z'));
    await render(panel([user({ accessExpiresAt: '2026-11-10T16:00:01Z' })]));
    expect(container.querySelector('li')?.textContent).toContain('Autorizado');
    await act(async () => vi.advanceTimersByTime(1010));
    expect(container.querySelector('li')?.textContent).toContain('Expirado');
    expect(button('Renovar 30 dias')).toBeTruthy();
  });

  it('keeps the expiry timer working for a full 30-day authorization', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T16:00:00Z'));
    await render(panel([user({ accessExpiresAt: '2026-12-10T16:00:00Z' })]));
    await act(async () => vi.advanceTimersByTime(2_147_483_647));
    expect(container.querySelector('li')?.textContent).toContain('Autorizado');
    await act(async () => vi.advanceTimersByTime(30 * 86_400_000 - 2_147_483_647 + 20));
    expect(container.querySelector('li')?.textContent).toContain('Expirado');
  });

  it('opens the duration form for a pending user, without using DM pairing approval', async () => {
    await render(
      panel([user({ isVerified: false, accessStatus: 'pending', pendingPairingCode: 'ABCD12' })])
    );
    await click(button('Autorizar'));
    expect(container.querySelector<HTMLInputElement>('input[type="tel"]')?.value).toBe(
      '+55 (67) 99999-8888'
    );
    await submit();
    expect(post).toHaveBeenCalledWith(
      '/channels/auth/users',
      expect.objectContaining({
        phoneNumber: '+5567999998888',
        durationDays: 30,
      })
    );
    expect(post).toHaveBeenCalledOnce();
  });

  it('does not offer renewal for unlimited access and offers explicit authorization after revocation', async () => {
    await render(
      panel([
        user({ accessExpiresAt: null }),
        user({
          id: 'revoked',
          platformUserId: '5567999997777',
          accessStatus: 'revoked',
          isVerified: false,
          accessExpiresAt: null,
        }),
      ])
    );
    const rows = container.querySelectorAll('li');
    expect(rows[0]?.textContent).toContain('Sem vencimento');
    expect(rows[0]?.textContent).not.toContain('Renovar');
    expect(rows[1]?.textContent).toContain('Autorizar');
    expect(rows[1]?.textContent).not.toContain('Renovar');
  });

  it.each([
    { isOwner: true, ownpilotUserId: 'whatsapp:5567999998888' },
    { ownpilotUserId: 'default' },
  ])('preserves the owner controls for %j', async (ownership) => {
    await render(panel([user(ownership)]));
    const row = container.querySelector('li')!;
    expect(row.textContent).toContain('Proprietário');
    expect(row.querySelector('button')).toBeNull();
  });

  it('renews expired access only after confirmation and blocks simultaneous mutations', async () => {
    let finish!: (value: unknown) => void;
    post.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const onChanged = vi.fn();
    await render(panel([user({ accessStatus: 'expired' })], { onChanged }));
    await click(button('Renovar 30 dias'));
    expect(post).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'somados ao prazo atual'
    );
    const confirmation = container.querySelector('[role="dialog"]')!;
    await click(
      Array.from(confirmation.querySelectorAll('button')).find(
        (entry) => entry.textContent === 'Renovar 30 dias'
      )!
    );
    expect(post).toHaveBeenCalledWith('/channels/auth/users/channel-user-1/renew', {
      durationDays: 30,
    });
    expect(button('Renovando…').disabled).toBe(true);
    expect(button('Revogar').disabled).toBe(true);
    expect(button('Autorizar número').disabled).toBe(true);
    await act(async () => finish({ user: user() }));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('cancels revocation without a request and preserves records when revocation is confirmed', async () => {
    const onChanged = vi.fn();
    await render(panel([user()], { onChanged }));
    await click(button('Revogar'));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'histórico e os registros serão preservados'
    );
    await click(button('Cancelar'));
    expect(post).not.toHaveBeenCalled();
    await click(button('Revogar'));
    await click(button('Revogar acesso'));
    expect(post).toHaveBeenCalledWith('/channels/auth/users/channel-user-1/unverify');
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('shows renewal errors in the affected row and lets the owner retry', async () => {
    post.mockRejectedValueOnce(new Error('Não foi possível renovar este acesso.'));
    const onChanged = vi.fn();
    await render(panel([user()], { onChanged }));
    await click(button('Renovar 30 dias'));
    const confirmation = container.querySelector('[role="dialog"]')!;
    await click(
      Array.from(confirmation.querySelectorAll('button')).find(
        (entry) => entry.textContent === 'Renovar 30 dias'
      )!
    );
    expect(container.querySelector('li [role="alert"]')?.textContent).toContain(
      'Não foi possível renovar'
    );
    expect(button('Renovar 30 dias').disabled).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('renders manual authorization inside a disconnected WhatsApp channel with no users', async () => {
    await render(
      <ChannelDetail
        channel={{
          id: 'channel.whatsapp',
          type: 'whatsapp',
          name: 'WhatsApp',
          status: 'disconnected',
        }}
        users={[]}
        stats={null}
        isLoading={false}
        actionLoading={null}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onLogout={vi.fn()}
        onReconnect={vi.fn()}
        onClearMessages={vi.fn()}
        onSendTest={vi.fn()}
        onApproveUser={vi.fn()}
        onBlockUser={vi.fn()}
        onUnblockUser={vi.fn()}
        onDeleteUser={vi.fn()}
        onDenyUser={vi.fn()}
        onUsersChanged={vi.fn()}
        channelPlatform="whatsapp"
      />
    );
    expect(button('Autorizar número')).toBeTruthy();
    expect(button('Conectar')).toBeTruthy();
  });
});
