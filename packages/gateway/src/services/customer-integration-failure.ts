/** Application-owned failure receipts. Provider text and model arguments are never evidence. */
import { ASTRA_CONNECTED_APP_SLUGS } from '../config/astra-connected-apps.js';
import { CUSTOMER_INTEGRATION_ACTIONS } from '../config/customer-integration-actions.js';
import { ASTRA_CUSTOMER_ORIGIN } from '../config/astra-public-urls.js';

const reasonsByStage = {
  input: ['invalid_app', 'invalid_action', 'invalid_arguments'],
  binding: [
    'binding_failed',
    'account_required',
    'connections_disabled',
    'access_inactive',
    'connection_required',
    'connection_ambiguous',
  ],
  schema: ['schema_failed', 'action_app_mismatch', 'action_unavailable'],
  validation: ['invalid_arguments', 'missing_argument'],
  preparation: [
    'preparation_failed',
    'private_confirmation_required',
    'write_limit',
    'previous_outcome_uncertain',
  ],
  proposal: ['proposal_not_confirmed'],
  read_request: [
    'read_not_confirmed',
    'read_not_sent',
    'read_rejected',
    'read_timeout',
    'monthly_limit',
    'daily_limit',
    'connections_busy',
  ],
  read_result: ['read_not_confirmed'],
  unknown: ['execution_not_confirmed'],
} as const;

const requiredFieldLabels = {
  calendar_id: 'a agenda',
  summary: 'o título',
  title: 'o título',
  name: 'o nome',
  start_datetime: 'a data e a hora de início',
  start_time: 'a hora de início',
  end_datetime: 'a data e a hora de término',
  end_time: 'a hora de término',
  event_duration_minutes: 'a duração do evento',
  timezone: 'o fuso horário',
  to: 'o destinatário',
  recipient_email: 'o e-mail do destinatário',
  recipientEmail: 'o e-mail do destinatário',
  subject: 'o assunto',
  body: 'o texto da mensagem',
  message_body: 'o texto da mensagem',
  content: 'o conteúdo',
  text: 'o texto',
  spreadsheet_id: 'a planilha',
  spreadsheetId: 'a planilha',
  range: 'o intervalo da planilha',
  values: 'os valores da planilha',
  task_id: 'a tarefa',
  event_id: 'o compromisso',
  page_id: 'a página',
  card_id: 'o cartão',
  board_id: 'o quadro',
} as const;

export type ConnectedActionFailureStage = keyof typeof reasonsByStage;
export type ConnectedActionFailureReason =
  (typeof reasonsByStage)[ConnectedActionFailureStage][number];
export type ConnectedActionFailureReceipt = {
  kind: 'connected_action_failure';
  stage: ConnectedActionFailureStage;
  reason: ConnectedActionFailureReason;
  app: (typeof ASTRA_CONNECTED_APP_SLUGS)[number] | null;
  action: string | null;
  /** run_connected_action reads or prepares a proposal; only confirm() can send a write. */
  externalMutation: 'not_attempted' | 'unknown';
  /** Preparing a proposal or mirroring a read may have changed local state before failure. */
  localMutation: 'not_attempted' | 'unknown';
  requiredField?: keyof typeof requiredFieldLabels;
};

const messages: Record<ConnectedActionFailureReason, string> = {
  invalid_app:
    'Escolha um dos aplicativos disponíveis nas suas conexões. Esse pedido não foi enviado ao aplicativo.',
  invalid_action:
    'Não encontrei uma ação disponível para esse pedido. Esse pedido não foi enviado ao aplicativo.',
  invalid_arguments:
    'Não consegui validar os detalhes dessa ação. Esse pedido não foi enviado ao aplicativo; preciso conferir os campos necessários antes de continuar.',
  binding_failed:
    'Não consegui conferir a conexão desse aplicativo agora. Confira suas conexões no painel. Nenhuma alteração externa foi enviada por este pedido.',
  account_required:
    'Vincule sua conversa ao seu cadastro no painel para usar suas conexões. Nenhuma alteração externa foi enviada por este pedido.',
  connections_disabled:
    'As conexões ainda estão sendo preparadas. Seus recursos de rotina continuam disponíveis. Nenhuma alteração externa foi enviada por este pedido.',
  access_inactive:
    'Seu acesso precisa estar ativo para usar as conexões. Confira seu plano no painel. Nenhuma alteração externa foi enviada por este pedido.',
  connection_required: `Conecte esse aplicativo no painel para usar essa função: ${ASTRA_CUSTOMER_ORIGIN}/cliente/conexoes. Nenhuma alteração externa foi enviada por este pedido.`,
  connection_ambiguous:
    'Escolha no painel qual das suas contas deseja usar. Nenhuma alteração externa foi enviada por este pedido.',
  schema_failed:
    'Não consegui conferir os campos e permissões dessa ação agora. Nenhuma alteração externa foi enviada por este pedido.',
  action_app_mismatch:
    'Essa ação não pertence ao aplicativo escolhido. Nenhuma alteração externa foi enviada por este pedido.',
  action_unavailable:
    'Essa ação não está disponível nas suas conexões. Nenhuma alteração externa foi enviada por este pedido.',
  missing_argument:
    'Falta um detalhe obrigatório para essa ação. Preciso conferir esse detalhe antes de continuar. Nenhuma alteração externa foi enviada por este pedido.',
  preparation_failed:
    'Não consegui preparar os detalhes para sua confirmação. Nenhuma alteração externa foi enviada por este pedido.',
  private_confirmation_required:
    'Envie esse pedido em uma nova mensagem na conversa particular do Astra para conferir os detalhes antes de confirmar a alteração.',
  write_limit:
    'Vamos pausar novas alterações por um momento. Você pode conferir os dados já salvos no painel. Nenhuma alteração externa foi enviada por este pedido.',
  previous_outcome_uncertain:
    'Antes de repetir, consulte o aplicativo para conferir se a alteração anterior já aconteceu. Nenhuma nova alteração externa foi enviada por este pedido.',
  proposal_not_confirmed:
    'Não consegui confirmar a preparação desse pedido. Nenhuma alteração externa foi enviada; confira se ficou uma proposta pendente antes de pedir novamente.',
  read_not_confirmed:
    'Não consegui concluir a consulta nesse aplicativo agora. Nenhuma alteração externa foi enviada por este pedido. Se a consulta atualizava cópias no Astra, confira o painel antes de repetir.',
  read_not_sent:
    'A consulta não chegou a ser enviada ao aplicativo. Nenhuma alteração externa foi enviada por este pedido.',
  read_rejected:
    'O aplicativo recusou a consulta. Confira a conexão e as permissões no painel. Nenhuma alteração externa foi enviada por este pedido.',
  read_timeout:
    'A consulta demorou além do limite de espera e não consegui confirmar o resultado. Nenhuma alteração externa foi enviada por este pedido; confira o painel antes de repetir.',
  monthly_limit:
    'As atualizações externas chegaram à franquia gratuita deste mês. Seus dados já salvos continuam disponíveis. Nenhuma alteração externa foi enviada por este pedido.',
  daily_limit:
    'Suas conexões atingiram o limite de atualizações de hoje. Podemos continuar organizando os dados que já estão salvos. Nenhuma alteração externa foi enviada por este pedido.',
  connections_busy:
    'As conexões estão ocupadas agora. Tente de novo em instantes. Nenhuma alteração externa foi enviada por este pedido.',
  execution_not_confirmed:
    'Não consegui confirmar o resultado desse pedido. Confira o aplicativo e os pedidos pendentes antes de repetir a ação.',
};

