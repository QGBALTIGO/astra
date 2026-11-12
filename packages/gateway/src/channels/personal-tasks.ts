import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import {
  CustomerAgendaError,
  CustomerAgendaRepository,
  type ChannelTaskResult,
} from '../db/repositories/customer-agenda.js';
import { getLog } from '../services/log.js';

const createTask =
  /^(?:adicione|adiciona|inclua|inclui|coloque|coloca|anote|anota|crie|cria|cadastre|cadastra)\s+(?:(?:à|a|na|em)\s+(?:minha\s+)?lista\s+de\s+tarefas|(?:uma\s+|a\s+)?tarefa(?:\s+na\s+minha\s+lista)?)\s*[:–-]?\s+(.+)$/iu;
const completeTask =
  /^(?:marque|marca|marcar)\s+como\s+conclu[ií]da\s+(?:s[oó]\s+)?(?:a\s+)?tarefa\s+(.+?)$|^(?:conclua|conclui|finalize|finaliza)\s+(?:s[oó]\s+)?(?:a\s+)?tarefa\s+(.+)$/iu;
const askTask =
  /^(?:consulte|consulta|confira|confere|procure|procura|verifique|verifica)\s+(?:a\s+)?tarefa\s+(.+?)$|^(?:qual\s+(?:[eé]\s+)?o\s+(?:estado|status)\s+da\s+tarefa)\s+(.+)$/iu;
const askStatus =
  /^(?:a\s+)?tarefa\s+(.+?)\s+(?:(?:ficou|est[aá]|continua)\s+(?:pendente|conclu[ií]da)(?:\s+na\s+minha\s+lista)?|consta\s+na\s+minha\s+lista)\??$/iu;
const states = {
  pending: 'pendente',
  in_progress: 'em andamento',
  completed: 'concluída',
  cancelled: 'cancelada',
};
const help =
  'Informe o título de uma tarefa por mensagem. Por exemplo, “Crie a tarefa Enviar proposta”, “Consulta a tarefa Enviar proposta” ou “Conclua a tarefa Enviar proposta”.';
type TaskRequest = { action: 'create' | 'complete' | 'lookup'; title: string };

