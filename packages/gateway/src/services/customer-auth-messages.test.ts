import { describe, expect, it } from 'vitest';
import type { CustomerChallengePurpose } from '../db/repositories/customer-auth.js';
import { buildCustomerOtpMessage } from './customer-auth-messages.js';

describe('buildCustomerOtpMessage', () => {
  it.each([
    ['login', 'Recebemos uma solicitação para acessar seu painel do *Astra*.'],
    ['phone_change_old', 'Recebemos uma solicitação para alterar o número de WhatsApp da sua conta *Astra*.'],
    ['phone_change_new', 'Recebemos uma solicitação para confirmar seu novo número de WhatsApp no *Astra*.'],
  ] as const)(
    'explains %s with professional formatting, an exact code and the native clipboard action',
    (purpose, instruction) => {
      expect(buildCustomerOtpMessage('123456', purpose)).toEqual({
        text: `*Astra · Verificação de acesso*\n\n${instruction}\n\n🔐 *Seu código de verificação é:*\n\n*123456*\n\n⏳ *Validade:* 5 minutos.\n\n🛡️ *Não reconhece esta tentativa?* Pode ignorar esta mensagem. Seu acesso permanece protegido.`,
        copyCode: { label: 'Copiar código', code: '123456' },
      });
    }
  );

  it('uses a clean, compact WhatsApp layout and never adds a second code or copy action', () => {
    const msg = buildCustomerOtpMessage('722763', 'login');
    expect(msg.text).toContain('🔐 *Seu código de verificação é:*\n\n*722763*');
    expect(msg.text).toContain('⏳ *Validade:* 5 minutos.');
    expect(msg.text).toContain('🛡️ *Não reconhece esta tentativa?*');
    expect(msg.text.match(/722763/g)).toHaveLength(1);
    expect(msg.text.length).toBeLessThanOrEqual(1024);
    expect(msg.copyCode).toEqual({ label: 'Copiar código', code: '722763' });
    expect(msg.text).not.toContain('https://');
  });
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
