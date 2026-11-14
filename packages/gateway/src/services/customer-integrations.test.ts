import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { runInExecContext } from '@ownpilot/core/agent';
const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  connections: vi.fn(),
  specs: vi.fn(),
  execute: vi.fn(),
  repo: {
    reserveCall: vi.fn(),
    snapshot: vi.fn(),
    claimSync: vi.fn(),
    saveSnapshot: vi.fn(),
    syncFailed: vi.fn(),
    latestPending: vi.fn(),
    hourlyWrites: vi.fn(),
    hasUncertain: vi.fn(),
    propose: vi.fn(),
    cancel: vi.fn(),
    finish: vi.fn(),
    recent: vi.fn(),
    transaction: vi.fn(),
    removeMirroredEvent: vi.fn(),
    mirrorTask: vi.fn(),
  },
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mocks.account },
}));
vi.mock('../db/repositories/channels/users.js', () => ({
  channelUsersRepo: { getById: vi.fn(async () => ({ isVerified: true, status: 'active' })) },
}));
vi.mock('../db/repositories/customer-integrations.js', () => ({
  customerIntegrationsRepo: mocks.repo,
}));
vi.mock('./composio-service.js', () => ({
  composioService: {
    isConfigured: () => true,
    getCustomerConnections: mocks.connections,
    integrationActionSpecs: mocks.specs,
    executeCustomerSession: mocks.execute,
  },
}));
import { CustomerIntegrationService, integrationProposalMessage } from './customer-integrations.js';
import type { IntegrationAction } from '../db/repositories/customer-integrations.js';
import { integrationHash } from './customer-integration-policy.js';
const read = {
  slug: 'GMAIL_FETCH_EMAILS',
  name: 'Consultar e-mails',
  appName: 'gmail',
  description: '',
  parameters: { type: 'object', properties: { user_id: { type: 'string' } } },
  tags: ['readOnlyHint'],
  version: '1',
};
const write = {
  ...read,
  slug: 'GMAIL_SEND_EMAIL',
  name: 'Enviar mensagem',
  parameters: {
    type: 'object',
    properties: { to: { type: 'string' }, body: { type: 'string' } },
    required: ['to', 'body'],
  },
  tags: ['createHint'],
};
let service: CustomerIntegrationService;
afterEach(() => vi.restoreAllMocks());
const privateContext = {
  channelIsPrivate: true,
  channelPluginId: 'whatsapp-own',
  platformChatId: 'chat-a',
  channelMessageId: 'message-a',
  externalContentGuard: { seen: false },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ASTRA_CUSTOMER_OAUTH_ENABLED', 'true');
  service = new CustomerIntegrationService();
  mocks.account.mockImplementation(async (id: string) => ({
    id: id === 'customer-a' ? 'account-a' : 'account-b',
    dataUserId: id,
    timeZone: 'America/Cuiaba',
  }));
  mocks.connections.mockImplementation(async (owner: string) => [
    { id: owner.endsWith('account-a') ? 'ca_a' : 'ca_b', appName: 'gmail', status: 'ACTIVE' },
  ]);
  mocks.specs.mockImplementation(async (_app: string, _query?: string, slug?: string) => [
    slug === write.slug ? write : read,
  ]);
  mocks.execute.mockResolvedValue({ successful: true, data: { messages: [] } });
  mocks.repo.recent.mockResolvedValue([]);
  mocks.repo.claimSync.mockResolvedValue(false);
  mocks.repo.hourlyWrites.mockResolvedValue(0);
  mocks.repo.hasUncertain.mockResolvedValue(false);
  mocks.repo.propose.mockImplementation(async (input) => ({
    ...input,
    id: 'proposal',
    user_id: input.userId,
    arguments: input.args,
    summary: input.summary,
    app: input.app,
  }));
});
describe('customer bound integration execution', () => {
  it.each(['criar evento', 'agendar compromisso', 'marcar evento'])(
    'returns only the relevant calendar schema for %s',
    async (query) => {
      mocks.connections.mockResolvedValue([
        { id: 'ca_a', appName: 'googlecalendar', status: 'ACTIVE' },
      ]);
      mocks.specs.mockResolvedValue([
        { ...read, appName: 'googlecalendar', slug: 'GOOGLECALENDAR_EVENTS_LIST' },
        { ...write, appName: 'googlecalendar', slug: 'GOOGLECALENDAR_CREATE_EVENT' },
        { ...write, appName: 'googlecalendar', slug: 'GOOGLECALENDAR_DELETE_EVENT' },
        { ...write, appName: 'googlecalendar', slug: 'GOOGLECALENDAR_UPDATE_EVENT' },
      ]);
      const results = await service.discover('customer-a', 'googlecalendar', query);
      expect(results.map((r) => r.action)).toEqual(['GOOGLECALENDAR_CREATE_EVENT']);
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );
  it('returns the send schema without unrelated draft schemas', async () => {
    mocks.specs.mockResolvedValue([
      { ...write, slug: 'GMAIL_CREATE_EMAIL_DRAFT' },
      { ...write, slug: 'GMAIL_SEND_EMAIL' },
    ]);
    expect(
      (await service.discover('customer-a', 'gmail', 'enviar mensagem')).map((r) => r.action)
    ).toEqual(['GMAIL_SEND_EMAIL']);
  });
  it.each([true, false])(
    'mirrors a confirmed calendar deletion while preserving local edits (%s)',
    async (canRemove) => {
      const spec = {
        ...read,
        appName: 'googlecalendar',
        slug: 'GOOGLECALENDAR_DELETE_EVENT',
        tags: ['destructiveHint'],
        parameters: {
          type: 'object',
          properties: { event_id: { type: 'string' } },
          required: ['event_id'],
        },
      };
      mocks.connections.mockResolvedValue([
        { id: 'ca_a', appName: 'googlecalendar', status: 'ACTIVE' },
      ]);
      mocks.specs.mockResolvedValue([spec]);
      mocks.execute.mockResolvedValue({ successful: true, data: {} });
      mocks.repo.snapshot.mockResolvedValue({
        items: [{ id: 'event-own', kind: 'event', title: 'Teste' }],
        synced_at: '2026-11-13T22:00:00Z',
      });
      mocks.repo.claimSync.mockResolvedValue(true);
      mocks.repo.transaction.mockImplementation(async (work) => work());
      mocks.repo.removeMirroredEvent.mockResolvedValue(canRemove);
      const row = {
        id: 'delete-proposal',
        user_id: 'customer-a',
        app: 'googlecalendar',
        connection_id: 'ca_a',
        action_slug: spec.slug,
        arguments: { event_id: 'event-own' },
        summary: 'Cancelar teste',
        schema_hash: integrationHash([spec.slug, spec.parameters, spec.tags, spec.version]),
      } as unknown as IntegrationAction;
      const reply = await service.confirm(row);
      expect(reply).toContain('Alteração concluída');
      expect(reply.includes('Preservei')).toBe(!canRemove);
      expect(mocks.repo.removeMirroredEvent).toHaveBeenCalledWith(
        'customer-a',
        'ca_a',
        expect.stringMatching(/^int_/),
        '2026-11-13T22:00:00Z'
      );
      expect(mocks.repo.saveSnapshot).toHaveBeenCalledWith(
        'customer-a',
        'googlecalendar',
        'ca_a',
        [expect.objectContaining({ id: 'event-own', status: 'cancelled' })],
        canRemove ? null : expect.any(String)
      );
    }
  );
  it('mirrors a confirmed task completion from a status-only provider receipt', async () => {
    const spec = {
      ...read,
      appName: 'todoist',
      slug: 'TODOIST_CLOSE_TASK_V1',
      tags: ['updateHint'],
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    };
    mocks.connections.mockResolvedValue([{ id: 'ca_a', appName: 'todoist', status: 'ACTIVE' }]);
    mocks.specs.mockResolvedValue([spec]);
    mocks.execute.mockResolvedValue({ successful: true, data: {} });
    mocks.repo.snapshot.mockResolvedValue({
      items: [{ id: 'task-own', kind: 'task', title: 'Teste' }],
      synced_at: '2026-11-13T22:00:00Z',
    });
    mocks.repo.claimSync.mockResolvedValue(true);
    mocks.repo.transaction.mockImplementation(async (work) => work());
    mocks.repo.mirrorTask.mockResolvedValue(true);
    const row = {
      id: 'complete-proposal',
      user_id: 'customer-a',
      app: 'todoist',
      connection_id: 'ca_a',
      action_slug: spec.slug,
      arguments: { task_id: 'task-own' },
      summary: 'Concluir teste',
      schema_hash: integrationHash([spec.slug, spec.parameters, spec.tags, spec.version]),
    } as unknown as IntegrationAction;
    expect(await service.confirm(row)).toContain('Alteração concluída');
    expect(mocks.repo.mirrorTask).toHaveBeenCalledWith(
      'customer-a',
      'todoist',
      expect.stringMatching(/^int_/),
      expect.objectContaining({ id: 'task-own', status: 'completed' }),
      '2026-11-13T22:00:00Z',
      'ca_a'
    );
  });
  it('does not begin a late provider operation after a slow quota reservation', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.repo.reserveCall.mockImplementation(async () => {
      now += 11000;
    });
    await expect(service.run('customer-a', 'gmail', read.slug, {})).rejects.toMatchObject({
      name: 'INTEGRATION_NOT_SENT',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('pins the actual connected account of the authenticated customer', async () => {
    await service.run('customer-a', 'gmail', read.slug, {});
    expect(mocks.execute).toHaveBeenCalledWith(
      'astra-customer:account-a',
      'gmail',
      'ca_a',
      read.slug,
      { user_id: 'me' },
      undefined,
      expect.any(Number)
    );
  });
  it('never shares a read cache between customers', async () => {
    await service.run('customer-a', 'gmail', read.slug, {});
    await service.run('customer-b', 'gmail', read.slug, {});
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[1]?.[2]).toBe('ca_b');
  });
  it('deduplicates repeated reads within the short cache window', async () => {
    await service.run('customer-a', 'gmail', read.slug, {});
    expect(await service.run('customer-a', 'gmail', read.slug, {})).toMatchObject({ cached: true });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('rechecks revocation before serving cached content', async () => {
    await service.run('customer-a', 'gmail', read.slug, {});
    mocks.connections.mockResolvedValue([]);
    await expect(service.run('customer-a', 'gmail', read.slug, {})).rejects.toThrow('Conecte');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('never falls back to an operator account', async () => {
    await expect(service.run('default', 'gmail', read.slug, {})).rejects.toThrow('Vincule');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('refuses an account ID supplied from another customer', async () => {
    await expect(
      service.run('customer-a', 'gmail', read.slug, {}, undefined, 'ca_b')
    ).rejects.toThrow();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('fails closed for multiple accounts until one is selected', async () => {
    mocks.connections.mockResolvedValue([
      { id: 'ca_a', appName: 'gmail', status: 'ACTIVE' },
      { id: 'ca_second', appName: 'gmail', status: 'ACTIVE' },
    ]);
    await expect(service.run('customer-a', 'gmail', read.slug, {})).rejects.toThrow('Escolha');
  });
  it.each([
    {},
    { ...privateContext, channelIsPrivate: false },
    { ...privateContext, channelConversationOnly: true },
    { ...privateContext, externalContentGuard: { seen: true } },
  ])('does not queue writes without a private explicit user request %#', async (ctx) => {
    await expect(
      runInExecContext(ctx, () =>
        service.run('customer-a', 'gmail', write.slug, { to: 'own@example.test', body: 'Teste' })
      )
    ).rejects.toThrow();
    expect(mocks.repo.propose).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(['whatsapp-own', 'telegram-own'])(
    'queues but does not execute writes in %s',
    async (channelPluginId) => {
      const result = await runInExecContext({ ...privateContext, channelPluginId }, () =>
        service.run(
          'customer-a',
          'gmail',
          write.slug,
          { to: 'own@example.test', body: 'Mensagem fictícia' },
          'Revisar mensagem'
        )
      );
      expect(result).toMatchObject({ confirmationRequired: true });
      expect(mocks.repo.propose).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'customer-a',
          connectionId: 'ca_a',
          pluginId: channelPluginId,
          chatId: 'chat-a',
        })
      );
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );
  it('blocks identical uncertain writes instead of retrying', async () => {
    mocks.repo.hasUncertain.mockResolvedValue(true);
    await expect(
      runInExecContext(privateContext, () =>
        service.run('customer-a', 'gmail', write.slug, { to: 'own@example.test', body: 'Teste' })
      )
    ).rejects.toThrow('Antes de repetir');
    expect(mocks.repo.propose).not.toHaveBeenCalled();
  });
  it('keeps external content untrusted for the rest of the turn', async () => {
    const guard = { seen: false };
    await runInExecContext({ ...privateContext, externalContentGuard: guard }, () =>
      service.run('customer-a', 'gmail', read.slug, {})
    );
    expect(guard.seen).toBe(true);
  });
  it('charges a provider call before executing it and stops at the free limit', async () => {
    mocks.repo.reserveCall.mockRejectedValue(new Error('FREE_MONTHLY_LIMIT'));
    await expect(service.run('customer-a', 'gmail', read.slug, {})).rejects.toThrow(
      'FREE_MONTHLY_LIMIT'
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('does not truncate the content a person is asked to confirm', () => {
    const body = 'x'.repeat(2500);
    expect(
      integrationProposalMessage({
        arguments: { to: 'own@example.test', body },
        app: 'gmail',
        summary: 'Mensagem de teste',
      } as unknown as IntegrationAction)
    ).toContain(body);
  });
});
