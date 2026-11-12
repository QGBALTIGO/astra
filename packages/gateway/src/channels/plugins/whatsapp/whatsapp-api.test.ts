import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEmit = vi.hoisted(() => vi.fn());
const mockGenerateNative = vi.hoisted(() => vi.fn());
const mockNativeMessageId = vi.hoisted(() => vi.fn(() => 'native-cta-id'));
const mockRecordOutboundQuality = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../services/outbound-quality.js', () => ({
  recordOutboundQuality: mockRecordOutboundQuality,
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn(),
  DisconnectReason: {},
  fetchLatestBaileysVersion: vi.fn(),
  downloadMediaMessage: vi.fn(),
  generateWAMessageFromContent: mockGenerateNative,
  generateMessageIDV2: mockNativeMessageId,
  Browsers: { appropriate: vi.fn() },
  proto: { HistorySync: { HistorySyncType: {} } },
}));

vi.mock('@hapi/boom', () => ({ Boom: class Boom extends Error {} }));
vi.mock('pino', () => ({
  default: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('../../../services/log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../routes/helpers.js', () => ({
  getErrorMessage: (error: unknown) => String(error),
}));
vi.mock('../../../config/defaults.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, MAX_MESSAGE_CHAT_MAP_SIZE: 1000 };
});
vi.mock('../../utils/message-utils.js', () => ({ splitMessage: (text: string) => [text] }));
vi.mock('./session-store.js', () => ({ getSessionDir: vi.fn(), clearSession: vi.fn() }));
vi.mock('../../../ws/server.js', () => ({ wsGateway: { broadcast: vi.fn() } }));
vi.mock('@ownpilot/core/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ownpilot/core')>();
  return {
    ...actual,
    getEventBus: () => ({ emit: mockEmit }),
    createEvent: (_name: string, _source: string, _pluginId: string, data: unknown) => data,
  };
});

import { WhatsAppChannelAPI } from './whatsapp-api.js';

