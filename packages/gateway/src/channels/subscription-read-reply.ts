import { CustomerPlanningRepository } from '../db/repositories/customer-planning.js';
import { formatAstraMessage } from './response-presentation.js';

/** A narrow read needs no generated tool arguments, even during an AI outage. */
export async function quickSubscriptionReadReply(
  channel: string,
  text: string,
  userId: string
): Promise<string | null> {
  const input = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  if (
    !userId.trim() ||
    !/^(?:e\s+)?(?:qual (?:foi|e|era) (?:o valor d[ae] )?(?:(?:a )?minha |a )?ultima assinatura|qual (?:o )?valor da (?:minha )?ultima assinatura|minha ultima assinatura)[.!?]*$/u.test(
      input
    )
  )
    return null;
  let answer: string;
  try {
    const plans = await new CustomerPlanningRepository(userId).subscriptions();
    const latest = [...plans].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)
    )[0];
    if (!latest)
      return '🔁 *Suas assinaturas*\n\nVocê ainda não tem assinaturas cadastradas no seu planejamento.';
    if (!Number.isFinite(Date.parse(latest.createdAt)) || !Number.isFinite(latest.amount))
      return null;
    const plain = (value: string) => value.replace(/[\r\n*_`<>]/g, ' ').trim();
    const date = latest.nextDueDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    answer = formatAstraMessage('🔁 Sua última assinatura', [
      { label: 'Assinatura', value: plain(latest.title) },
      {
        label: 'Valor',
        value: latest.amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      },
      {
        label: 'Próxima renovação',
        value: date ? `${date[3]}/${date[2]}/${date[1]}` : 'Não informada',
      },
    ]);
  } catch {
    return 'Não consegui consultar suas assinaturas agora. Pode me pedir de novo em instantes?';
  }
  try {
    const { writeShortChannelReply } = await import('./short-channel-reply.js');
    const line = await writeShortChannelReply(
      channel,
      'Você é o Astra, assessor pessoal. Escreva uma abertura natural de até oito palavras para apresentar uma consulta já concluída. Não cite valores, nomes, datas, estados, telas nem confirme alterações. Não diga que ainda vai buscar os dados.',
      'A pessoa pediu para conferir sua última assinatura cadastrada.',
      26,
      Date.now() + 1200
    );
    if (
      line &&
      /^[\p{L}\p{M} ,.!]{2,65}$/u.test(line) &&
      /^(?:Aqui|Claro|Pronto|Certo|Encontrei|Vamos)\b/u.test(line) &&
      !/\b(?:salvei|marquei|agendei|cancelei|registrei|paguei|exclui|alterei|ativo|cancelado|busc|consultarei)\b/iu.test(
        line
      )
    )
      return line + '\n\n' + answer;
  } catch {
    // Facts remain available when optional personality generation is unavailable.
  }
  return answer;
}
