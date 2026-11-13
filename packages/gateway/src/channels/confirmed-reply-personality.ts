/** Write the conversational opening separately from the facts that authorize a receipt. */
import { createProvider, type ProviderConfig } from '@ownpilot/core/agent';
import {
  isDiscreetSubject,
  safeContactFirstName,
  subjectEmoji,
} from './channel-personalization.js';
import { resolveForChannel } from '../services/llm/model-routing.js';
import {
  getProviderApiKey,
  loadProviderConfig,
  NATIVE_PROVIDERS,
} from '../services/agent/cache.js';
import { resolveAuthForRequest } from '../services/auth/oauth-flow.js';

const busy = new Set<string>();
const MAX_WAIT_MS = 5_000;
const style =
  'Você conversa em português do Brasil no WhatsApp. Escreva uma abertura curta, espontânea e específica para o assunto informado como dado JSON. O aplicativo mostrará logo abaixo a confirmação, com os dados exatos. Não repita o comprovante. Em assunto leve, cabe um emoji que combine ou um trocadilho curto, se soar natural. Em assuntos delicados, seja discreto, sem humor nem conselho. O nome é opcional. Reaja a um detalhe concreto da mensagem atual, com uma expressão que faça sentido para esse assunto. Evite lição de moral, repetir que algo foi registrado, ofertas genéricas e frases de atendimento. Não invente detalhes, números ou ações. Use uma observação, sem pergunta de acompanhamento e sem dizer que uma assinatura está ativa. Responda somente com uma frase de até 15 palavras.';

export function safePersonalComment(content: string): string | null {
  const text = content.trim();
  if (
    !text ||
    text.includes('?') ||
    text.length > 125 ||
    text.split(/\s+/u).length > 20 ||
    /[\r\n\p{Cc}\d{}<>*_~]/u.test(text) ||
    /[\u200b\u200e-\u200f\u202a-\u202e\u2060-\u2069]/u.test(text) ||
    /(?:https?:|www\.|@|\b[\w-]+\.(?:com|net|org|pro|app)\b|r\$|usd|eur|brl|core\.|use_tool|json|prompt|sistema interno)/iu.test(
      text
    ) ||
    /\b(?:registrei|salvei|confirmei|transferi|paguei|recebi|agendei|exclu[ií]|cancelei|saldo|total|amanhã|hoje às|ontem|reais|dólares|euros|ativad[ao]|renovad[ao]|quitad[ao]|transferid[ao]|pag[ao]s?|cobrad[ao]|confirmad[ao]|autorizad[ao])\b/iu.test(
      text
    )
  )
    return null;
  return text;
}

type Receipt = { subject: string; facts: string; action: string };

