import { getExecContext } from '@ownpilot/core/agent';
import { getLog } from './log.js';
import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';
import { channelUsersRepo } from '../db/repositories/channels/users.js';
import { isChannelUserAccessActive } from '../channels/channel-access-service.js';
import {
  customerIntegrationsRepo,
  type IntegrationAction,
} from '../db/repositories/customer-integrations.js';
import { composioService, type IntegrationActionSpec } from './composio-service.js';
import {
  ASTRA_CONNECTED_APPS,
  type AstraConnectedAppSlug,
} from '../config/astra-connected-apps.js';
import { ASTRA_CUSTOMER_ORIGIN } from '../config/astra-public-urls.js';
import { CUSTOMER_INTEGRATION_SYNC } from '../config/customer-integration-actions.js';
import {
  integrationActionKind,
  integrationFailure,
  integrationHash,
  integrationName,
  validateIntegrationArguments,
} from './customer-integration-policy.js';
import { integrationItems, unwrapIntegrationResult } from './customer-integration-data.js';
import { customerDayStart, customerLocalDay } from './customer-date.js';
import { formatAstraMessage, type AstraMessageField } from '../channels/response-presentation.js';

const profileLink = ASTRA_CUSTOMER_ORIGIN + '/cliente/conexoes';
const friendly = (v: string) => v.replace(/<[^>]*>|[\r\n*_`]/g, ' ').trim();

let activeRequests = 0;

function bounded(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[conteúdo resumido]';
  if (typeof value === 'string') return value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => bounded(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 25)
        .filter(
          ([key]) =>
            !/(?:access.?token|refresh.?token|api.?key|authorization|credentials)/i.test(key)
        )
        .map(([key, v]) => [key, bounded(v, depth + 1)])
    );
  return value;
}
async function deadline<T>(promise: Promise<T>, ms = 11500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('INTEGRATION_DEADLINE')), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function markExternalData(): void {
  const guard = getExecContext()?.externalContentGuard;
  if (guard) guard.seen = true;
}

export function integrationProposalMessage(action: IntegrationAction): string {
  const args = action.arguments;
  const fields: AstraMessageField[] = [
    { label: 'Aplicativo', value: integrationName(action.app) },
    { label: 'Pedido', value: action.summary },
  ];
  const show: Record<string, string> = {
    to: 'Para',
    recipient_email: 'Para',
    recipientEmail: 'Para',
    cc: 'Cópia',
    bcc: 'Cópia oculta',
    subject: 'Assunto',
    summary: 'Título',
    title: 'Título',
    name: 'Nome',
    content: 'Conteúdo',
    body: 'Mensagem',
    text: 'Texto',
    description: 'Detalhes',
    start_datetime: 'Início',
    start_time: 'Início',
    end_datetime: 'Fim',
    end_time: 'Fim',
  };
  const seen = new Set<string>();
  const shownKeys = new Set<string>();
  for (const [key, label] of Object.entries(show)) {
    const value = args[key];
    if (value === undefined || seen.has(label)) continue;
    const display = Array.isArray(value)
      ? value.filter((v) => typeof v === 'string').join(', ')
      : typeof value === 'string'
        ? value
        : '';
    if (display) {
      fields.push({ label, value: display.replace(/[\r*_`]/g, '') });
      seen.add(label);
      shownKeys.add(key);
    }
  }
  const remaining = Object.fromEntries(Object.entries(args).filter(([key]) => !shownKeys.has(key)));
  if (Object.keys(remaining).length)
    fields.push({ label: 'Outros detalhes', value: JSON.stringify(remaining, null, 2) });
  return formatAstraMessage(
    '🔎 Confirma esta alteração?',
    fields,
    'Responda “sim” para confirmar ou “cancelar” para desistir.'
  );
}

