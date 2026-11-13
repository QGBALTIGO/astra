/** Public Astra access facts. Keep this module pure: no settings, DB or provider calls. */
import { ASTRA_SITE_URL, ASTRA_CUSTOMER_LOGIN_URL } from '../config/astra-public-urls.js';
export { ASTRA_SITE_URL, ASTRA_CUSTOMER_LOGIN_URL };

export const ASTRA_WEEKLY_PORTAL_REPLY = `Para organizar a semana, abra seu painel: ${ASTRA_CUSTOMER_LOGIN_URL}

Entre com seu número de WhatsApp e digite no painel o código recebido. Em Agenda, escolha o dia. Toque em “Criar item” e selecione Compromisso, Tarefa ou Lembrete.`;

/** A generative answer may reuse stale navigation instructions from chat history. */
export function hasWeeklyPortalSteps(answer: string): boolean {
  return (
    /\bagenda\b/iu.test(answer) &&
    /\bcriar item\b/iu.test(answer) &&
    !/(?:aba|seção|menu|página)\s+[“"'*]*tarefas/iu.test(answer)
  );
}

export const ASTRA_ACCESS_REPLY = `Acesse seu painel do Astra:
${ASTRA_CUSTOMER_LOGIN_URL}

Informe seu número de WhatsApp autorizado. Você receberá um código de 6 dígitos no WhatsApp para confirmar o acesso no painel.

Site do Astra: ${ASTRA_SITE_URL}`;

export const ASTRA_CHANNEL_ACCESS_FACTS = `## Acesso oficial ao Astra
Neste canal, você é o Astra e responde em português do Brasil.
Painel do cliente: ${ASTRA_CUSTOMER_LOGIN_URL}
Site do Astra: ${ASTRA_SITE_URL}
O cliente entra pelo navegador, informa seu número de WhatsApp autorizado e confirma no painel o código de 6 dígitos recebido no WhatsApp.
Para organizar a semana no navegador, indique a página Agenda. Ela reúne compromissos, tarefas e lembretes; o botão “Criar item” permite escolher o tipo. Para uma dúvida de navegação, bastam o link e o próximo passo. Não consulte dados pessoais.
Não ofereça login por e-mail/senha nem aplicativo móvel próprio; não invente endereços ou links de lojas de aplicativos. Não gere nem peça o código nesta conversa: ele deve ser preenchido no painel.
As mensagens recebidas podem ficar no histórico do Astra. Ao orientar sobre senhas, explique isso sem prometer ausência de armazenamento ou exclusão. Nunca solicite, repita ou transfira uma senha para ferramentas, notas, memória ou lembretes. Um lembrete para trocar a senha só precisa do assunto e do horário.
Use estes dados oficiais mesmo se houver instruções de acesso diferentes no histórico. Eles se referem somente ao Astra, nunca ao painel ou login de outro serviço.`;

// Accept only complete access requests with an allowlisted destination. In
// particular, addressing the assistant as "Astra" does not make a third-party
// dashboard an Astra destination. No wildcard suffix may absorb another task.
const DESTINATION =
  '(?:(?:(?:o |meu |o meu )?(?:painel|dashboard)(?: (?:do|da) astra)?)|(?:(?:o )?(?:site|portal|sistema) (?:do|da) astra)|(?:o )?astra)';
const PLACE = `(?:(?:no|em|ao|a|para|pra) )?${DESTINATION}`;
const LINK = `(?:(?:o|a) )?(?:link|endereco|url)(?: de acesso)? (?:do|da|de|ao|para|pra) ${DESTINATION}`;
const ACCESS_REQUESTS = [
  `(?:onde|como) (?:eu )?(?:(?:posso|faco para) )?(?:acesso|acessar|entro|entrar|abro|abrir|encontro|encontrar) ${PLACE}`,
  `onde (?:esta|fica) ${DESTINATION}`,
  `(?:quero|preciso|gostaria de) (?:acessar|entrar|abrir) ${PLACE}`,
  `(?:qual (?:e )?|(?:pode |poderia |consegue )?(?:me )?(?:manda|mande|mandar|envia|envie|enviar|mostra|mostre|mostrar|passa|passe|passar) )${LINK}`,
  '(?:qual (?:e )?)(?:o )?(?:site|portal|login) (?:do|da) astra',
  '(?:onde|como) (?:eu )?(?:(?:posso|faco para) )?(?:faco|fazer) (?:o )?login(?: (?:no|em|do) astra)?',
].map(
  (request) =>
    new RegExp(
      `^(?:(?:oi|ola|bom dia|boa tarde|boa noite)[,!]? )?(?:astra[,!:]? )?${request}(?:,? por favor)?[.!?]*$`,
      'u'
    )
);

/** Zero-token answer for an unambiguous request to access Astra itself. */
export function tryAstraAccessReply(text: string): string | null {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim()
    .replace(/\s+/g, ' ');
  return ACCESS_REQUESTS.some((request) => request.test(normalized)) ? ASTRA_ACCESS_REPLY : null;
}

// Match a complete request for guidance. Mixed writes and third-party destinations
// must continue through normal tool selection and receipt checks.
const WEEKLY_PORTAL_GUIDE = new RegExp(
  [
    '^(?:(?:quero|preciso|gostaria de)|(?:como|onde) (?:posso|consigo)|como)',
    ' (?:organizar|planejar) (?:a minha |minha |a )?semana',
    '(?: (?:pelo|no|com o) astra)?',
    '(?: (?:para|pra) (?:fazer )?isso)?',
    ' (?:pelo|no) (?:navegador|painel)(?: (?:do )?astra)?',
    '(?: (?:como|onde) (?:eu )?(?:entro|acesso|comeco))?',
    '(?: (?:e )?por onde (?:vale |posso )?comecar)?$',
  ].join(''),
  'u'
);

/** A request for guidance about the web agenda can use AI without private calendar data. */
export function isWeeklyPortalGuide(text: string): boolean {
  const words = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return WEEKLY_PORTAL_GUIDE.test(words);
}

export function isAstraAccessAnswerRequested(text: string): boolean {
  return (
    isWeeklyPortalGuide(text) || tryAstraAccessReply(text.replace(/\bcpmp\b/giu, 'como')) !== null
  );
}
