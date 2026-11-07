import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEmit = vi.hoisted(() => vi.fn());

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn(),
  DisconnectReason: {},
  fetchLatestBaileysVersion: vi.fn(),
  downloadMediaMessage: vi.fn(),
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
});