/** Only a single, complete known receipt is eligible. Keep mixed requests and failures intact. */
function receiptContext(text: string): Receipt | null {
  const simple =
    /^(?:Adicionei “([^”\n]+)” à sua lista de tarefas\. Ela está pendente\.|Marquei como concluída a tarefa “([^”\n]+)”\.|Assinatura (?:adicionada ao|atualizada no) seu controle: ([^·\n]+) · [^\n]+\.)$/u.exec(
      text
    );
  if (simple)
    return {
      subject: (simple[1] ?? simple[2] ?? simple[3]!).trim(),
      facts: text,
      action: simple[3] ? 'assinatura' : 'tarefa',
    };

  const [heading, body, footer, extra] = text.split('\n\n');
  if (
    !heading ||
    !body ||
    extra !== undefined ||
    (footer && footer !== 'Vou avisar você por aqui.')
  )
    return null;
  const title = /^(?:✅|⏳|📅) \*([^*]+)\*$/u.exec(heading)?.[1];
  if (!title) return null;
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = /^• \*([^*]+):\* (.+)$/u.exec(line);
    if (!match || fields.has(match[1]!)) return null;
    fields.set(match[1]!, match[2]!);
  }
  const subject = fields.get('Descrição') ?? fields.get('Assunto') ?? fields.get('Tarefa');
  if (!subject) return null;
  if (
    /^(?:Entrada|Despesa|Valor a (?:pagar|receber)) (?:já )?(?:registrad[ao]|atualizad[ao])$/u.test(
      title
    ) &&
    fields.has('Valor') &&
    [...fields.keys()].every((k) =>
      ['Valor', 'Descrição', 'Categoria', 'Data', 'Vencimento'].includes(k)
    )
  ) {
    const amount = fields.get('Valor')!;
    const details = [
      fields.get('Categoria'),
      fields.get('Data'),
      fields.get('Vencimento') && 'Vencimento: ' + fields.get('Vencimento'),
    ].filter(Boolean);
    return {
      subject,
      action: title,
      facts:
        title +
        ': *' +
        amount +
        '* · ' +
        subject +
        (details.length ? '\n' + details.join(' · ') : ''),
    };
  }
  if (
    /^Lembrete (?:agendado|reagendado)$/u.test(title) &&
    fields.has('Data e hora') &&
    fields.size === 2 &&
    fields.has('Assunto')
  ) {
    return {
      subject,
      action: title,
      facts: title + ' para *' + fields.get('Data e hora') + '*: ' + subject + '.',
    };
  }
  if (
    /^(?:Compromisso (?:agendado|remarcado|atualizado)|Tarefa (?:criada|concluída|atualizada))$/u.test(
      title
    )
  )
    return { subject, facts: text, action: title };
  return null;
}

export function isPersonalizableReceipt(text: string): boolean {
  return receiptContext(text) !== null;
}

export async function maybePersonalizeConfirmedReply(input: {
  responseText: string;
  channelPluginId: string;
  dataUserId: string;
  displayName?: string;
  messageId: string;
}): Promise<string> {
  const receipt = receiptContext(input.responseText);
  if (!receipt) return input.responseText;
  const icon = subjectEmoji(receipt.subject);
  const fallback = icon ? icon + ' ' + receipt.facts : receipt.facts;
  if (isDiscreetSubject(receipt.subject)) return fallback;
  const key = input.channelPluginId + '|' + input.dataUserId;
  if (busy.has(key) || busy.size >= 8) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + MAX_WAIT_MS;
  busy.add(key);
  const work = (async () => {
    const { provider, model } = await resolveForChannel(input.channelPluginId);
    if (!provider || !model || provider.startsWith('cli-')) return fallback;
    const config = loadProviderConfig(provider);
    const native = NATIVE_PROVIDERS.has(provider);
    if (!native && !config?.baseUrl) return fallback;
    const resolvedAuth = await resolveAuthForRequest(provider);
    const apiKey = resolvedAuth?.value ?? (await getProviderApiKey(provider));
    const remaining = deadline - Date.now();
    if (!apiKey || remaining <= 0) return fallback;
    const writer = createProvider({
      ...config,
      id: provider,
      provider: (native ? provider : 'openai') as ProviderConfig['provider'],
      apiKey,
      resolvedAuth,
      timeout: remaining,
      maxRetries: 0,
    });
    const name = safeContactFirstName(input.displayName);
    // A stable sample on retries avoids a name in every turn and stores no contact history.
    const mentionName =
      Array.from(input.messageId).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3 === 0;
    const prompt = JSON.stringify({
      assunto: receipt.subject.slice(0, 140),
      contexto: receipt.action,
      ...(name && mentionName ? { nome: name } : {}),
    });
    const result = await writer.complete({
      model: { model, maxTokens: 52, temperature: 0.85 },
      messages: [
        { role: 'system', content: style },
        { role: 'user', content: prompt },
      ],
    });
    const opening = result.ok ? safePersonalComment(result.value.content) : null;
    return opening ? opening + '\n\n' + receipt.facts : fallback;
  })()
    .catch(() => fallback)
    .finally(() => busy.delete(key));
  try {
    return await Promise.race([
      work,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(fallback), MAX_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
