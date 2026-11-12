import type { ChannelPlatform } from '@ownpilot/core/channels';

/** Explain the difference between a planner entry and moving money or ending a contract. */
export function financialCapabilityReply(platform: ChannelPlatform, text: string): string | null {
  if ((platform !== 'whatsapp' && platform !== 'telegram') || text.length > 700) return null;
  const input = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/^(?:astra[,! ]+\s*)?(?:por favor[, ]+\s*)?/u, '');
  const bankRequest =
    /^(?:(?:voce\s+)?(?:pode|consegue|poderia)\s+)?(?:(?:faz|faca|fazer|envie|envia|enviar|manda|mande|mandar)\s+(?:(?:um|o|esse|este)\s+)?pix|(?:paga|pague|pagar|quita|quite|quitar)\s+(?:(?:ess[ae]|est[ae]|meu|minha|[ao]|uma?)\s+)?(?:boleto|fatura))\b/u;
  const bankQuestion =
    /^(?:da (?:para|pra)|posso) (?:fazer (?:um )?pix|pagar (?:o |um )?boleto) (?:por aqui|pelo astra|no whatsapp|no telegram)\b/u;
  if (bankRequest.test(input) || bankQuestion.test(input)) {
    const subject = /\bpix\b/u.test(input) ? 'O Pix' : 'O pagamento';
    return (
      subject +
      ' você faz pelo app do seu banco. Por aqui, posso te lembrar do vencimento ou anotar a despesa depois que você pagar.'
    );
  }
  if (!/\bassinatura\b/u.test(input)) return null;
  const outsidePlanner =
    /^(?:se eu |quando eu |ao )(?:tirar|remover|excluir|cancelar)\b/u.test(input) &&
    /\b(?:planejamento|controle|astra|daqui)\b/u.test(input) &&
    /\b(?:cobranca|contrato|fornecedor|servico)\b/u.test(input) &&
    input.includes('?');
  const providerCancellation =
    /^(?:(?:voce\s+)?(?:pode|consegue|poderia)\s+)?(?:cancele|cancela|cancelar|encerre|encerra|encerrar)\s+(?:(?:a|minha|esta|essa)\s+){0,2}assinatura\b/u.test(
      input
    ) &&
    /\b(?:no|na|pelo|pela|com o|com a)\s+(?:propri[oa]\s+)?(?:fornecedor|servico|plataforma|provedor)\b/u.test(
      input
    ) &&
    !/\bnao\b/u.test(input);
  if (outsidePlanner || providerCancellation) {
    return 'Tirar a assinatura do seu planejamento só muda o que aparece aqui no Astra. Para encerrar a cobrança, cancele pelo serviço em que você assinou. Se quiser, posso te lembrar antes da próxima renovação.';
  }
  return null;
}
