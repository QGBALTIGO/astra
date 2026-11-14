// @vitest-environment happy-dom
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerApiError } from './api';
import { CustomerRoutes } from './CustomerApp';
import { CustomerPhoneChange } from './PhoneChange';
import {
  challengeFixture,
  customerFixture,
  deferred,
  mockCustomerApi,
  testDom,
} from './test-fixtures';

let dom: ReturnType<typeof testDom>;
let api: ReturnType<typeof mockCustomerApi>;
beforeEach(() => {
  dom = testDom();
  api = mockCustomerApi();
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function login() {
  api.session.mockRejectedValue(new CustomerApiError(401, 'UNAUTHORIZED', 'Entre na sua conta.'));
  await dom.render(
    <MemoryRouter initialEntries={['/cliente/entrar']}>
      <CustomerRoutes />
    </MemoryRouter>
  );
}

describe('customer WhatsApp login', () => {
  it('requires a valid phone before requesting and sends the normalized authorized number', async () => {
    await login();
    await dom.fill(dom.field('Número do WhatsApp'), '123');
    await dom.submit();
    expect(api.requestCode).not.toHaveBeenCalled();
    expect(dom.container.textContent).toContain('Informe um número válido');
    await dom.fill(dom.field('Número do WhatsApp'), '(67) 99999-1234');
    await dom.submit();
    expect(api.requestCode).toHaveBeenCalledWith('+5567999991234');
    expect(dom.container.textContent).toContain('Digite seu código de acesso');
    expect(dom.container.querySelector('nav')).toBeNull();
    expect(dom.container.textContent).toContain('Se este número tiver acesso');
  });
  it('accepts a pasted six-digit code, keeps the form on invalid codes and opens only after verification', async () => {
    await login();
    await dom.fill(dom.field('Número do WhatsApp'), '67999991234');
    await dom.submit();
    const code = dom.field('Código de 6 dígitos');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '123 456' } });
    await act(async () => code.dispatchEvent(paste));
    expect(code.value).toBe('123456');
    api.verifyCode.mockRejectedValueOnce(
      new CustomerApiError(401, 'INVALID_CODE', 'Código inválido ou expirado.')
    );
    await dom.submit();
    expect(dom.container.textContent).toContain('Código inválido ou expirado.');
    expect(dom.field('Código de 6 dígitos').value).toBe('123456');
    expect(dom.container.querySelector('nav')).toBeNull();
    api.session.mockResolvedValue({ customer: customerFixture });
    await dom.submit();
    expect(api.verifyCode).toHaveBeenLastCalledWith('challenge-initial', '123456');
    expect(dom.container.querySelectorAll('nav a')).toHaveLength(6);
  });
  it('prevents duplicate OTP requests and preserves input on API failure', async () => {
    await login();
    const pending = deferred<typeof challengeFixture>();
    api.requestCode.mockReturnValueOnce(pending.promise);
    await dom.fill(dom.field('Número do WhatsApp'), '67999991234');
    await dom.submit();
    await dom.submit();
    expect(api.requestCode).toHaveBeenCalledTimes(1);
    expect(dom.button('Aguarde…').disabled).toBe(true);
    await act(async () =>
      pending.reject(new CustomerApiError(503, 'OFFLINE', 'Tente novamente em instantes.'))
    );
    expect(dom.field('Número do WhatsApp').value).toBe('67999991234');
    expect(dom.container.textContent).toContain('Tente novamente em instantes.');
  });
  it('honors resend cooldown and does not submit an already expired challenge', async () => {
    vi.useFakeTimers();
    await login();
    api.requestCode.mockResolvedValue({ ...challengeFixture, expiresIn: 5 });
    await dom.fill(dom.field('Número do WhatsApp'), '67999991234');
    await dom.submit();
    expect(dom.container.textContent).toContain('1:00');
    await dom.fill(dom.field('Código de 6 dígitos'), '123456');
    await act(async () => vi.advanceTimersByTime(6000));
    await dom.submit();
    expect(api.verifyCode).not.toHaveBeenCalled();
    expect(dom.container.textContent).toContain('Este código expirou');
    const resend = Array.from(dom.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Reenviar')
    );
    expect(resend?.disabled).toBe(true);
  });
});

describe('verified customer phone change', () => {
  it('confirms the current phone then the new phone with separate challenges', async () => {
    const changed = vi.fn();
    await dom.render(
      <div className="astra-customer">
        <CustomerPhoneChange canWrite onClose={vi.fn()} onChanged={changed} />
      </div>
    );
    await dom.fill(dom.field('Novo número do WhatsApp'), '+55 11 99999-5678');
    await dom.submit();
    expect(api.requestPhoneChange).toHaveBeenCalledWith('+5511999995678');
    await dom.fill(dom.field('Código de 6 dígitos'), '123456');
    await dom.submit();
    expect(api.confirmOldPhone).toHaveBeenCalledWith('challenge-initial', '123456');
    expect(api.confirmNewPhone).not.toHaveBeenCalled();
    await dom.fill(dom.field('Código de 6 dígitos'), '654321');
    await dom.submit();
    expect(api.confirmNewPhone).toHaveBeenCalledWith('challenge-new-number', '654321');
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '5511999995678',
        accountId: customerFixture.accountId,
      })
    );
  });
  it('requires a new confirmation after an ambiguous confirm-old failure and keeps the target number', async () => {
    vi.useFakeTimers();
    api.confirmOldPhone.mockRejectedValueOnce(
      new CustomerApiError(429, 'RATE_LIMITED', 'Aguarde antes de confirmar.', 60)
    );
    await dom.render(
      <div className="astra-customer">
        <CustomerPhoneChange canWrite onClose={vi.fn()} onChanged={vi.fn()} />
      </div>
    );
    await dom.fill(dom.field('Novo número do WhatsApp'), '11999995678');
    await dom.submit();
    await dom.fill(dom.field('Código de 6 dígitos'), '123456');
    await dom.submit();
    expect(dom.button('Confirmar e enviar ao novo número').disabled).toBe(true);
    await dom.submit();
    expect(api.confirmOldPhone).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(60_000));
    await dom.click(dom.button('Reiniciar confirmação'));
    expect(dom.field('Novo número do WhatsApp').value).toBe('11999995678');
    await dom.submit();
    expect(api.requestPhoneChange).toHaveBeenCalledTimes(2);
  });
});
