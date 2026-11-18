import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const f = vi.hoisted(() => ({
  prepare: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  account: vi.fn(),
}));
vi.mock('../db/repositories/finance-bulk-selection.js', () => ({
  financeBulkSelectionRepo: { prepare: f.prepare, confirm: f.confirm, cancel: f.cancel },
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: f.account },
}));
import { financeBulkIntent, isBulkFinanceDeletionRequest } from './finance-bulk-intent.js';
import { tryPendingFinanceDeletion } from './finance-bulk-routing.js';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';
const incoming = (
  text: string,
  patch: Partial<ChannelIncomingMessage> = {}
): ChannelIncomingMessage => ({
  id: 'fixture-delete-request',
  platform: 'whatsapp',
  channelPluginId: 'channel.whatsapp',
  platformChatId: 'fixture-chat',
  sender: { platform: 'whatsapp', platformUserId: 'fixture-chat' },
  timestamp: new Date(),
  text,
  metadata: {},
  attachments: [],
  ...patch,
});
beforeEach(() => {
  vi.clearAllMocks();
  f.account.mockResolvedValue({
    id: 'fixture-account',
    dataUserId: 'fixture-user',
    phoneNumber: 'fixture-chat',
    authVersion: 1,
  });
  f.prepare.mockResolvedValue({
    kind: 'preview',
    count: 3,
    protected: 0,
    filter: { type: 'income', currency: 'BRL' },
  });
  f.confirm.mockResolvedValue({
    kind: 'done',
    result: {
      selected: 3,
      deleted: 2,
      changed: 1,
      protected: 0,
      remindersCancelled: 2,
      alreadySending: 0,
    },
  });
});
describe('financial bulk request intent', () => {
  it.each([
    'Remova todos',
    'Quero remover todos que estão pendentes',
    'Apague os pendentes',
    'Exclua tudo que está pendente',
    'Apaga tudo que estiver pendente',
    'Apague esses pendentes',
    'Remova essas pendências',
    'Pode remover os recebimentos pendentes',
    'Exclua esses lançamentos',
    'Remova aqueles',
  ])('keeps contextual scope for %s', (text) => {
    expect(financeBulkIntent(text)).toBe('context');
    expect(isBulkFinanceDeletionRequest(text)).toBe(true);
  });
  it.each([
    'Remova todos os lançamentos pendentes',
    'Exclua todos os registros pendentes',
    'Remova todos os meus lançamentos pendentes',
    'Apaga todos os lançamentos pendentes',
    'Remova todos os registros que estão pendentes',
    'Exclua todas as transações pendentes',
    'Remova todos as entradas pendentes',
    'Remova todas as entradas pendentes',
    'Exclua todas as minhas receitas pendentes',
    'Apague todas as saídas que estão pendentes',
    'Remova todos os recebimentos pendentes',
  ])('recognizes an explicit whole-ledger preview %s', (text) =>
    expect(financeBulkIntent(text)).toBe('global')
  );
  it.each(['pode remover', 'pode apagar', 'pode excluir'])(
    'accepts %s only as an existing-preview confirmation',
    (text) => {
      expect(financeBulkIntent(text)).toBe('confirm');
      expect(isBulkFinanceDeletionRequest(text)).toBe(true);
    }
  );
  it.each([
    'Remova todos os registros do cliente sintético',
    'Exclua em lote os valores a receber de novembro',
    'Não remova todos',
    'Dê um exemplo: apaga tudo',
  ])('guards broader bulk language without turning it into an executable request: %s', (text) => {
    expect(financeBulkIntent(text)).toBeNull();
    expect(isBulkFinanceDeletionRequest(text)).toBe(true);
  });
  it.each([
    'Não remova todos',
    'Dê um exemplo: remova todos',
    'Quanto eu tenho a receber?',
    'Exclua o gasto do café',
    'Remova todos os lembretes',
    'Remova todos os lançamentos pendentes e registre100',
    'Não apague esses pendentes',
    'Apague esse gasto de café',
    'Remova esses lembretes',
    'Exclua esses lançamentos e registre 50',
  ])('does not reinterpret a different/negated/compound request %s', (text) =>
    expect(financeBulkIntent(text)).toBeNull()
  );
});
describe('deterministic financial deletion preview and confirmation', () => {
  it.each(['bus', 'direct'])(
    'reviews the reported pending-income request in %s before a separate confirmation',
    async (route) => {
      const input = incoming('Remova todos as entradas pendentes');
      const bus = { process: vi.fn() };
      const reply =
        route === 'bus'
          ? await processViaBus(
              bus as never,
              input,
              { sessionId: 'fixture-session', conversationId: null },
              { ownpilotUserId: 'fixture-user' },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => true,
              }
            )
          : await processDirectAgent(input, 'fixture-user', async () => true);
      expect(reply).toContain('Revisar exclusão');
      expect(reply).toContain('Valores a receber');
      expect(f.prepare.mock.calls[0]?.[4]).toBe(true);
      expect(f.prepare.mock.calls[0]?.[6]).toBe('income');
      expect(f.confirm).not.toHaveBeenCalled();
      expect(bus.process).not.toHaveBeenCalled();

      const receipt = await tryPendingFinanceDeletion(
        incoming('confirmo excluir os pendentes', { id: 'fixture-confirm-request' }),
        'fixture-user',
        async () => true
      );
      expect(receipt).toContain('Removidos:* 2');
      expect(f.confirm).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    ['Remova essas entradas pendentes', false, 'income'],
    ['Exclua todas as despesas pendentes', true, 'expense'],
    ['Remova essas saídas pendentes', false, 'expense'],
  ])('keeps the explicit transaction type for %s', async (text, global, type) => {
    await tryPendingFinanceDeletion(incoming(text as string), 'fixture-user', async () => true);
    expect(f.prepare.mock.calls[0]?.[4]).toBe(global);
    expect(f.prepare.mock.calls[0]?.[6]).toBe(type);
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it.each(['bus', 'direct'])(
    'intercepts a global pending deletion before any model or individual delete in %s',
    async (route) => {
      const input = incoming('Remova todos os lançamentos pendentes');
      const bus = { process: vi.fn() };
      const reply =
        route === 'bus'
          ? await processViaBus(
              bus as never,
              input,
              { sessionId: 'fixture-session', conversationId: null },
              { ownpilotUserId: 'fixture-user' },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => true,
              }
            )
          : await processDirectAgent(input, 'fixture-user', async () => true);
      expect(reply).toContain('Revisar exclusão');
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.confirm).not.toHaveBeenCalled();
      expect(bus.process).not.toHaveBeenCalled();
    }
  );
  it('previews contextual income without deleting or granting global scope', async () => {
    const reply = await tryPendingFinanceDeletion(
      incoming('Quero remover todos que estão pendentes'),
      'fixture-user',
      async () => true
    );
    expect(reply).toContain('Revisar exclusão');
    expect(reply).toContain('Valores a receber');
    expect(reply).toContain('confirmo excluir os pendentes');
    expect(f.prepare.mock.calls[0]?.[4]).toBe(false);
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('requires a separate confirmation even for an explicit global request', async () => {
    await tryPendingFinanceDeletion(
      incoming('Remova todos os lançamentos pendentes'),
      'fixture-user',
      async () => true
    );
    expect(f.prepare.mock.calls[0]?.[4]).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('confirms from actual result counts, preserving changed/settled items', async () => {
    const reply = await tryPendingFinanceDeletion(
      incoming('confirmo excluir os pendentes'),
      'fixture-user',
      async () => true
    );
    expect(reply).toContain('Removidos:*2'.replace(':*2', ':* 2'));
    expect(reply).toContain('Alterados ou recebidos');
    expect(reply).toContain('preservados');
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('asks for a selection instead of falling back to an arbitrary model deletion', async () => {
    f.prepare.mockResolvedValue({ kind: 'missing' });
    expect(
      await tryPendingFinanceDeletion(incoming('Remova todos'), 'fixture-user', async () => true)
    ).toContain('Quais pendentes');
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('does not claim all items were removed when dependencies are protected', async () => {
    f.prepare.mockResolvedValue({ kind: 'preview', count: 2, protected: 1, filter: {} });
    expect(
      await tryPendingFinanceDeletion(incoming('Remova todos'), 'fixture-user', async () => true)
    ).toContain('Vinculados preservados');
  });
  it('never queries or confirms without current access, in a group, or for another sender', async () => {
    await tryPendingFinanceDeletion(incoming('Remova todos'), 'fixture-user', async () => false);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(
      await tryPendingFinanceDeletion(
        incoming('Remova todos', { metadata: { isGroup: true } }),
        'fixture-user',
        async () => true
      )
    ).toBeNull();
    expect(
      await tryPendingFinanceDeletion(
        incoming('Remova todos', {
          sender: { platform: 'whatsapp', platformUserId: 'another-user' },
        }),
        'fixture-user',
        async () => true
      )
    ).toBeNull();
  });
  it('hides a completed preview when account binding changes while awaiting it', async () => {
    let release!: (value: unknown) => void;
    let ready!: () => void;
    const began = new Promise<void>((r) => {
      ready = r;
    });
    f.prepare.mockImplementation(() => {
      ready();
      return new Promise((r) => {
        release = r;
      });
    });
    const reply = tryPendingFinanceDeletion(
      incoming('Remova todos'),
      'fixture-user',
      async () => true
    );
    await began;
    f.account.mockResolvedValue({ id: 'relinked-account', phoneNumber: 'other-phone' });
    release({ kind: 'preview', count: 99, protected: 0, filter: {} });
    expect(await reply).toContain('acesso');
    expect(await reply).not.toContain('99');
  });
});
