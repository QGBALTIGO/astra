import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEmit = vi.hoisted(() => vi.fn());
const mockGenerateNative = vi.hoisted(() => vi.fn());
const mockNativeMessageId = vi.hoisted(() => vi.fn(() => 'native-cta-id'));
const mockRecordOutboundQuality = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const contactsRepo = vi.hoisted(() => ({
  remember: vi.fn().mockResolvedValue(0),
  recoverStoredInbound: vi.fn().mockResolvedValue(3),
}));
vi.mock('../../../db/repositories/whatsapp-contact-discovery.js', () => ({
  whatsAppContactDiscoveryRepo: contactsRepo,
}));
vi.mock('../../../services/outbound-quality.js', () => ({
  recordOutboundQuality: mockRecordOutboundQuality,
}));

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  normalizeMessageContent: (await importOriginal<typeof import('@whiskeysockets/baileys')>())
    .normalizeMessageContent,
  default: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn(),
  DisconnectReason: {},
  fetchLatestBaileysVersion: vi.fn(),
  downloadMediaMessage: vi.fn(),
  generateWAMessageFromContent: mockGenerateNative,
  generateMessageIDV2: mockNativeMessageId,
  Browsers: { appropriate: vi.fn() },
  proto: {
    HistorySync: { HistorySyncType: {} },
    Message: { PeerDataOperationRequestType: { FULL_HISTORY_SYNC_ON_DEMAND: 6 } },
  },
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
import { isDirectUserAudio } from './whatsapp-audio-provenance.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { Readable } from 'node:stream';
vi.mock('../../../services/channel-asset-store.js', () => ({
  channelAssetStore: {
    persistIncomingAttachments: async (input: { attachments: unknown[] }) => input.attachments,
  },
}));

