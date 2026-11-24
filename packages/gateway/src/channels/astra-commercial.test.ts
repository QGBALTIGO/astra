import { describe, expect, it } from 'vitest';
import { astraCommercialIntent, astraCommercialReply } from './astra-commercial.js';
import { ASTRA_PRIMARY_CHECKOUT_URL } from '../config/astra-public-urls.js';
import { channelToolsForMessage, requiredChannelSubscriptionTool } from './tool-selection.js';
import { channelFailureReply } from './channel-failure.js';

describe('Astra commercial questions', () => {
  it.each([
    'Qual o valor da sua assinatura?',
    'Quanto custa seu serviço',
    'Quanto custa a assinatura do Astra?',
    'Qual é o preço do Astra?',
    'Qual a sua mensalidade?',
    'Quanto você cobra por mês?',
    'Quanto custa te usar?',
    'Astra, você é pago?',
    'Astra é pago?',
    'Quanto você custa?',
    'Qual o valor para assinar?',
    'Quanto custa a assinatura mensal do Astra?',
    'Como funciona a assinatura do Astra?',
    'Quero assinar',
    'Como faço para assinar o Astra?',
    'Me manda o link para assinar',
    'Quero contratar seu serviço',
    'Quero renovar minha assinatura do Astra',
  ])('answers with public price and checkout, not planning tools: %s', (text) => {
    const reply = astraCommercialReply(text);
    expect(reply?.text).toContain('R$ 19,90/mês');
    expect(reply?.urlButton?.url).toBe(ASTRA_PRIMARY_CHECKOUT_URL);
    expect(reply?.text).not.toContain('Minhas assinaturas');
    expect(requiredChannelSubscriptionTool(text)).toBeUndefined();
    expect(channelToolsForMessage(text, 'Mostre minhas assinaturas')).toEqual([]);
    expect(channelFailureReply(text, 'rate_limited')).toContain('R$ 19,90/mês');
  });

  it.each([
    'Minhas assinaturas',
    'Qual o preço da assinatura da música?',
    'Cadastre a assinatura Astra por R$ 19,90',
    'Quero assinar Netflix',
    'Qual o valor da sua assinatura da Netflix?',
    'Quanto custa seu serviço e registre uma despesa',
    'Me lembre de pagar a assinatura do Astra',
    'Quanto gastei com a assinatura do Astra?',
    'Qual o valor da assinatura e crie um lembrete?',
    'Cancele a assinatura do jornal',
    'Me manda o link',
  ])('does not consume an unrelated or compound request: %s', (text) => {
    expect(astraCommercialIntent(text)).toBeNull();
  });

  it('keeps trial facts conditional and cancellation separate from buying', () => {
    expect(astraCommercialReply('Tem teste grátis?')?.text).toContain('Novos contatos');
    expect(astraCommercialReply('Como cancelar minha assinatura do Astra?')?.text).toContain(
      '/suporte'
    );
    expect(
      astraCommercialReply('Como cancelar minha assinatura do Astra?')?.urlButton
    ).toBeUndefined();
  });

  it('preserves the server-known referral and warns paid users against duplicate payment', () => {
    const reply = astraCommercialReply('Quero assinar', { referral: 'julio', paidAccess: true });
    expect(reply?.urlButton?.url).toBe('https://pay.cakto.com.br/CubL455?affiliate=oYTQCyX6');
    expect(reply?.text).toContain('antes de fazer outro pagamento');
    expect(astraCommercialReply('Quero assinar', { referral: 'untrusted' })?.urlButton?.url).toBe(
      ASTRA_PRIMARY_CHECKOUT_URL
    );
  });
});
