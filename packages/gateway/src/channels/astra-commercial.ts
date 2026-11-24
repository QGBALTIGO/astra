/** Public commercial facts. Never read or mutate personal financial plans here. */
import { ASTRA_PRIMARY_CHECKOUT_URL, ASTRA_SITE_URL } from '../config/astra-public-urls.js';
import { ASTRA_JULIO_CHECKOUT_URL } from './trial-entry.js';

export const ASTRA_MONTHLY_PRICE = 'R$ 19,90/mês';
export const ASTRA_COMMERCIAL_FACTS = `O plano de assinatura do próprio Astra custa ${ASTRA_MONTHLY_PRICE}. Novos contatos podem experimentar por 3 dias sem cartão e sem cobrança automática ao fim do teste. Contratação pelo checkout oficial ${ASTRA_PRIMARY_CHECKOUT_URL}. Se a pessoa perguntar "qual o valor da sua assinatura", "quanto custa seu serviço", "quero assinar" ou sobre o preço do Astra, responda sobre o Astra, não sobre o planejamento financeiro do cliente. Não use ferramentas de assinaturas pessoais para contratar, consultar, renovar ou cancelar o acesso ao Astra. Não invente descontos, preços, pagamentos ou estado do acesso. Para dúvidas de cobrança, cancelamento ou acesso individual, encaminhe para ${ASTRA_SITE_URL}/suporte.`;

type Intent = 'price' | 'subscribe' | 'trial' | 'support';

/** Recognize whole commercial questions; a named third-party service or write stays on its own route. */
export function astraCommercialIntent(text: string): Intent | null {
  if (text.length > 350) return null;
  const input = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:oi|ola|bom dia|boa tarde|boa noite)[,!. ]+/, '')
    .replace(/^astra[,!: ]+/, '')
    .replace(/,? por favor[.!?]*$/, '')
    .replace(/[.!?]+$/, '')
    .trim();

  const ownPlan =
    '(?:(?:a )?sua (?:assinatura|mensalidade)|(?:o )?seu (?:servico|plano|acesso|preco)|(?:a |o )?(?:assinatura|mensalidade|plano|servico|acesso) d[oa] astra|(?:a |o )?astra|voce|vc|voces|te usar|usar (?:voce|vc|o astra))';
  const price = [
    `(?:qual (?:e )?(?:o )?(?:valor|preco|custo)(?: d[oa]| de)?|quanto (?:custa|fica|sai|e)|quanto (?:eu )?pago (?:por|para)|quanto (?:voce|vc|voces) cobra(?:m)?(?: (?:por|pelo|pela))?) ${ownPlan}(?: (?:por mes|ao mes|mensalmente))?`,
    `${ownPlan} (?:custa quanto|quanto custa|e pago|e paga|tem custo|tem mensalidade)`,
    'quanto (?:voce|vc|voces) cobra(?:m)?(?: por mes| ao mes)?',
    'qual (?:e )?(?:a )?(?:mensalidade|sua mensalidade)(?: do astra)?',
    'qual (?:e )?(?:o )?seu (?:valor|preco)',
    `como funciona ${ownPlan}`,
  ];
  if (price.some((pattern) => new RegExp('^' + pattern + '$', 'u').test(input))) return 'price';

  const subscribe = [
    '(?:quero|gostaria de|pretendo|preciso|vou) (?:assinar|contratar|comprar)(?: (?:o astra|astra|seu servico|o seu servico|seu plano|o plano do astra|a assinatura do astra))?',
    '(?:como|onde) (?:eu )?(?:(?:posso|consigo|faco para) )?(?:assino|assinar|contrato|contratar)(?: (?:o astra|astra|seu servico|o seu servico|seu plano|o plano do astra))?',
    '(?:quero|gostaria de) (?:fazer|ter) (?:uma |a )?assinatura(?: do astra)?',
    '(?:(?:pode|consegue|poderia) )?(?:me )?(?:manda|mande|mandar|envia|envie|enviar|passa|passe|passar) (?:o )?link (?:para|pra|de) (?:assinar|contratar|assinatura)(?: (?:o astra|do astra))?',
    '(?:qual (?:e )?|quero )(?:o )?link (?:para|pra|de) (?:assinar|contratar|assinatura)(?: (?:o astra|do astra))?',
    '(?:quero|como (?:posso|faco para)) renovar (?:o astra|meu acesso ao astra|(?:a |minha )?assinatura do astra)',
  ];
  if (subscribe.some((pattern) => new RegExp('^' + pattern + '$', 'u').test(input)))
    return 'subscribe';

  if (
    /^(?:(?:o )?astra |voce |vc )?(?:tem (?:um )?teste gratis|e gratuito|e gratis|posso testar de graca|posso testar gratis)$/u.test(
      input
    ) ||
    /^(?:como funciona|quanto tempo dura|quantos dias dura) (?:o )?teste gratis(?: do astra)?$/u.test(
      input
    )
  )
    return 'trial';

  if (
    /^(?:(?:como|onde) (?:eu )?(?:posso |faco para )?|quero |preciso )?(?:cancelar|cancelo|cancele|cancelamento de) (?:a |minha )?assinatura do astra$/u.test(
      input
    ) ||
    /^(?:quando (?:vence|renova)|qual (?:e )?a (?:data de|proxima) renovacao de) (?:a |minha )?assinatura do astra$/u.test(
      input
    ) ||
    /^(?:ja paguei|paguei) (?:a |minha )?assinatura do astra$/u.test(input)
  )
    return 'support';

  return null;
}

export function astraCommercialReply(
  text: string,
  options: { referral?: unknown; paidAccess?: boolean } = {}
): { text: string; urlButton?: { label: string; url: string } } | null {
  const intent = astraCommercialIntent(text);
  if (!intent) return null;
  if (intent === 'support')
    return {
      text: `Posso te orientar sobre a assinatura do próprio Astra. Para verificar sua cobrança, vencimento ou solicitar cancelamento, fale com nossa equipe: ${ASTRA_SITE_URL}/suporte. Não fiz nenhuma alteração na sua assinatura.`,
    };
  const url =
    options.referral === 'julio' ? ASTRA_JULIO_CHECKOUT_URL : ASTRA_PRIMARY_CHECKOUT_URL;
  const trial =
    'Novos contatos podem experimentar por 3 dias grátis, sem cartão e sem cobrança automática ao fim do teste.';
  if (intent === 'trial')
    return {
      text: `${trial}\n\nDepois, se quiser continuar, a assinatura custa *${ASTRA_MONTHLY_PRICE}*.\n\nConheça o plano: ${ASTRA_SITE_URL}/#plano`,
    };
  const intro =
    intent === 'subscribe'
      ? `Que bom que quer continuar comigo! 💙 O plano do Astra custa *${ASTRA_MONTHLY_PRICE}*.`
      : `Minha assinatura custa *${ASTRA_MONTHLY_PRICE}*! 💙`;
  const next = options.paidAccess
    ? 'Se já tem uma assinatura ativa, confira sua contratação antes de fazer outro pagamento.'
    : 'Seu acesso pago será liberado após a confirmação do pagamento.';
  return {
    text: [
      intro,
      'Você conta comigo para organizar finanças, agenda, tarefas, lembretes, metas e notas pelo WhatsApp, com acesso ao painel.',
      trial,
      `Para assinar, acesse o checkout oficial: ${url}\n\n${next}`,
    ].join('\n\n'),
    urlButton: { label: 'Assinar o Astra', url },
  };
}
