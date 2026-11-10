import { describe, expect, it } from 'vitest';
import type { CustomerChallengePurpose } from '../db/repositories/customer-auth.js';
import { buildCustomerOtpMessage } from './customer-auth-messages.js';

describe('buildCustomerOtpMessage', () => {
  it.each([
    ['login', 'Use este código para entrar no seu painel.'],
    ['phone_change_old', 'Use este código para confirmar a troca do seu telefone.'],
    ['phone_change_new', 'Use este código para confirmar seu novo telefone no Astra.'],
  ] as const)(
    'explains the %s action and the original five-minute validity',
    (purpose, instruction) => {
      expect(buildCustomerOtpMessage('123456', purpose)).toEqual({
        text: `*Astra · Código de acesso*\n\n*123456*\n\n${instruction}\nVálido por 5 minutos a partir da solicitação.\n\nNão compartilhe este código. Se não foi você, ignore esta mensagem.`,
        copyCode: { label: 'Copiar código', code: '123456' },
      });
    }
  );

  it('preserves leading zeros in the visible code and copy action', () => {
    const message = buildCustomerOtpMessage('000123', 'login');
    expect(message.text).toContain('\n\n*000123*\n\n');
    expect(message.copyCode.code).toBe('000123');
  });

  it.each(['12345', '1234567', '12345a', ' 123456', '123456\n', '123\u200b456', '١٢٣٤٥٦'])(
    'rejects a malformed code without including it in the error',
    (code) => {
      expect(() => buildCustomerOtpMessage(code, 'login')).toThrow(
        /^Invalid customer verification code$/
      );
    }
  );

  it('does not render an unknown authentication purpose', () => {
    expect(() => buildCustomerOtpMessage('123456', 'unknown' as CustomerChallengePurpose)).toThrow(
      /^Invalid customer verification purpose$/
    );
  });
});
