import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const mocks = vi.hoisted(() => ({
  pending: vi.fn(),
  claim: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../db/repositories/customer-integrations.js', () => ({
  customerIntegrationsRepo: {
    latestPending: mocks.pending,
    claim: mocks.claim,
    cancel: mocks.cancel,
  },
}));
vi.mock('../services/customer-integrations.js', () => ({
  customerIntegrationService: { confirm: mocks.confirm },
  integrationProposalMessage: () => 'Detalhes do pedido',
}));
import { tryIntegrationConfirmation } from './customer-integrations.js';
const row = {
  id: 'proposal',
  user_id: 'customer-a',
  request_message_id: 'old-message',
  prompt_sent_at: new Date(Date.now() - 5000),
  expires_at: new Date(Date.now() + 600000),
  confirmation_token: 'ABC123',
};
const message = (text = 'sim', platform = 'whatsapp') =>
  ({
    id: 'confirmation',
    platform,
    channelPluginId: 'plugin-' + platform,
    platformChatId: '123',
    sender: { platformUserId: '123' },
    timestamp: new Date(),
    text,
    metadata: { chatType: 'private' },
  }) as unknown as ChannelIncomingMessage;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ASTRA_CUSTOMER_OAUTH_ENABLED', 'true');
  mocks.pending.mockResolvedValue({ ...row });
  mocks.claim.mockResolvedValue(row);
  mocks.confirm.mockResolvedValue('Alteração confirmada');
});
describe('private channel integration confirmation', () => {
  it.each(['whatsapp', 'telegram'])(
    'claims exactly the customer and conversation on %s',
    async (platform) => {
      expect(await tryIntegrationConfirmation(message('sim', platform), 'customer-a')).toBe(
        'Alteração confirmada'
      );
      expect(mocks.claim).toHaveBeenCalledWith(
        'proposal',
        'customer-a',
        'plugin-' + platform,
        '123'
      );
    }
  );
  it('does not accept a file caption as confirmation', async () => {
    expect(
      await tryIntegrationConfirmation(
        { ...message(), attachments: [{}] } as ChannelIncomingMessage,
        'customer-a'
      )
    ).toBeNull();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('does not execute in a group', async () => {
    expect(
      await tryIntegrationConfirmation(
        { ...message(), metadata: { isGroup: true } } as ChannelIncomingMessage,
        'customer-a'
      )
    ).toBeNull();
    expect(mocks.pending).not.toHaveBeenCalled();
  });
  it('does not execute an unseen proposal', async () => {
    mocks.pending.mockResolvedValue({ ...row, prompt_sent_at: null });
    expect(await tryIntegrationConfirmation(message(), 'customer-a')).toContain('depois');
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('rejects a queued yes that predates the proposal delivery', async () => {
    expect(
      await tryIntegrationConfirmation(
        { ...message(), timestamp: new Date(Date.now() - 30000) },
        'customer-a'
      )
    ).toContain('depois');
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('expires a stale proposal instead of executing it', async () => {
    mocks.pending.mockResolvedValue({ ...row, expires_at: new Date(Date.now() - 1) });
    expect(await tryIntegrationConfirmation(message(), 'customer-a')).toContain('expirou');
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('cancels naturally without sending a provider action', async () => {
    expect(await tryIntegrationConfirmation(message('cancelar'), 'customer-a')).toContain(
      'cancelei'
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('rejects confirmation for a different token', async () => {
    expect(await tryIntegrationConfirmation(message('confirmar FFFFFF'), 'customer-a')).toContain(
      'não corresponde'
    );
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('invalidates a pending request when the subject changes', async () => {
    expect(
      await tryIntegrationConfirmation(message('Gastei 20 reais no almoço'), 'customer-a')
    ).toBeNull();
    expect(mocks.cancel).toHaveBeenCalled();
  });
  it('does not replay an already claimed write', async () => {
    mocks.claim.mockResolvedValue(null);
    expect(await tryIntegrationConfirmation(message(), 'customer-a')).toContain('já está');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('keeps operator default outside customer integrations', async () => {
    expect(await tryIntegrationConfirmation(message(), 'default')).toBeNull();
    expect(mocks.pending).not.toHaveBeenCalled();
  });
});