describe('WhatsAppChannelAPI', () => {
  it('requests old chats through the existing authenticated socket without chat sends or new login', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    try {
      const api = new WhatsAppChannelAPI({}, 'channel.whatsapp');
      const peer = vi.fn().mockResolvedValue('history-request');
      const send = vi.fn();
      Object.assign(api, {
        sock: { sendPeerDataOperationMessage: peer, sendMessage: send },
        status: 'connected',
      });
      expect(await api.synchronizeContacts()).toEqual({
        contactsRecovered: 3,
        historyRequested: true,
      });
      expect(peer).toHaveBeenCalledWith({
        peerDataOperationRequestType: 6,
        fullHistorySyncOnDemandRequest: { requestMetadata: { requestId: expect.any(String) } },
      });
      expect(send).not.toHaveBeenCalled();
      await expect(api.synchronizeContacts()).rejects.toThrow('já foi solicitada');
      expect(peer).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('does not make a history request after the account socket changed during recovery', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    try {
      const api = new WhatsAppChannelAPI({}, 'channel.whatsapp');
      const peer = vi.fn();
      Object.assign(api, { sock: { sendPeerDataOperationMessage: peer }, status: 'connected' });
      contactsRepo.recoverStoredInbound.mockImplementationOnce(async () => {
        Object.assign(api, { sock: null });
        return 0;
      });
      await expect(api.synchronizeContacts()).rejects.toThrow('reconectou');
      expect(peer).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    [{}, true],
    [{ isForwarded: true }, false],
    [{ forwardingScore: 1 }, false],
  ])(
    'preserves authenticated direct/forwarded audio origin from Baileys: %j',
    async (contextInfo, direct) => {
      vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
      try {
        vi.mocked(downloadMediaMessage).mockResolvedValueOnce(
          Readable.from([Buffer.from('synthetic direct audio')]) as never
        );
        const api = new WhatsAppChannelAPI({ my_phone: '5511999990102' }, 'channel.whatsapp');
        (api as any).sock = { user: { id: '5511999990102@s.whatsapp.net' } };
        await (api as any).handleIncomingMessage({
          key: { remoteJid: '5567999991234@s.whatsapp.net', id: 'audio-origin', fromMe: false },
          message: { audioMessage: { mimetype: 'audio/ogg', contextInfo } },
          messageTimestamp: 1700000000,
          metadata: { directUserAudio: true, isForwarded: false },
        });
        expect(mockEmit).toHaveBeenCalledTimes(1);
        const { message } = mockEmit.mock.calls[0]![0];
        expect(message.attachments[0].type).toBe('audio');
        expect(isDirectUserAudio(message)).toBe(direct);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );
  it('bounds a stuck media download even when the provider ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(downloadMediaMessage).mockImplementationOnce(() => new Promise(() => {}));
      const api = new WhatsAppChannelAPI({}, 'channel.whatsapp');
      const result = (api as any).downloadAttachmentData({});
      await vi.advanceTimersByTimeAsync(12000);
      expect(await result).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it('stops oversized media before accumulating more than the limit', async () => {
    vi.mocked(downloadMediaMessage).mockResolvedValueOnce(
      Readable.from([Buffer.alloc(12 * 1024 * 1024 + 1)]) as never
    );
    const api = new WhatsAppChannelAPI({}, 'channel.whatsapp');
    expect(await (api as any).downloadAttachmentData({})).toBeUndefined();
  });
  it.each([
    [
      {
        documentWithCaptionMessage: {
          message: {
            documentMessage: { mimetype: 'audio/wav', fileName: 'synthetic.wav', caption: 'teste' },
          },
        },
      },
      'file',
    ],
    [{ ephemeralMessage: { message: { audioMessage: { mimetype: 'audio/ogg' } } } }, 'audio'],
  ])('processes media inside WhatsApp content wrappers', async (content, type) => {
    vi.mocked(downloadMediaMessage).mockResolvedValueOnce(
      Readable.from([Buffer.from('synthetic audio')]) as never
    );
    const api = new WhatsAppChannelAPI({ my_phone: '37253049737' }, 'channel.whatsapp');
    (api as any).sock = { user: { id: '37253049737:0@s.whatsapp.net' } };
    await (api as any).handleIncomingMessage({
      key: { remoteJid: '37253049737@s.whatsapp.net', id: 'wrapped-media', fromMe: true },
      message: content,
      messageTimestamp: 1700000000,
    });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const { message } = mockEmit.mock.calls[0]![0];
    expect(message.attachments[0].type).toBe(type);
    expect(Buffer.from(message.attachments[0].data).toString()).toBe('synthetic audio');
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks both mobile spellings and requires a single registered recipient', async () => {
    const api = new WhatsAppChannelAPI({}, 'channel.whatsapp');
    const onWhatsApp = vi.fn();
    Object.assign(api, { sock: { onWhatsApp }, status: 'connected' });
    const long = '5538998760123',
      short = '553898760123';
    const result = (phone: string) => ({ exists: true, jid: phone + '@s.whatsapp.net' });
    onWhatsApp.mockResolvedValue([result(short), result(short)]);
    expect(await api.resolveWhatsAppRecipient(long)).toBe(short);
    expect(onWhatsApp).toHaveBeenCalledWith(long, short);
    onWhatsApp.mockResolvedValue([result(long)]);
    expect(await api.resolveWhatsAppRecipient(short)).toBe(long);
    onWhatsApp.mockResolvedValue([result(short), result(long)]);
    expect(await api.resolveWhatsAppRecipient(short)).toBeNull();
    const getLIDForPN = vi.fn().mockResolvedValue('12345@lid');
    Object.assign(api, { sock: { onWhatsApp, signalRepository: { lidMapping: { getLIDForPN } } } });
    expect(await api.resolveWhatsAppRecipient(long)).toBe(short);
    getLIDForPN.mockResolvedValueOnce('12345@lid').mockResolvedValueOnce('99999@lid');
    expect(await api.resolveWhatsAppRecipient(long)).toBeNull();
    onWhatsApp.mockResolvedValue([result('553833330123')]);
    expect(await api.resolveWhatsAppRecipient('553833330123')).toBe('553833330123');
    expect(onWhatsApp).toHaveBeenLastCalledWith('553833330123');
  });

  it('resolves @lid messages to remoteJidAlt when available', async () => {
    const api = new WhatsAppChannelAPI({ my_phone: '37253049737' }, 'channel.whatsapp');
    const resolved = await (api as any).resolveIncomingJid({
      remoteJid: '243060956995782@lid',
      remoteJidAlt: '37253049737@s.whatsapp.net',
    });

    expect(resolved).toBe('37253049737@s.whatsapp.net');
  });

  it.each(['244927000001', '5581999990101', '558199990101'])(
    'recognizes a verified international or Brazilian LID without an alternate JID: %s',
    async (phone) => {
      vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
      try {
        mockEmit.mockClear();
        const api = new WhatsAppChannelAPI({ my_phone: '5511999990102' }, 'channel.whatsapp');
        const getPNForLID = vi.fn().mockResolvedValue(phone + '@s.whatsapp.net');
        (api as any).sock = {
          user: { id: '5511999990102@s.whatsapp.net' },
          signalRepository: { lidMapping: { getPNForLID } },
        };
        await (api as any).handleIncomingMessage({
          key: { remoteJid: '90000123456789@lid', id: 'mapped-' + phone, fromMe: false },
          message: { conversation: 'Olá' },
          messageTimestamp: 1700000000,
        });
        expect(getPNForLID).toHaveBeenCalledWith('90000123456789@lid');
        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockEmit.mock.calls[0]![0].message.sender.platformUserId).toBe(phone);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );
  it.each([null, '90000123456789@lid', 'invalid@s.whatsapp.net'])(
    'never trusts an unresolved mapping as a customer phone: %s',
    async (mapped) => {
      const api = new WhatsAppChannelAPI({ my_phone: '5511999990102' }, 'channel.whatsapp');
      (api as any).sock = {
        signalRepository: { lidMapping: { getPNForLID: vi.fn().mockResolvedValue(mapped) } },
      };
      expect(await (api as any).resolveIncomingJid({ remoteJid: '90000123456789@lid' })).toBe(
        '90000123456789@lid'
      );
    }
  );

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
      acquireSendSlot: vi
        .fn()
        .mockResolvedValue({ sock: socket, permit: { commit: vi.fn(), release: vi.fn() } }),
    });
    mockGenerateNative.mockReturnValue({
      key: { id: 'native-cta-id', remoteJid: '5511999999999@s.whatsapp.net' },
      message: { interactiveMessage: { body: { text: body } } },
    });
    return { api, socket };
  }

  const oldLogin = 'https://astra-gateway-production.up.railway.app/cliente/entrar';
  const newLogin = 'https://app.astraacessor.pro/cliente/entrar';
  it('delivers a canonical customer reply through its verified ninth-digit spelling, including after cache reset', async () => {
    const { api, socket } = prepare();
    const full = '5581999990101',
      short = '558199990101';
    const onWhatsApp = vi
      .fn()
      .mockResolvedValue([{ exists: true, jid: short + '@s.whatsapp.net' }]);
    Object.assign(socket, { onWhatsApp });
    expect(await api.resolveWhatsAppRecipient(short)).toBe(short);
    await api.sendMessage({ platformChatId: full, text: 'Resposta da conta canônica' });
    expect(socket.sendMessage.mock.calls[0]?.[0]).toBe(short + '@s.whatsapp.net');
    expect(onWhatsApp).toHaveBeenCalledTimes(1);
    (api as any).clearAccountCaches();
    await api.sendMessage({ platformChatId: full, text: 'Lembrete depois da reconexão' });
    expect(socket.sendMessage.mock.calls[1]?.[0]).toBe(short + '@s.whatsapp.net');
    expect(onWhatsApp).toHaveBeenCalledTimes(2);
  });
  it('keeps the exact intended phone when its other spelling is a different WhatsApp account', async () => {
    const { api, socket } = prepare();
    const full = '5581999990101',
      short = '558199990101';
    Object.assign(socket, {
      onWhatsApp: vi.fn().mockResolvedValue([
        { exists: true, jid: full + '@s.whatsapp.net' },
        { exists: true, jid: short + '@s.whatsapp.net' },
      ]),
      signalRepository: {
        lidMapping: {
          getLIDForPN: vi.fn(async (p: string) =>
            p === full + '@s.whatsapp.net' ? '10001@lid' : '10002@lid'
          ),
        },
      },
    });
    await api.sendMessage({ platformChatId: full, text: 'Apenas ao destinatário exato' });
    expect(socket.sendMessage.mock.calls[0]?.[0]).toBe(full + '@s.whatsapp.net');
  });
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
  it('sends a long Radar digest once as readable text with its dashboard link', async () => {
    const { api, socket } = prepare();
    const text = '📡 *Seu Radar Astra*\n\n' + 'Uma notícia com data e link.\n'.repeat(50);
    const radarUrl = 'https://app.astraacessor.pro/cliente/radar';
    await api.sendMessage({
      platformChatId: '5511999999999',
      text,
      urlButton: { label: 'Meu Radar', url: radarUrl },
    });
    expect(socket.relayMessage).not.toHaveBeenCalled();
    expect(mockGenerateNative).not.toHaveBeenCalled();
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    const output = socket.sendMessage.mock.calls[0]![1].text;
    expect(output).toContain('Seu Radar Astra');
    expect(output).toContain('Uma notícia com data e link.');
    expect(output.match(/https:\/\/app\.astraacessor\.pro\/cliente\/radar/g)).toHaveLength(1);
  });
  it('rejects an unsafe button even when its long body would use plain text', async () => {
    const { api, socket } = prepare();
    await expect(
      api.sendMessage({
        platformChatId: '5511999999999',
        text: 'x'.repeat(1500),
        urlButton: { label: 'Meu Radar', url: 'javascript:alert(1)' },
      })
    ).rejects.toThrow('Invalid WhatsApp URL CTA');
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(socket.relayMessage).not.toHaveBeenCalled();
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