export class CustomerIntegrationService {
  private readonly metadataCache = new Map<string, { at: number; rows: IntegrationActionSpec[] }>();
  private readonly readCache = new Map<string, { at: number; result: unknown }>();
  async principal(userId: string) {
    if (!userId || userId === 'default')
      throw new Error('Vincule sua conversa ao seu cadastro no painel para usar suas conexões.');
    const account = await customerAccountsRepo.getByDataUserId(userId);
    if (!account || account.dataUserId !== userId)
      throw new Error('Vincule sua conversa ao seu cadastro no painel para usar suas conexões.');
    if (process.env.ASTRA_CUSTOMER_OAUTH_ENABLED !== 'true' || !composioService.isConfigured())
      throw new Error(
        'As conexões ainda estão sendo preparadas. Seus recursos de rotina continuam disponíveis.'
      );
    const grant = await channelUsersRepo.getById(account.channelUserId);
    if (!grant || !isChannelUserAccessActive(grant))
      throw new Error(
        'Seu acesso precisa estar ativo para usar as conexões. Confira seu plano no painel.'
      );
    return { account, ownerId: 'astra-customer:' + account.id };
  }
  async binding(userId: string, app: AstraConnectedAppSlug, requested?: string) {
    const principal = await this.principal(userId);
    const owned = (await composioService.getCustomerConnections(principal.ownerId)).filter(
      (row) => row.appName === app && row.status === 'ACTIVE'
    );
    const match = requested
      ? owned.find((row) => row.id === requested)
      : owned.length === 1
        ? owned[0]
        : null;
    if (!match)
      throw new Error(
        owned.length > 1
          ? 'Escolha no painel qual das suas contas deseja usar.'
          : 'Conecte ' +
              integrationName(app) +
              ' no seu painel para usar essa função: ' +
              profileLink
      );
    return { ...principal, connection: match };
  }
  async status(userId: string) {
    const { account, ownerId } = await this.principal(userId);
    const connections = await composioService.getCustomerConnections(ownerId);
    const recent = await customerIntegrationsRepo.recent(
      userId,
      getExecContext()?.channelPluginId,
      getExecContext()?.platformChatId
    );
    const apps = await Promise.all(
      ASTRA_CONNECTED_APPS.map(async (app) => {
        const owned = connections.filter((row) => row.appName === app.slug);
        const existing =
          owned.find((row) => row.status === 'ACTIVE') ??
          owned.find((row) => row.status === 'INITIATED') ??
          owned[0];
        const snapshot = existing
          ? await customerIntegrationsRepo.snapshot(userId, app.slug, existing.id)
          : null;
        return {
          ...app,
          status:
            existing?.status === 'ACTIVE'
              ? 'connected'
              : existing && ['EXPIRED', 'REVOKED'].includes(existing.status)
                ? 'needs_attention'
                : existing?.status === 'INITIATED'
                  ? 'pending'
                  : 'disconnected',
          connectionId: existing?.id ?? null,
          connectionCount: owned.filter((row) => row.status === 'ACTIVE').length,
          lastSyncedAt: snapshot?.synced_at ?? null,
          itemCount: snapshot?.items.length ?? 0,
          syncIssue: snapshot?.issue ?? null,
        };
      })
    );
    return {
      apps,
      timeZone: account.timeZone,
      recent: recent.map((row) => ({
        app: row.app,
        summary: row.summary,
        state: row.state,
        result: bounded(row.result),
      })),
      profileLink,
    };
  }
  async specs(
    app: AstraConnectedAppSlug,
    query?: string,
    slug?: string
  ): Promise<IntegrationActionSpec[]> {
    const key = app + ':' + (slug ?? 'all');
    const cached = this.metadataCache.get(key);
    if (cached && Date.now() - cached.at < 300000) return cached.rows;
    const rows = (await composioService.integrationActionSpecs(app, query, slug)).filter((spec) => {
      try {
        integrationActionKind(spec);
        return true;
      } catch {
        return false;
      }
    });
    if (this.metadataCache.size >= 100)
      this.metadataCache.delete(this.metadataCache.keys().next().value!);
    this.metadataCache.set(key, { at: Date.now(), rows });
    return rows;
  }
  async discover(userId: string, app: AstraConnectedAppSlug, query: string) {
    await this.binding(userId, app);
    const input = query
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const want = /enviar|mandar|send/.test(input)
      ? 'SEND'
      : /alterar|mudar|editar|corrigir|update/.test(input)
        ? 'UPDATE'
        : /concluir|complete|close/.test(input)
          ? 'CLOSE'
          : /criar|adicionar|registrar|create|add|append/.test(input)
            ? 'CREATE'
            : /buscar|consultar|listar|ler|read|search|list|fetch|get/.test(input)
              ? 'READ'
              : '';
    const score = (spec: IntegrationActionSpec) =>
      (want === 'READ' && integrationActionKind(spec) === 'read'
        ? 20
        : spec.slug.includes(want) && want
          ? 20
          : 0) +
      (input.includes('draft') || input.includes('rascunho')
        ? spec.slug.includes('DRAFT')
          ? 30
          : 0
        : 0);
    return (await this.specs(app, query))
      .sort((a, b) => score(b) - score(a))
      .slice(0, 4)
      .map((spec) => ({
        action: spec.slug,
        name: spec.name,
        description: spec.description.slice(0, 700),
        parameters: spec.parameters,
        kind: integrationActionKind(spec),
      }));
  }
  private async spec(app: AstraConnectedAppSlug, slug: string): Promise<IntegrationActionSpec> {
    if (!slug.startsWith(app.toUpperCase() + '_'))
      throw new Error('Essa ação não pertence ao aplicativo escolhido.');
    const spec = (await this.specs(app, undefined, slug)).find((row) => row.slug === slug);
    if (!spec) throw new Error('Essa ação não está disponível nas suas conexões.');
    return spec;
  }
  private async providerCall(
    ownerId: string,
    userId: string,
    app: AstraConnectedAppSlug,
    connectionId: string,
    slug: string,
    args: Record<string, unknown>,
    onStart?: () => void
  ): Promise<unknown> {
    if (activeRequests >= 8)
      throw new Error('As conexões estão ocupadas agora. Tente de novo em instantes.');
    activeRequests++;
    const requestDeadline = Date.now() + 10000;
    try {
      await customerIntegrationsRepo.reserveCall(userId);
      if (Date.now() >= requestDeadline)
        throw Object.assign(new Error('Integration deadline passed while reserving the call'), {
          name: 'INTEGRATION_NOT_SENT',
        });
      return await composioService.executeCustomerSession(
        ownerId,
        app,
        connectionId,
        slug,
        args,
        onStart,
        requestDeadline
      );
    } finally {
      activeRequests--;
    }
  }
  private async saveData(
    userId: string,
    app: AstraConnectedAppSlug,
    connectionId: string,
    data: unknown,
    timeZone: string,
    resource = ''
  ) {
    const parsed = integrationItems(app, data, timeZone, resource);
    const previous = await customerIntegrationsRepo.snapshot(userId, app, connectionId);
    let mirrored = 0,
      conflicts = 0;
    await customerIntegrationsRepo.transaction(async () => {
      for (const item of parsed.items) {
        const id = 'int_' + integrationHash([userId, app, connectionId, item.id]).slice(0, 40);
        if (
          item.kind === 'event' &&
          item.status === 'cancelled' &&
          previous?.items.some((old) => old.id === item.id)
        ) {
          if (
            await customerIntegrationsRepo.removeMirroredEvent(
              userId,
              connectionId,
              id,
              previous.synced_at
            )
          )
            mirrored++;
          else conflicts++;
        } else if (item.kind === 'event' && item.start && item.status !== 'cancelled') {
          if (
            await customerIntegrationsRepo.mirrorEvent(
              userId,
              connectionId,
              id,
              item,
              timeZone,
              previous?.synced_at ?? null
            )
          )
            mirrored++;
          else conflicts++;
        } else if (item.kind === 'task') {
          if (
            await customerIntegrationsRepo.mirrorTask(
              userId,
              app,
              id,
              item,
              previous?.synced_at ?? null,
              connectionId
            )
          )
            mirrored++;
          else conflicts++;
        }
      }
      const merged = [
        ...parsed.items,
        ...(previous?.items ?? []).filter((old) => !parsed.items.some((row) => row.id === old.id)),
      ].slice(0, 50);
      await customerIntegrationsRepo.saveSnapshot(
        userId,
        app,
        connectionId,
        merged,
        conflicts ? 'Há itens alterados no Astra que precisam de revisão.' : null
      );
    });
    return { consulted: parsed.items.length, mirrored, conflicts, partial: parsed.partial };
  }
  private async mirrorConfirmedWrite(
    row: IntegrationAction,
    data: unknown,
    timeZone: string
  ): Promise<string | undefined> {
    const calendarRemoval = row.action_slug === 'GOOGLECALENDAR_DELETE_EVENT';
    const taskRemoval = row.action_slug === 'TODOIST_DELETE_TASK';
    const taskCompletion = row.action_slug === 'TODOIST_CLOSE_TASK_V1';
    if (calendarRemoval || taskRemoval || taskCompletion) {
      const externalId = String(row.arguments.event_id ?? row.arguments.task_id ?? '');
      const previous = await customerIntegrationsRepo.snapshot(
        row.user_id,
        row.app,
        row.connection_id
      );
      const item = previous?.items.find((item) => item.id === externalId);
      if (
        !previous ||
        !item ||
        !(await customerIntegrationsRepo.claimSync(row.user_id, row.app, row.connection_id, true))
      )
        return;
      let preserved = false;
      await customerIntegrationsRepo.transaction(async () => {
        const id =
          'int_' + integrationHash([row.user_id, row.app, row.connection_id, item.id]).slice(0, 40);
        const changed = { ...item, status: taskCompletion ? 'completed' : 'cancelled' };
        const mirrored = calendarRemoval
          ? await customerIntegrationsRepo.removeMirroredEvent(
              row.user_id,
              row.connection_id,
              id,
              previous.synced_at
            )
          : await customerIntegrationsRepo.mirrorTask(
              row.user_id,
              row.app,
              id,
              changed,
              previous.synced_at,
              row.connection_id
            );
        preserved = !mirrored;
        const items = previous.items.map((old) => (old.id === externalId ? changed : old));
        await customerIntegrationsRepo.saveSnapshot(
          row.user_id,
          row.app,
          row.connection_id,
          items,
          preserved ? 'Há uma edição local desse item que precisa de revisão.' : null
        );
      });
      return preserved
        ? 'A alteração foi feita no aplicativo. Preservei uma edição local no Astra; confira esse item no painel.'
        : undefined;
    }
    if (!['googlecalendar', 'todoist', 'trello'].includes(row.app)) return;
    // A mutation receipt may contain only a status or ID; it is not an empty list.
    try {
      if (!integrationItems(row.app, data, timeZone).items.length) return;
    } catch {
      return;
    }
    if (await customerIntegrationsRepo.claimSync(row.user_id, row.app, row.connection_id, true)) {
      const result = await this.saveData(row.user_id, row.app, row.connection_id, data, timeZone);
      return result.conflicts
        ? 'A alteração foi feita no aplicativo. Preservei edições locais no Astra para você revisar.'
        : undefined;
    }
    return undefined;
  }
  async run(
    userId: string,
    app: AstraConnectedAppSlug,
    slug: string,
    input: Record<string, unknown>,
    summary?: string,
    connectionId?: string
  ) {
    const binding = await this.binding(userId, app, connectionId);
    const spec = await this.spec(app, slug),
      args = { ...input };
    if (
      app === 'gmail' &&
      (spec.parameters.properties as Record<string, unknown> | undefined)?.user_id &&
      args.user_id === undefined
    )
      args.user_id = 'me';
    validateIntegrationArguments(args, spec);
    if (integrationActionKind(spec) === 'write') {
      const ctx = getExecContext();
      if (
        !ctx?.channelIsPrivate ||
        !ctx.channelPluginId ||
        !ctx.platformChatId ||
        !ctx.channelMessageId ||
        ctx.channelConversationOnly ||
        ctx.externalContentGuard?.seen
      )
        throw new Error(
          'Envie esse pedido em uma nova mensagem na conversa particular do Astra para confirmar a alteração.'
        );
      const existing = await customerIntegrationsRepo.latestPending(
        userId,
        ctx.channelPluginId,
        ctx.platformChatId
      );
      if (existing && existing.request_message_id === ctx.channelMessageId)
        return { confirmationRequired: true, reply: integrationProposalMessage(existing) };
      if ((await customerIntegrationsRepo.hourlyWrites(userId)) >= 20)
        throw new Error(
          'Vamos pausar novas alterações por um momento. Suas consultas continuam disponíveis.'
        );
      const actionHash = integrationHash([app, binding.connection.id, slug, args]);
      if (await customerIntegrationsRepo.hasUncertain(userId, actionHash))
        throw new Error(
          'Antes de repetir, consulte o aplicativo para conferir se essa alteração já aconteceu.'
        );
      if (existing)
        await customerIntegrationsRepo.cancel(
          existing.id,
          userId,
          ctx.channelPluginId,
          ctx.platformChatId
        );
      const proposal = await customerIntegrationsRepo.propose({
        userId,
        app,
        connectionId: binding.connection.id,
        slug,
        args,
        summary: friendly(summary ?? spec.name).slice(0, 220),
        pluginId: ctx.channelPluginId,
        chatId: ctx.platformChatId,
        messageId: ctx.channelMessageId,
        requestKey: integrationHash([
          ctx.channelPluginId,
          ctx.platformChatId,
          ctx.channelMessageId,
          actionHash,
        ]),
        actionHash,
        schemaHash: integrationHash([spec.slug, spec.parameters, spec.tags, spec.version]),
      });
      return { confirmationRequired: true, reply: integrationProposalMessage(proposal) };
    }
    const key = userId + '\0' + integrationHash([userId, app, binding.connection.id, slug, args]);
    const cached = this.readCache.get(key);
    markExternalData();
    if (cached && Date.now() - cached.at < 60000)
      return { source: integrationName(app), cached: true, untrustedExternalData: cached.result };
    const response = await deadline(
      this.providerCall(binding.ownerId, userId, app, binding.connection.id, slug, args)
    );
    const data = unwrapIntegrationResult(response);
    let sync: unknown = null;
    if (await customerIntegrationsRepo.claimSync(userId, app, binding.connection.id)) {
      try {
        sync = await this.saveData(
          userId,
          app,
          binding.connection.id,
          data,
          binding.account.timeZone,
          JSON.stringify(args)
        );
      } catch {
        await customerIntegrationsRepo.syncFailed(userId, app, binding.connection.id);
      }
    }
    const result = bounded(data);
    if (this.readCache.size >= 500) this.readCache.delete(this.readCache.keys().next().value!);
    this.readCache.set(key, { at: Date.now(), result });
    return { source: integrationName(app), cached: false, untrustedExternalData: result, sync };
  }
  async sync(userId: string, app: AstraConnectedAppSlug, options: Record<string, unknown> = {}) {
    const binding = await this.binding(
      userId,
      app,
      typeof options.connectionId === 'string' ? options.connectionId : undefined
    );
    const previous = await customerIntegrationsRepo.snapshot(userId, app, binding.connection.id);
    if (!(await customerIntegrationsRepo.claimSync(userId, app, binding.connection.id)))
      return {
        updated: !!previous?.synced_at,
        items: previous?.items.length ?? 0,
        lastSyncedAt: previous?.synced_at ?? null,
        cached: true,
      };
    try {
      const spec = (await this.specs(app, undefined, CUSTOMER_INTEGRATION_SYNC[app])).find(
        (row) =>
          row.slug === CUSTOMER_INTEGRATION_SYNC[app] && integrationActionKind(row) === 'read'
      );
      if (!spec)
        throw new Error(
          'Ainda não encontrei uma consulta compatível para atualizar esse aplicativo.'
        );
      const props = (spec.parameters.properties ?? {}) as Record<string, Record<string, unknown>>,
        args: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(props)) {
        if (property.default !== undefined) args[name] = structuredClone(property.default);
        if (/^(?:max_?results|page_?size|limit|per_?page)$/i.test(name))
          args[name] = Math.min(50, typeof property.maximum === 'number' ? property.maximum : 50);
        if (/^(?:calendar_?id)$/i.test(name))
          args[name] = typeof options.calendarId === 'string' ? options.calendarId : 'primary';
        if (/^(?:user_?id|member_?id|idMember)$/i.test(name)) args[name] = 'me';
        if (/^(?:time_?min)$/i.test(name))
          args[name] = customerDayStart(
            customerLocalDay(new Date(), binding.account.timeZone),
            binding.account.timeZone
          ).toISOString();
        if (/^(?:time_?max)$/i.test(name))
          args[name] = new Date(Date.now() + 30 * 86400000).toISOString();
        if (/^(?:time_?zone)$/i.test(name)) args[name] = binding.account.timeZone;
        if (name === 'singleEvents') args[name] = true;
        if (name === 'showDeleted') args[name] = true;
        if (name === 'verbose' || name === 'include_payload' || name === 'include_spam_trash')
          args[name] = false;
        if (app === 'gmail' && name === 'max_results') args[name] = 10;
        if (name === 'query' || name === 'q') args[name] = app === 'gmail' ? 'in:inbox' : '';
        if (/spreadsheet_?id/i.test(name) && typeof options.spreadsheetId === 'string')
          args[name] = options.spreadsheetId;
      }
      if (
        app === 'googlesheets' &&
        (spec.parameters.required as string[] | undefined)?.some(
          (key) => /spreadsheet_?id/i.test(key) && !args[key]
        )
      )
        throw new Error('Envie no chat o link da planilha que você quer atualizar.');
      validateIntegrationArguments(args, spec);
      const response = await deadline(
        this.providerCall(binding.ownerId, userId, app, binding.connection.id, spec.slug, args)
      );
      const synced = await this.saveData(
        userId,
        app,
        binding.connection.id,
        unwrapIntegrationResult(response),
        binding.account.timeZone
      );
      return { updated: true, ...synced, lastSyncedAt: new Date().toISOString() };
    } catch (error) {
      await customerIntegrationsRepo.syncFailed(userId, app, binding.connection.id);
      throw error;
    }
  }
  async confirm(row: IntegrationAction): Promise<string> {
    let sent = false;
    try {
      const binding = await this.binding(row.user_id, row.app, row.connection_id),
        spec = await this.spec(row.app, row.action_slug);
      if (
        integrationHash([spec.slug, spec.parameters, spec.tags, spec.version]) !== row.schema_hash
      )
        throw new Error(
          'Essa ação mudou desde a confirmação. Faça o pedido novamente para revisar os detalhes.'
        );
      validateIntegrationArguments(row.arguments, spec);
      const operation = this.providerCall(
        binding.ownerId,
        row.user_id,
        row.app,
        row.connection_id,
        row.action_slug,
        row.arguments,
        () => {
          sent = true;
        }
      );
      void operation.then(
        async (response) => {
          try {
            const data = unwrapIntegrationResult(response);
            await customerIntegrationsRepo.finish(row.id, row.user_id, 'succeeded', {
              summary: row.summary,
              data: bounded(data),
            });
          } catch {
            getLog('CustomerIntegrations').debug(
              'Late integration result was not persisted; the awaited path records the outcome.'
            );
          }
        },
        () => undefined
      );
      const data = unwrapIntegrationResult(await deadline(operation));
      for (const key of this.readCache.keys())
        if (key.startsWith(row.user_id + '\0')) this.readCache.delete(key);
      await customerIntegrationsRepo.finish(row.id, row.user_id, 'succeeded', {
        summary: row.summary,
        data: bounded(data),
      });
      let mirrorNotice: string | undefined;
      try {
        mirrorNotice = await this.mirrorConfirmedWrite(row, data, binding.account.timeZone);
      } catch {
        mirrorNotice =
          'A alteração foi feita no aplicativo. Atualize o painel para conferir os dados mais recentes.';
      }
      return formatAstraMessage(
        '✅ Alteração concluída',
        [
          { label: 'Aplicativo', value: integrationName(row.app) },
          { label: 'Pedido', value: row.summary },
        ],
        mirrorNotice
      );
    } catch (error) {
      const rejected =
        error instanceof Error &&
        ['INTEGRATION_NOT_SENT', 'INTEGRATION_REJECTED'].includes(error.name);
      const uncertain = sent && !rejected;
      await customerIntegrationsRepo.finish(
        row.id,
        row.user_id,
        uncertain ? 'uncertain' : 'failed',
        { summary: row.summary }
      );
      return uncertain
        ? 'Ainda não consegui confirmar o resultado no ' +
            integrationName(row.app) +
            '. Confira o item nesse aplicativo antes de repetir a alteração.'
        : integrationFailure(error);
    }
  }
}
export const customerIntegrationService = new CustomerIntegrationService();
