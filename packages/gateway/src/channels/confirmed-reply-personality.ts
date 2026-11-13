/** Write the conversational opening separately from the facts that authorize a receipt. */
import { writeShortChannelReply } from './short-channel-reply.js';
import {
  isDiscreetSubject,
  safeContactFirstName,
  subjectEmoji,
} from './channel-personalization.js';
const busy = new Set<string>();
const MAX_WAIT_MS = 5_000;
const style =
  'Você conversa em português do Brasil no WhatsApp. Escreva uma abertura curta, espontânea e específica para o assunto informado como dado JSON. O aplicativo mostrará logo abaixo a confirmação, com os dados exatos. Não repita o comprovante. Em assunto leve, cabe um emoji que combine ou um trocadilho curto, se soar natural. Em assuntos delicados, seja discreto, sem humor nem conselho. O nome é opcional. Reaja a um detalhe concreto da mensagem atual, com uma expressão que faça sentido para esse assunto. Evite lição de moral, repetir que algo foi registrado, ofertas genéricas e frases de atendimento. Para um lembrete, reaja apenas ao assunto, sem afirmar a localização de objetos, disponibilidade, estado do mundo ou o que outra pessoa fez. Não invente detalhes, números ou ações. Use uma observação, sem pergunta de acompanhamento e sem dizer que uma assinatura está ativa. Responda somente com uma frase de até 15 palavras.';

export function safePersonalComment(content: string): string | null {
  const text = content.trim();
  if (
    !text ||
    text.includes('?') ||
    text.length > 125 ||
    text.split(/\s+/u).length > 20 ||
    /[\r\n\p{Cc}\d{}<>*_~]/u.test(text) ||
    /\b(?:gpt|chatgpt|openai|gemini|claude|qwen|ollama|groq|railway|zerad[oa]|tudo limpo)\b/iu.test(
      text
    ) ||
    /\b(?:ta|tá|está|esta|ficou|foi)\s+(?:marcad[oa]|agendad[oa]|programad[oa]|ativ[oa]|confirmad[oa])\b/iu.test(
      text
    ) ||
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
function withoutSafeIntro(text: string): string | null {
  const separator = text.indexOf('\n\n');
  if (separator < 0) return null;
  const rest = text.slice(separator + 2);
  return safePersonalComment(text.slice(0, separator)) && /^(?:✅|⏳|📅) \*/u.test(rest)
    ? rest
    : null;
}

/** Only a single, complete known receipt is eligible. Keep mixed requests and failures intact. */
export function receiptContext(text: string): Receipt | null {
  const withoutIntro = withoutSafeIntro(text);
  if (withoutIntro) return receiptContext(withoutIntro);
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

/** Keep the verified fields readable even when the style writer is busy or unavailable. */
function confirmationCard(text: string, receipt: Receipt): string {
  const icon = subjectEmoji(receipt.subject);
  if (/^(?:✅|⏳|📅) \*/u.test(text)) {
    return text
      .replace(/^(?:✅|⏳|📅)(?= \*)/u, (match) => icon ?? match)
      .replace(/(• \*Data e hora:\* \d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}):\d{2}(?=\n|$)/u, '$1');
  }
  const plan =
    /^Assinatura (adicionada ao|atualizada no) seu controle: (.+) · ([^·\n]+) · renovação (?:em (\d{2}\/\d{2}\/\d{4})|sem data)\.$/u.exec(
      text
    );
  if (plan)
    return [
      '🔁 *' +
        (plan[1] === 'adicionada ao' ? 'Assinatura cadastrada' : 'Assinatura atualizada') +
        '*',
      '',
      '• *Nome:* ' + plan[2],
      '• *Valor:* ' + plan[3],
      '• *Renovação:* ' + (plan[4] ?? 'Sem data definida'),
    ].join('\n');
  if (receipt.action === 'tarefa')
    return [
      text.startsWith('Marquei') ? '✅ *Tarefa concluída*' : '📝 *Tarefa adicionada*',
      '',
      '• *Tarefa:* ' + receipt.subject,
      text.startsWith('Marquei') ? '• *Status:* Concluída' : '• *Status:* Pendente',
    ].join('\n');
  return text;
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
  const withoutIntro = withoutSafeIntro(input.responseText);
  if (withoutIntro && receiptContext(withoutIntro)) return input.responseText;
  const receipt = receiptContext(input.responseText);
  if (!receipt) return input.responseText;
  const fallback = confirmationCard(input.responseText, receipt);
  if (isDiscreetSubject(receipt.subject)) return fallback;
  const key = input.channelPluginId + '|' + input.dataUserId;
  if (busy.has(key) || busy.size >= 8) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + MAX_WAIT_MS;
  busy.add(key);
  const work = (async () => {
    const name = safeContactFirstName(input.displayName);
    // A stable sample on retries avoids a name in every turn and stores no contact history.
    const mentionName =
      Array.from(input.messageId).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3 === 0;
    const prompt = JSON.stringify({
      assunto: receipt.subject.slice(0, 140),
      contexto: receipt.action,
      ...(name && mentionName ? { nome: name } : {}),
    });
    const line = await writeShortChannelReply(input.channelPluginId, style, prompt, 42, deadline);
    const opening = line ? safePersonalComment(line) : null;
    if (
      opening &&
      /^Lembrete /u.test(receipt.action) &&
      /\b(?:est[áã]|estão|t[áã]|fica|ficou|deixou|guardad[oa]|disponível|pront[oa]|chegou|esperando|encontra|encontrar|na pasta|no armário|na estante)(?=\s|[.!?,]|$)/iu.test(
        opening
      )
    )
      return fallback;
    // A tracked subscription is a personal note, not a receipt from the merchant.
    if (
      receipt.action === 'assinatura' &&
      opening &&
      /\b(?:ativ[ao]s?|inativ[ao]s?|valid[ao]s?|vigente|vence|vencimento|renova|renovação|cadastro|fim do mês|até|plano|cobrança|assinatura)\b/iu.test(
        opening
      )
    )
      return fallback;
    return opening ? opening + '\n\n' + fallback : fallback;
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
