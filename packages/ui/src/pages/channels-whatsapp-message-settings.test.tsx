// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
import { WhatsAppMessageSettingsSection } from './channels-whatsapp-message-settings';

const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('../components/ToastProvider', () => ({ useToast: () => toast }));

const get = vi.spyOn(apiClient, 'get');
const put = vi.spyOn(apiClient, 'put');
const defaults = {
  siteUrl: 'https://astraacessor.vercel.app',
  renewalUrl: null,
  timeZone: 'America/Campo_Grande',
};
const endpoint = '/channels/auth/messages/settings';
let root: Root | null = null;
let container: HTMLDivElement;

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<WhatsAppMessageSettingsSection />);
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text
  );
  if (!found) throw new Error('Button not found: ' + text);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function open() {
  await render();
  await click(button('Configurar mensagens'));
}

async function input(name: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  toast.success.mockReset();
  get.mockResolvedValue({ settings: defaults });
  put.mockResolvedValue({ settings: defaults });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe('WhatsApp automatic message settings', () => {
  it('loads on demand and exposes an accessible dialog with real defaults and no renewal placeholder', async () => {
    await render();
    expect(get).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click(button('Configurar mensagens'));
    expect(get).toHaveBeenCalledExactlyOnceWith(endpoint);
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Configurar mensagens automáticas do WhatsApp'
    );
    expect(container.querySelector<HTMLInputElement>('input[name="siteUrl"]')?.value).toBe(
      defaults.siteUrl
    );
    expect(container.querySelector<HTMLInputElement>('input[name="renewalUrl"]')?.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('input[name="timeZone"]')?.value).toBe(
      defaults.timeZone
    );
    expect(container.textContent).toContain('Link ainda não configurado');
    for (const field of container.querySelectorAll<HTMLInputElement>('input')) {
      expect(field.labels?.length).toBe(1);
    }
  });

  it('saves the site, real renewal link and time zone as one owner settings object', async () => {
    await open();
    await input('siteUrl', 'https://astra.example/site');
    await input('renewalUrl', 'https://pay.example/astra');
    await input('timeZone', 'America/Sao_Paulo');
    await submit();
    expect(put).toHaveBeenCalledExactlyOnceWith(endpoint, {
      siteUrl: 'https://astra.example/site',
      renewalUrl: 'https://pay.example/astra',
      timeZone: 'America/Sao_Paulo',
    });
    expect(toast.success).toHaveBeenCalledWith('Mensagens automáticas atualizadas');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('sends explicit null when the owner removes a configured renewal link', async () => {
    get.mockResolvedValue({ settings: { ...defaults, renewalUrl: 'https://pay.example/astra' } });
    await open();
    await input('renewalUrl', '');
    await submit();
    expect(put).toHaveBeenCalledExactlyOnceWith(endpoint, defaults);
  });

  it.each([
    ['siteUrl', ''],
    ['siteUrl', 'http://astra.example'],
    ['siteUrl', 'https://owner:secret@astra.example'],
    ['renewalUrl', 'javascript:alert(1)'],
    ['renewalUrl', 'https://pay.example/%0aMensagem'],
    ['renewalUrl', 'https://pay.example\\@evil.example'],
    ['timeZone', 'Mars/Olympus'],
    ['timeZone', '+04:00'],
  ])('rejects invalid %s before making a request: %s', async (field, value) => {
    await open();
    await input(field, value);
    await submit();
    expect(put).not.toHaveBeenCalled();
    const invalid = container.querySelector<HTMLInputElement>(`input[name="${field}"]`)!;
    expect(invalid.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(invalid);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('does not permit saving defaults while settings are still loading', async () => {
    let finish!: (value: unknown) => void;
    get.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await open();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Carregando');
    expect(button('Salvar configurações').disabled).toBe(true);
    expect(container.querySelector('form')).toBeNull();
    await act(async () => finish({ settings: defaults }));
    expect(button('Salvar configurações').disabled).toBe(false);
  });

  it('retains all edits after an API error and permits retrying the same values', async () => {
    put.mockRejectedValueOnce(new Error('Não foi possível gravar as configurações.'));
    await open();
    await input('siteUrl', 'https://astra.example');
    await input('renewalUrl', 'https://pay.example/renovar');
    await input('timeZone', 'UTC');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível gravar'
    );
    expect(container.querySelector<HTMLInputElement>('input[name="siteUrl"]')?.value).toBe(
      'https://astra.example'
    );
    expect(container.querySelector<HTMLInputElement>('input[name="renewalUrl"]')?.value).toBe(
      'https://pay.example/renovar'
    );
    expect(container.querySelector<HTMLInputElement>('input[name="timeZone"]')?.value).toBe('UTC');
    expect(button('Salvar configurações').disabled).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
    await submit();
    expect(put).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the form and dialog locked during save and prevents duplicate submissions', async () => {
    let finish!: (value: unknown) => void;
    put.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await open();
    await submit();
    expect(button('Salvando…').disabled).toBe(true);
    expect(button('Cancelar').disabled).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLInputElement>('input')].every((field) => field.disabled)
    ).toBe(true);
    expect(container.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
    await submit();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(put).toHaveBeenCalledOnce();
    await act(async () => finish({ settings: defaults }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('offers a read retry instead of overwriting unavailable settings with defaults', async () => {
    get.mockRejectedValueOnce(new Error('Configuração indisponível.'));
    await open();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Configuração indisponível.'
    );
    expect(button('Salvar configurações').disabled).toBe(true);
    expect(container.querySelector('form')).toBeNull();
    await click(button('Tentar novamente'));
    expect(get).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>('input[name="siteUrl"]')?.value).toBe(
      defaults.siteUrl
    );
  });

  it('ignores a settings response after the dialog is closed', async () => {
    let finish!: (value: unknown) => void;
    get.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await open();
    await click(button('Cancelar'));
    await act(async () => finish({ settings: defaults }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });
});
