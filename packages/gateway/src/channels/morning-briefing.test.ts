import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const m = vi.hoisted(() => ({ getAccount: vi.fn(), build: vi.fn(), resolvePhone: vi.fn() }));
vi.mock('../services/customer-identity.js', () => ({ resolveCustomerPhone: m.resolvePhone }));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: m.getAccount },
}));
vi.mock('../services/morning-briefing.js', () => ({ buildMorningBriefing: m.build }));
import { tryMorningBriefingChannelReply } from './morning-briefing.js';
import { isImmediateMorningRequest, morningComponents } from './morning-components.js';
import { processViaBus, processDirectAgent } from './channel-ai-routing.js';
const request =
  'me dê bom dia, fale uma curiosidade do dia, a temperatura atual é um resumo dos e-mails mais importantes do dia anterior';
const message = (text = request) =>
  ({
    id: 'synthetic-message',
    text,
    platform: 'whatsapp',
    channelPluginId: 'channel.whatsapp',
    platformChatId: '5567999991234',
    sender: { platformUserId: '5567999991234' },
    metadata: { isGroup: false },
  }) as ChannelIncomingMessage;
beforeEach(() => {
  vi.clearAllMocks();
  m.getAccount.mockResolvedValue({ id: 'account-a', timeZone: 'America/Campo_Grande' });
  m.resolvePhone.mockResolvedValue({ accountId: 'account-a', retired: false });
  m.build.mockResolvedValue('Bom dia com todos os componentes.');
});
describe('one-off morning request', () => {
  async function throughChannel(path: 'bus' | 'direct', guard: () => Promise<boolean>) {
    const bus = { process: vi.fn() };
    const reply =
      path === 'bus'
        ? await processViaBus(
            bus as never,
            message(),
            { sessionId: 'morning-test', conversationId: null },
            { ownpilotUserId: 'whatsapp:5567999991234' },
            { sessionsRepo: {} as never, getChannel: () => undefined, isAccessAllowed: guard }
          )
        : await processDirectAgent(message(), 'whatsapp:5567999991234', guard);
    expect(bus.process).not.toHaveBeenCalled();
    return reply;
  }
  it.each(['bus', 'direct'] as const)(
    'preserves every screenshot component at the actual %s entry point',
    async (path) => {
      expect(await throughChannel(path, async () => true)).toContain('todos os componentes');
      expect(m.build).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['bus', 'direct'] as const)(
    'checks access before reading a briefing in %s',
    async (path) => {
      expect(await throughChannel(path, async () => false)).toContain('inativo');
      expect(m.build).not.toHaveBeenCalled();
    }
  );
  it.each(['bus', 'direct'] as const)(
    'rechecks access after the external read in %s',
    async (path) => {
      let active = true;
      m.build.mockImplementationOnce(async () => {
        active = false;
        return 'PRIVATE_EMAIL';
      });
      const reply = await throughChannel(path, async () => active);
      expect(reply).toContain('inativo');
      expect(reply).not.toContain('PRIVATE_EMAIL');
    }
  );
  it('refuses data from an account that does not own the sending phone', async () => {
    m.getAccount.mockResolvedValue({ id: 'account-b', timeZone: 'America/Campo_Grande' });
    expect(await tryMorningBriefingChannelReply(message(), 'whatsapp:5511999995678')).toBeNull();
    expect(m.build).not.toHaveBeenCalled();
  });
  it('discards the composed reply if the sender is relinked during the provider request', async () => {
    m.build.mockImplementationOnce(async () => {
      m.resolvePhone.mockResolvedValue({ accountId: 'account-b', retired: false });
      return 'PRIVATE_EMAIL';
    });
    const text = await tryMorningBriefingChannelReply(message(), 'whatsapp:5567999991234');
    expect(text).not.toContain('PRIVATE_EMAIL');
    expect(text).toContain('mudou durante');
  });
  it('routes the exact second screenshot message to all components', async () => {
    expect(await tryMorningBriefingChannelReply(message(), 'whatsapp:5567999991234')).toContain(
      'todos os componentes'
    );
    expect(m.build).toHaveBeenCalledWith(
      'whatsapp:5567999991234',
      'channel.whatsapp',
      'America/Campo_Grande',
      expect.objectContaining({
        withWeather: true,
        withEmailDigest: true,
        withCuriosity: true,
        emailPreviousDay: true,
      }),
      expect.any(Date)
    );
  });
  it.each([
    'Bom dia todo dia às 6h com clima',
    'Bom dia diário às 6h com clima',
    'Bom dia e registre 20 reais',
    'Bom dia, temperatura e minha agenda',
    'Não me dê bom dia com clima',
  ])('does not steal recurring, negative or unrelated actions: %s', (text) => {
    expect(isImmediateMorningRequest(text)).toBe(false);
  });
  it.each([
    { ...message(), metadata: { isGroup: true } },
    { ...message(), platformChatId: '123@g.us' },
    { ...message(), attachments: [{ type: 'file' }] },
  ])('never reads private email through a group or attachment shortcut', async (msg) => {
    expect(
      await tryMorningBriefingChannelReply(msg as ChannelIncomingMessage, 'whatsapp:5567999991234')
    ).toBeNull();
    expect(m.build).not.toHaveBeenCalled();
  });
  it('respects explicit component exclusions and the rolling 24-hour option', () => {
    expect(
      morningComponents('bom dia sem curiosidade e sem temperatura, com e-mails das últimas 24h')
    ).toEqual({
      withCuriosity: false,
      withWeather: false,
      withEmailDigest: true,
      emailPreviousDay: false,
    });
  });
});