function expectedLocalMutation(stage: ConnectedActionFailureStage) {
  return ['proposal', 'read_request', 'read_result', 'unknown'].includes(stage)
    ? ('unknown' as const)
    : ('not_attempted' as const);
}

function safeApp(value: unknown): ConnectedActionFailureReceipt['app'] {
  return typeof value === 'string' &&
    (ASTRA_CONNECTED_APP_SLUGS as readonly string[]).includes(value)
    ? (value as ConnectedActionFailureReceipt['app'])
    : null;
}

function safeAction(app: ConnectedActionFailureReceipt['app'], value: unknown): string | null {
  return app && typeof value === 'string' && CUSTOMER_INTEGRATION_ACTIONS[app].includes(value)
    ? value
    : null;
}

export function createConnectedActionFailure(
  stage: ConnectedActionFailureStage,
  app: unknown,
  action: unknown,
  reason: ConnectedActionFailureReason = reasonsByStage[stage][0],
  requiredField?: unknown
): ConnectedActionFailureReceipt {
  const selected = safeApp(app);
  return {
    kind: 'connected_action_failure',
    stage,
    reason,
    app: selected,
    action: safeAction(selected, action),
    externalMutation: stage === 'unknown' ? 'unknown' : 'not_attempted',
    localMutation: expectedLocalMutation(stage),
    ...(reason === 'missing_argument' &&
    typeof requiredField === 'string' &&
    Object.hasOwn(requiredFieldLabels, requiredField)
      ? { requiredField: requiredField as keyof typeof requiredFieldLabels }
      : {}),
  };
}

/** Validate every evidence field before a channel uses the receipt without another model call. */
export function parseConnectedActionFailure(value: unknown): ConnectedActionFailureReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.kind !== 'connected_action_failure' ||
    typeof row.stage !== 'string' ||
    !Object.hasOwn(reasonsByStage, row.stage)
  )
    return null;
  const stage = row.stage as ConnectedActionFailureStage;
  if (
    typeof row.reason !== 'string' ||
    !(reasonsByStage[stage] as readonly string[]).includes(row.reason) ||
    row.externalMutation !== (stage === 'unknown' ? 'unknown' : 'not_attempted') ||
    row.localMutation !== expectedLocalMutation(stage) ||
    (row.app !== null && safeApp(row.app) !== row.app) ||
    (row.action !== null && safeAction(safeApp(row.app), row.action) !== row.action) ||
    (row.requiredField !== undefined &&
      (stage !== 'validation' ||
        row.reason !== 'missing_argument' ||
        typeof row.requiredField !== 'string' ||
        !Object.hasOwn(requiredFieldLabels, row.requiredField)))
  )
    return null;
  return createConnectedActionFailure(
    stage,
    row.app,
    row.action,
    row.reason as ConnectedActionFailureReason,
    row.requiredField
  );
}

/** Deliberately ignore any message, stack, response body or extra fields in an incoming receipt. */
export function connectedActionFailureMessage(failure: ConnectedActionFailureReceipt): string {
  if (failure.reason === 'missing_argument' && failure.requiredField)
    return `Falta informar ${requiredFieldLabels[failure.requiredField]} para essa ação. Nenhuma alteração externa foi enviada por este pedido.`;
  return messages[failure.reason];
}

/** Only explicit application guards construct this marker; remote exceptions cannot add a reason. */
export class ConnectedActionRejection extends Error {
  constructor(
    readonly reason: ConnectedActionFailureReason,
    message: string
  ) {
    super(message);
    this.name = 'ConnectedActionRejection';
  }
}

export class ConnectedActionFailureError extends Error {
  constructor(readonly failure: ConnectedActionFailureReceipt) {
    super(connectedActionFailureMessage(failure));
    this.name = 'ConnectedActionFailureError';
  }
}
