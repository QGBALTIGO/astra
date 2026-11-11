/** Presentation only: internal receipt identifiers remain available to the agent. */
import type { ChannelToolReceipt } from './response-safety.js';

const uuid =
  /\b[\da-f]{8}\s*[-–—]\s*[\da-f]{4}\s*[-–—]\s*[\da-f]{4}\s*[-–—]\s*[\da-f]{4}\s*[-–—]\s*[\da-f]{12}\b/gi;
const toolName = (name: string) => name.replace(/__/g, '.').replace(/^core\./, '');

export function customerFacingText(text: string): string {
  return text
    .replace(uuid, '')
    .replace(
      /\b(?:O |Este )?(?:lembrete|registro) foi criado com o ID[\s`*]*(?:e est[aá][^.!?\n]*)?[.!?]?/gi,
      ''
    )
    .replace(
      /\b(?:ID|UUID|identificador interno|reminder_id|transaction_id|delivery_id)\s*[:=]?[\s`*]*(?=[.!?\n]|$)/gi,
      ''
    )
    .replace(/\b(?:e est[aá] |est[aá] )?pendente de envio(?: nesta conversa)?[.!?]?/gi, '')
    .replace(/\bcore[._][a-z][a-z0-9_]+\b/g, 'recurso do Astra')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Render only a successful, still-pending reminder from its persisted receipt.
 * Mixed actions and failures keep the normal response safety checks instead.
 */
export function savedReminderConfirmation(receipts: ChannelToolReceipt[]): string | null {
  const reminders: string[] = [];
  for (const receipt of receipts) {
    const name = toolName(receipt.name);
    if (/^(?:list_|get_|search_)/.test(name)) continue;
    if (name === 'batch_use_tool') return null;
    if (name === 'use_tool') {
      if (receipt.isError) return null;
      try {
        const result = JSON.parse(receipt.content);
        if (result?.success === false || result?.isError === true || result?.error) return null;
      } catch {
        return null;
      }
      continue;
    }
    if (name !== 'schedule_channel_reminder' && name !== 'reschedule_channel_reminder') return null;
    if (receipt.isError) return null;
    try {
      const envelope = JSON.parse(receipt.content);
      const saved = envelope?.result;
      if (
        envelope?.success !== true ||
        envelope.isError === true ||
        envelope.error ||
        saved?.status !== 'pending' ||
        typeof saved.title !== 'string' ||
        typeof saved.agendadoPara !== 'string' ||
        typeof saved.timeZone !== 'string'
      ) {
        return null;
      }
      const date = new Date(saved.agendadoPara);
      if (!Number.isFinite(date.getTime())) return null;
      const title = customerFacingText(saved.title)
        .replace(/[\r\n*`<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!title) return null;
      const day = new Intl.DateTimeFormat('pt-BR', {
        timeZone: saved.timeZone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(date);
      const time = new Intl.DateTimeFormat('pt-BR', {
        timeZone: saved.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(date);
      const heading = name === 'reschedule_channel_reminder' ? 'reagendado' : 'agendado';
      reminders.push(`✅ *Lembrete ${heading}!*\n\n*${title}*\n📅 ${day} às ${time}`);
    } catch {
      return null;
    }
  }
  return reminders.length
    ? `${reminders.join('\n\n')}\n\nVou te lembrar por aqui, no seu horário local. 💙`
    : null;
}
