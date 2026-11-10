import type { CustomerChallengePurpose } from '../db/repositories/customer-auth.js';

/** Authentication copy is deterministic and never passes through the assistant. */
export function buildCustomerOtpMessage(code: string, purpose: CustomerChallengePurpose) {
  if (code.length !== 6 || !/^\d{6}$/.test(code))
    throw new Error('Invalid customer verification code');

  let instruction: string;
  switch (purpose) {
    case 'login':
      instruction = 'Use este código para entrar no seu painel.';
      break;
    case 'phone_change_old':
      instruction = 'Use este código para confirmar a troca do seu telefone.';
      break;
    case 'phone_change_new':
      instruction = 'Use este código para confirmar seu novo telefone no Astra.';
      break;
    default:
      throw new Error('Invalid customer verification purpose');
  }

  return {
    text: `*Astra · Código de acesso*\n\n*${code}*\n\n${instruction}\nVálido por 5 minutos a partir da solicitação.\n\nNão compartilhe este código. Se não foi você, ignore esta mensagem.`,
    copyCode: { label: 'Copiar código', code },
  };
}
