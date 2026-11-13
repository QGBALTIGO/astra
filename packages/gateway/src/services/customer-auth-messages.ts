import type { CustomerChallengePurpose } from '../db/repositories/customer-auth.js';

/** Authentication copy is deterministic and never passes through the assistant. */
export function buildCustomerOtpMessage(code: string, purpose: CustomerChallengePurpose) {
  if (code.length !== 6 || !/^\d{6}$/.test(code))
    throw new Error('Invalid customer verification code');

  let context: string;
  switch (purpose) {
    case 'login':
      context = 'Recebemos uma solicitação para acessar seu painel do *Astra*.';
      break;
    case 'phone_change_old':
      context = 'Recebemos uma solicitação para alterar o número de WhatsApp da sua conta *Astra*.';
      break;
    case 'phone_change_new':
      context = 'Recebemos uma solicitação para confirmar seu novo número de WhatsApp no *Astra*.';
      break;
    default:
      throw new Error('Invalid customer verification purpose');
  }

  return {
    text: `*Astra · Verificação de acesso*\n\n${context}\n\n🔐 *Seu código de verificação é:*\n\n*${code}*\n\n⏳ *Validade:* 5 minutos.\n\n🛡️ *Não reconhece esta tentativa?* Pode ignorar esta mensagem. Seu acesso permanece protegido.`,
    copyCode: { label: 'Copiar código', code },
  };
}