function parseTask(input: string): TaskRequest | 'clarify' | null {
  if (!/\btarefas?\b/iu.test(input) || input.length > 500) return null;
  const text = input
    .trim()
    .replace(/^astra[,!]?\s+/iu, '')
    .replace(/[, ]+por favor[.!]?$/iu, '');
  // A short factual lead-in is common after the user has finished the task.
  const instruction = text.replace(
    /^j[aá]\s+(?:pedi|fiz|enviei|entreguei|recebi|resolvi|terminei)\s+[\p{L}\p{M}\d '-]{1,70}\.\s+/iu,
    ''
  );
  const done = completeTask.exec(instruction);
  const add = createTask.exec(text);
  const query = askTask.exec(text) ?? askStatus.exec(text);
  if (!add && !done && !query) {
    return /^(?:(?:crie|cria|adicione|inclua|cadastre|conclua|finalize|consulta|consulte)\s+(?:a|uma)\s+tarefa|marque\s+como\s+conclu[ií]da\s+a\s+tarefa)[.!?]?$/iu.test(
      text
    )
      ? 'clarify'
      : null;
  }
  let title = (add?.[1] ?? done?.[1] ?? done?.[2] ?? query?.[1] ?? query?.[2] ?? '').trim();
  if (done) title = title.replace(/,\s*se\s+ela\s+estiver\s+na\s+minha\s+lista[.!]?$/iu, '');
  if (query)
    title = title
      .replace(
        /\.\s*ela\s+(?:ainda\s+)?est[aá]\s+pendente,\s*foi\s+conclu[ií]da\s+ou\s+n[aã]o\s+consta\??$/iu,
        ''
      )
      .replace(/\?$/u, '');
  title = title.replace(/[.!]$/u, '').trim();
  const byId = /^#[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(title);
  if (byId)
    return add ? 'clarify' : { action: done ? 'complete' : 'lookup', title: title.toLowerCase() };
  const words = title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (
    !/^[\p{L}\d][\p{L}\p{M}\d '’()\/&+-]{0,159}$/u.test(title) ||
    /\b(?:se|talvez|mas|exceto|depois|antes|ou)\b/u.test(words) ||
    /\be\s+(?:tambem|marque|marca|conclua|cancele|apague|pague|registre|crie|adicione)\b/u.test(
      words
    )
  )
    return 'clarify';
  // Keep dated tasks and notification requests on the existing agenda/assistant path.
  if (
    add &&
    (/\b(?:amanha|hoje|lembrete|lembre|prazo|semanal|mensal|diariamente|automaticamente|sabado|domingo|as\s+\d|dia\s+\d|\d+[/-]\d+)\b/u.test(
      words
    ) ||
      /\b(?:segunda|terca|quarta|quinta|sexta)(?:-feira\b|$)/u.test(words))
  )
    return null;
  return { action: add ? 'create' : done ? 'complete' : 'lookup', title };
}

function describe(result: ChannelTaskResult, action: TaskRequest['action']): string {
  switch (result.outcome) {
    case 'missing':
      return 'Essa tarefa não consta na sua lista.';
    case 'inactive':
      return 'Seu acesso está inativo. A tarefa não foi alterada.';
    case 'ambiguous':
      return (
        'Encontrei mais de uma tarefa com esse título. Escolha o código no lugar do título ou confira sua lista no painel.\n' +
        result.tasks.map((t) => t.title + ' · ' + states[t.status] + ' · #' + t.id).join('\n')
      );
    case 'replay':
      return 'Essa mensagem já foi processada. Consulte a tarefa para ver o estado atual.';
    case 'conflict':
      return 'Essa mensagem mudou desde o primeiro pedido. Envie uma nova mensagem.';
    case 'completed':
      return 'Marquei como concluída a tarefa “' + result.task.title + '”.';
    case 'created':
      return 'Adicionei “' + result.task.title + '” à sua lista de tarefas. Ela está pendente.';
    case 'found':
      return (
        'A tarefa “' +
        result.task.title +
        '” ' +
        (action === 'create' ? 'já consta na sua lista e ' : '') +
        'está ' +
        states[result.task.status] +
        '.'
      );
  }
}

export async function tryPersonalTaskReply(
  message: ChannelIncomingMessage,
  userId: string,
  canWrite: () => Promise<boolean>
): Promise<string | null> {
  if (message.attachments?.length || !['whatsapp', 'telegram'].includes(message.platform))
    return null;
  const request = parseTask(message.text);
  if (!request) return null;
  if (
    !userId?.trim() ||
    !message.sender?.platformUserId ||
    message.platformChatId !== message.sender.platformUserId ||
    message.metadata?.isGroup === true ||
    (message.platform === 'telegram' && message.metadata?.chatType !== 'private')
  )
    return 'Consulte suas tarefas em uma conversa privada com o Astra.';
  if (request === 'clarify') return help;
  try {
    // A simple to-do has no time component; due dates and reminders stay with the agenda.
    const repo = new CustomerAgendaRepository(userId, 'UTC');
    if (request.action === 'lookup')
      return describe(await repo.findChannelTask(request.title), request.action);
    if (!message.id || !message.channelPluginId)
      return 'Envie o pedido em uma nova mensagem para confirmar a tarefa.';
    const key = JSON.stringify([
      message.platform,
      message.channelPluginId,
      message.platformChatId,
      message.id,
    ]);
    return describe(
      await repo.changeChannelTask(request.action, request.title, key, canWrite),
      request.action
    );
  } catch (error) {
    if (error instanceof CustomerAgendaError && error.status === 409) return error.message;
    getLog('ChannelTasks').error('Falha ao consultar ou alterar tarefa pessoal', {
      category: error instanceof Error ? error.name : 'unknown',
    });
    return 'Não consegui confirmar o estado da tarefa. Consulte sua lista antes de repetir o pedido.';
  }
}
