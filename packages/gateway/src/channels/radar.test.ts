import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const m = vi.hoisted(() => ({
  identity: vi.fn(),
  account: vi.fn(),
  prefs: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../services/customer-identity.js', () => ({ resolveCustomerPhone: m.identity }));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getById: m.account },
}));
vi.mock('../db/repositories/customer-radar.js', () => ({
  CustomerRadarRepository: class {
    preferences = m.prefs;
    savePreferences = m.save;
    list = m.list;
  },
}));
import { tryRadarChannelReply } from './radar.js';
import { processViaBus, processDirectAgent } from './channel-ai-routing.js';
const phone = '5567999991234',
  user = 'whatsapp:' + phone;
const message = (text: string) =>
  ({
    id: 'synthetic',
    platform: 'whatsapp',
    channelPluginId: 'channel.whatsapp',
    platformChatId: phone,
    sender: { platformUserId: phone },
    text,
    metadata: { isGroup: false },
  }) as ChannelIncomingMessage;
beforeEach(() => {
  vi.clearAllMocks();
  m.identity.mockResolvedValue({
    accountId: 'a',
    dataUserId: user,
    phoneNumber: phone,
    isCurrent: true,
    retired: false,
  });
  m.account.mockResolvedValue({ id: 'a', dataUserId: user, phoneNumber: phone });
  m.prefs.mockResolvedValue({
    preferences: { enabled: true, time: '07:00', quietStart: '22:00', quietEnd: '07:00' },
  });
  m.save.mockResolvedValue({});
  m.list.mockResolvedValue([{ label: 'USD', active: true }]);
});
describe('WhatsApp Radar privacy and opt-out', () => {
  it.each([
    'Oi',
    'lembre de pagar amanhã',
    'quais alertas tenho ativos?',
    'parar o lembrete',
    'gastei 10',
  ])('does not read Radar for unrelated text %s', async (t) => {
    expect(await tryRadarChannelReply(message(t), user, async () => true)).toBeNull();
    expect(m.identity).not.toHaveBeenCalled();
  });
  it.each([
    'parar meu Radar',
    'Astra, cancela o Radar!',
    'Pode parar de mandar o radar',
    'Não quero mais receber o Radar.',
  ])('persists opt-out before acknowledging %s even after expiry', async (t) => {
    expect(await tryRadarChannelReply(message(t), user, async () => false)).toContain(
      'Radar pausado'
    );
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
  it('does not acknowledge a failed persistence', async () => {
    m.save.mockRejectedValueOnce(Error('DB_DOWN'));
    const t = await tryRadarChannelReply(message('parar meu radar'), user, async () => false);
    expect(t).toContain('Não consegui');
    expect(t).not.toContain('Radar pausado');
  });
  it.each(['group', 'attachment', 'retired', 'foreign'] as const)(
    'rejects %s context',
    async (kind) => {
      const msg = message('parar meu radar');
      if (kind === 'group') msg.metadata = { isGroup: true };
      if (kind === 'attachment') msg.attachments = [{}] as never;
      if (kind === 'retired') m.identity.mockResolvedValue({ retired: true });
      expect(
        await tryRadarChannelReply(
          msg,
          kind === 'foreign' ? 'whatsapp:5511999999999' : user,
          async () => true
        )
      ).toBeNull();
      expect(m.save).not.toHaveBeenCalled();
    }
  );
  it('uses the preserved historical account key after a phone change', async () => {
    m.identity.mockResolvedValue({
      accountId: 'a',
      dataUserId: 'whatsapp:old',
      isCurrent: true,
      retired: false,
    });
    m.account.mockResolvedValue({ id: 'a', dataUserId: 'whatsapp:old', phoneNumber: phone });
    expect(await tryRadarChannelReply(message('meu radar'), user, async () => true)).toContain(
      'USD'
    );
  });
  it('does not expose interests after access expiry', async () => {
    const t = await tryRadarChannelReply(message('meu radar'), user, async () => false);
    expect(t).not.toContain('USD');
    expect(m.list).not.toHaveBeenCalled();
  });
  it('discards private interests if the phone is relinked during the read', async () => {
    m.list.mockImplementation(async () => {
      m.identity.mockResolvedValue({ accountId: 'b', isCurrent: true, retired: false });
      return [{ label: 'PRIVATE_INTEREST', active: true }];
    });
    expect(await tryRadarChannelReply(message('meu radar'), user, async () => true)).not.toContain(
      'PRIVATE_INTEREST'
    );
  });
  it.each(['bus', 'direct'] as const)(
    'handles opt-out before inactive-access short circuits in %s',
    async (path) => {
      const text =
        path === 'bus'
          ? await processViaBus(
              { process: vi.fn() } as never,
              message('parar meu radar'),
              { sessionId: 's', conversationId: null },
              { ownpilotUserId: user },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => false,
              }
            )
          : await processDirectAgent(message('parar meu radar'), user, async () => false);
      expect(text).toContain('Radar pausado');
    }
  );
});