describe('WhatsAppChannelAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves @lid messages to remoteJidAlt when available', () => {
    const api = new WhatsAppChannelAPI({ my_phone: '37253049737' }, 'channel.whatsapp');
    const resolved = (api as any).resolveIncomingJid({
      remoteJid: '243060956995782@lid',
      remoteJidAlt: '37253049737@s.whatsapp.net',
    });

    expect(resolved).toBe('37253049737@s.whatsapp.net');
  });

  it('emits self-chat messages when self message arrives as @lid', async () => {
    const api = new WhatsAppChannelAPI({ my_phone: '37253049737' }, 'channel.whatsapp');
    (api as any).sock = { user: { id: '37253049737:0@s.whatsapp.net' } };

    await (api as any).handleIncomingMessage({
      key: {
        remoteJid: '243060956995782@lid',
        remoteJidAlt: '37253049737@s.whatsapp.net',
        id: 'msg-1',
        fromMe: true,
      },
      pushName: 'Me',
      message: { conversation: 'test' },
      messageTimestamp: 1700000000,
    });

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const payload = mockEmit.mock.calls[0]![0] as {
      message: { sender: { platformUserId: string } };
    };
    expect(payload.message.sender.platformUserId).toBe('37253049737');
  });

  it.each([1700000000, BigInt(1700000000), { toNumber: () => 1700000000 }, undefined])(
    'preserves the provider timestamp or marks the locally estimated time on live ingress',
    async (messageTimestamp) => {
      const api = new WhatsAppChannelAPI({ my_phone: '37253049737' }, 'channel.whatsapp');
      (api as any).sock = { user: { id: '37253049737:0@s.whatsapp.net' } };
      await (api as any).handleIncomingMessage({
        key: { remoteJid: '37253049737@s.whatsapp.net', id: 'edge-time', fromMe: true },
        message: { conversation: 'teste' },
        messageTimestamp,
      });
      const { message } = mockEmit.mock.calls[0]![0];
      if (messageTimestamp) {
        expect(+message.timestamp).toBe(1700000000000);
        expect(message.metadata.estimatedTimestamp).toBeUndefined();
      } else {
        expect(message.timestamp).toBeInstanceOf(Date);
        expect(message.metadata.estimatedTimestamp).toBe(true);
      }
    }
  );

  it('skips non-self direct messages', async () => {
    const api = new WhatsAppChannelAPI({ my_phone: '37253049737' }, 'channel.whatsapp');
    (api as any).sock = { user: { id: '37253049737:0@s.whatsapp.net' } };

    await (api as any).handleIncomingMessage({
      key: {
        remoteJid: '905551234567@s.whatsapp.net',
        id: 'msg-2',
        fromMe: false,
      },
      pushName: 'Other',
      message: { conversation: 'hello' },
      messageTimestamp: 1700000000,
    });

    expect(mockEmit).not.toHaveBeenCalled();
  });
  it('routes inbound DMs from distinct phones only when multi-user mode is enabled', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    try {
      const api = new WhatsAppChannelAPI({ my_phone: '5567981030648' }, 'channel.whatsapp');
      (api as any).sock = { user: { id: '5567981030648:0@s.whatsapp.net' } };

      for (const [id, phone] of [
        ['guest-1', '5521997557364'],
        ['guest-2', '5511987654321'],
      ]) {
        await (api as any).handleIncomingMessage({
          key: {
            remoteJid: `${phone}@s.whatsapp.net`,
            id,
            fromMe: false,
          },
          pushName: phone,
          message: { conversation: 'Quanto gastei este mês?' },
          messageTimestamp: 1700000000,
        });
      }

      expect(mockEmit).toHaveBeenCalledTimes(2);
      const senders = mockEmit.mock.calls.map((call) => {
        const data = call[0] as {
          message: {
            sender: { platformUserId: string };
            metadata: { isSelfChat: boolean; fromMe: boolean };
          };
        };
        expect(data.message.metadata).toMatchObject({ isSelfChat: false, fromMe: false });
        return data.message.sender.platformUserId;
      });
      expect(senders).toEqual(['5521997557364', '5511987654321']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never routes outgoing manual messages to customers or unresolved LIDs', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    try {
      const api = new WhatsAppChannelAPI({ my_phone: '5567981030648' }, 'channel.whatsapp');
      (api as any).sock = { user: { id: '5567981030648:0@s.whatsapp.net' } };

      await (api as any).handleIncomingMessage({
        key: { remoteJid: '5521997557364@s.whatsapp.net', id: 'manual', fromMe: true },
        message: { conversation: 'Não responder' },
        messageTimestamp: 1700000000,
      });
      await (api as any).handleIncomingMessage({
        key: { remoteJid: '243060956995782@lid', id: 'lid', fromMe: false },
        message: { conversation: 'Identidade não resolvida' },
        messageTimestamp: 1700000000,
      });
      expect(mockEmit).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('WhatsApp native URL CTA transport (no real WhatsApp sends)', () => {
  const body = '✅ *Entrada registrada*\n\n• *Valor:* R$ 1,00';
  const url = 'https://app.astraacessor.pro/cliente/transacoes';
  function prepare() {
    mockGenerateNative.mockClear();
    const api = new WhatsAppChannelAPI({ my_phone: '5511888888888' }, 'channel.whatsapp');
    const socket = {
      user: { id: '5511888888888:1@s.whatsapp.net' },
      relayMessage: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'plaintext-send' } }),
      sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    };
    Object.assign(api as object, {
      sock: socket,
      status: 'connected',
      connectedAccountPhone: '5511888888888',
      waitForConnectedAccount: vi.fn().mockResolvedValue(undefined),
      acquireSendSlot: vi.fn().mockResolvedValue(socket),
    });
    mockGenerateNative.mockReturnValue({
      key: { id: 'native-cta-id', remoteJid: '5511999999999@s.whatsapp.net' },
      message: { interactiveMessage: { body: { text: body } } },
    });
    return { api, socket };
  }

  const oldLogin = 'https://astra-gateway-production.up.railway.app/cliente/entrar';
  const newLogin = 'https://app.astraacessor.pro/cliente/entrar';
  it('delivers the readable public login and matching native button together after historical model output', async () => {
    const { api, socket } = prepare();
    await api.sendMessage({
      platformChatId: '5511999999999',
      text: 'Abra seu painel: ' + oldLogin,
      urlButton: { label: 'Abrir meu painel', url: oldLogin },
    });
    const proto = mockGenerateNative.mock.calls[0]![1];
    expect(proto.interactiveMessage.body.text).toBe('Abra seu painel: ' + newLogin);
    expect(
      JSON.parse(proto.interactiveMessage.nativeFlowMessage.buttons[0].buttonParamsJson).url
    ).toBe(newLogin);
    expect(socket.relayMessage).toHaveBeenCalledTimes(1);
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
  it('uses the readable login once when the socket lacks the native relay capability', async () => {
    const { api, socket } = prepare();
    Object.assign(socket, { relayMessage: undefined });
    await api.sendMessage({
      platformChatId: '5511999999999',
      text: 'Entre pelo painel.',
      urlButton: { label: 'Abrir meu painel', url: oldLogin },
    });
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    expect(socket.sendMessage.mock.calls[0]![1].text).toContain(newLogin);
    expect(mockGenerateNative).not.toHaveBeenCalled();
  });
  it('uses one text message for a login response beyond the native body limit without resending or doubling its link', async () => {
    const { api, socket } = prepare();
    const long = 'Orientação. '.repeat(100) + 'Abra ' + oldLogin + '.';
    await api.sendMessage({
      platformChatId: '5511999999999',
      text: long,
      urlButton: { label: 'Abrir meu painel', url: oldLogin },
    });
    expect(socket.relayMessage).not.toHaveBeenCalled();
    expect(mockGenerateNative).not.toHaveBeenCalled();
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    const output = socket.sendMessage.mock.calls[0]![1].text;
    expect(output).toBe(long.replace(oldLogin, newLogin));
  });
  it('relays one native-flow CTA and never sends the dashboard URL as plain text', async () => {
    const { api, socket } = prepare();
    const messageId = await api.sendMessage({
      platformChatId: '5511999999999',
      text: body,
      urlButton: { label: 'Acompanhar no painel', url },
    });
    expect(messageId).toBe('native-cta-id');
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(socket.relayMessage).toHaveBeenCalledTimes(1);
    expect(socket.relayMessage).toHaveBeenCalledWith(
      '5511999999999@s.whatsapp.net',
      expect.any(Object),
      expect.objectContaining({ messageId: 'native-cta-id', additionalNodes: expect.any(Array) })
    );
    expect(mockGenerateNative).toHaveBeenCalledOnce();
    const [jid, content, opts] = mockGenerateNative.mock.calls[0]!;
    expect(jid).toBe('5511999999999@s.whatsapp.net');
    expect(content.interactiveMessage?.body?.text).toBe(body);
    const button = content.interactiveMessage?.nativeFlowMessage?.buttons?.[0];
    expect(button.name).toBe('cta_url');
    expect(JSON.parse(button.buttonParamsJson)).toMatchObject({
      display_text: 'Acompanhar no painel',
      url,
      merchant_url: url,
    });
    expect(opts.userJid).toBe(socket.user.id);
    expect(mockRecordOutboundQuality).toHaveBeenCalledWith(
      'channel.whatsapp',
      'native-cta-id',
      body
    );
    expect(mockRecordOutboundQuality.mock.calls[0]?.[2]).not.toContain(url);
  });

  it('never retries an ambiguous native CTA failure as an exposed link', async () => {
    const { api, socket } = prepare();
    socket.relayMessage.mockRejectedValueOnce(new Error('ambiguous socket failure'));
    await expect(
      api.sendMessage({
        platformChatId: '5511999999999',
        text: body,
        urlButton: { label: 'Acompanhar no painel', url },
      })
    ).rejects.toThrow('ambiguous socket failure');
    expect(socket.relayMessage).toHaveBeenCalledTimes(1);
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it('does not downgrade unsafe CTA parameters into ordinary text', async () => {
    const { api, socket } = prepare();
    await expect(
      api.sendMessage({
        platformChatId: '5511999999999',
        text: body,
        urlButton: { label: 'Acompanhar no painel', url: 'javascript:alert(1)' },
      })
    ).rejects.toThrow('Invalid WhatsApp URL CTA');
    expect(socket.relayMessage).not.toHaveBeenCalled();
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
});
