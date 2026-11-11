/** Final channel boundary: model text is not proof of a database write. */
import { stripInternalTags } from './normalizers/base.js';
import { customerFacingText, savedReminderConfirmation } from './customer-facing-response.js';

export interface ChannelToolReceipt {
  name: string;
  arguments: string;
  content: string;
  isError: boolean;
}
const protocol =
  /<\/?(?:tool_call|tool_calls|function_call|function_calls|arg_key|arg_value)(?:\s|>)/i;
const normalizeName = (value: string) => value.replace(/__/g, '.').replace(/^core\./, '');
function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Resolve native and meta-tool receipts, including partial batch failures. */
export function successfulChannelTools(receipts: ChannelToolReceipt[]): Set<string> {
  const names = new Set<string>();
  for (const receipt of receipts) {
    const result = json(receipt.content);
    const data = object(result);
    if (receipt.isError || data?.success === false || data?.isError === true || data?.error)
      continue;
    const name = normalizeName(receipt.name);
    if (name !== 'batch_use_tool' && name !== 'use_tool') names.add(name);
  }
  return names;
}

export function safeChannelResponse(text: string, receipts: ChannelToolReceipt[]): string {
  const clean = customerFacingText(stripInternalTags(text));
  const tools = successfulChannelTools(receipts);
  const has = (...names: string[]) => names.some((name) => tools.has(name));
  const lower = clean
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  // Check claims sentence-by-sentence; a failure elsewhere cannot exempt a false
  // success. Questions and explicit negative statements are not confirmations.
  const statements = lower
    .split(/[.!?\n]+/)
    .filter((sentence) => !/\b(?:nao|nunca|ainda nao|nao foi)\b/.test(sentence));
  let unsupported = false;
  for (const sentence of statements) {
    if (
      /\b(?:lembrete\s+(?:re)?agendado|(?:re)?agendei|voce sera avisado|vou (?:te )?(?:avisar|lembrar))\b/.test(
        sentence
      ) &&
      !has('schedule_channel_reminder', 'reschedule_channel_reminder')
    )
      unsupported = true;
    if (/\blembrete\s+cancelado\b/.test(sentence) && !has('cancel_channel_reminder'))
      unsupported = true;
    if (
      /\b(?:salvei|guardei|memorizei)\b.*\b(?:nome|memoria|informacao)|\b(?:nome|informacao)\b.*\b(?:salvo|salva|guardado|guardada)\b/.test(
        sentence
      ) &&
      !has('create_memory', 'batch_create_memories')
    )
      unsupported = true;
    if (
      /\b(?:tarefa\s+(?:criada|registrada)|criei (?:uma |a )?tarefa)\b/.test(sentence) &&
      !has('add_task', 'batch_add_tasks')
    )
      unsupported = true;
    if (
      /\b(?:registrei|lancei|registrad[oa]|lancad[oa])\b/.test(sentence) &&
      /\b(?:entrada|saida|despesa|receita|recebimento|lancamento|valor)\b/.test(sentence) &&
      !has('record_transaction', 'add_expense', 'batch_add_expenses', 'record_financing_payment')
    )
      unsupported = true;
    if (
      /\b(?:corrigi|alterei|atualizei|corrigid[oa]|atualizad[oa])\b/.test(sentence) &&
      /\b(?:entrada|saida|despesa|receita|recebimento|lancamento|valor)\b/.test(sentence) &&
      !has('update_transaction', 'update_expense')
    )
      unsupported = true;
    if (
      /\b(?:exclui|removi|excluid[oa]|removid[oa])\b/.test(sentence) &&
      /\b(?:entrada|saida|despesa|receita|recebimento|lancamento|registro)\b/.test(sentence) &&
      !has('delete_transaction', 'delete_expense')
    )
      unsupported = true;
  }
  if (!protocol.test(text) && clean && !unsupported) {
    return savedReminderConfirmation(receipts) ?? clean;
  }
  const confirmed: string[] = [];
  if (has('schedule_channel_reminder', 'reschedule_channel_reminder'))
    confirmed.push('um lembrete salvo');
  if (has('record_transaction', 'add_expense', 'batch_add_expenses'))
    confirmed.push('um lançamento financeiro salvo');
  if (has('update_transaction', 'update_expense'))
    confirmed.push('a atualização do lançamento financeiro');
  if (has('delete_transaction', 'delete_expense'))
    confirmed.push('a exclusão do lançamento financeiro');
  if (has('add_task', 'batch_add_tasks')) confirmed.push('uma tarefa salva');
  if (has('create_memory', 'batch_create_memories'))
    confirmed.push('a informação salva na memória');
  if (has('cancel_channel_reminder')) confirmed.push('o cancelamento do lembrete');
  return confirmed.length
    ? `Confirmei ${confirmed.join(' e ')}. Não consegui confirmar as demais partes da resposta. Confira os registros antes de repetir o pedido.`
    : 'Não consegui confirmar a execução desse pedido. Não vou informar que ficou pronto sem verificar. Confira seus registros antes de tentar novamente; para um lembrete, informe o assunto e o horário.';
}
