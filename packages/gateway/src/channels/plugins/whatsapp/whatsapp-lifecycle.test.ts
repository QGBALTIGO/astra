import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WASocket, proto } from '@whiskeysockets/baileys';

const mocks = vi.hoisted(() => ({
  makeSocket: vi.fn(),
  loadAuth: vi.fn(),
  fetchVersion: vi.fn(),
  cacheKeys: vi.fn(),
  setKeys: vi.fn(),
  saveCreds: vi.fn(),
  clearSession: vi.fn(),
  generateMessage: vi.fn(),
  generateMessageId: vi.fn(),
  profilePicture: vi.fn(),
  emit: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  downloadMedia: vi.fn(),
  persistAttachments: vi.fn(),
  splitMessage: vi.fn(),
}));

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  normalizeMessageContent: (await importOriginal<typeof import('@whiskeysockets/baileys')>())
    .normalizeMessageContent,
  default: mocks.makeSocket,
  useMultiFileAuthState: mocks.loadAuth,
  makeCacheableSignalKeyStore: mocks.cacheKeys,
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  fetchLatestBaileysVersion: mocks.fetchVersion,
  downloadMediaMessage: mocks.downloadMedia,
  generateWAMessageFromContent: mocks.generateMessage,
  generateMessageIDV2: mocks.generateMessageId,
  Browsers: { appropriate: vi.fn() },
  proto: { HistorySync: { HistorySyncType: {} } },
}));
vi.mock('pino', () => ({ default: vi.fn(() => ({})) }));
vi.mock('../../../services/log.js', () => ({
  getLog: () => ({ info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../config/defaults.js', () => ({ MAX_MESSAGE_CHAT_MAP_SIZE: 1000 }));
vi.mock('../../utils/message-utils.js', () => ({ splitMessage: mocks.splitMessage }));
vi.mock('./session-store.js', () => ({
  getSessionDir: () => '/test/whatsapp-session',
  clearSession: mocks.clearSession,
}));
vi.mock('../../../ws/server.js', () => ({ wsGateway: { broadcast: vi.fn() } }));
vi.mock('../../../services/channel-asset-store.js', () => ({
  channelAssetStore: { persistIncomingAttachments: mocks.persistAttachments },
}));
vi.mock('@ownpilot/core/events', () => ({
  getEventBus: () => ({ emit: mocks.emit }),
  createEvent: (_name: string, _source: string, _pluginId: string, data: unknown) => data,
}));
vi.mock('@ownpilot/core/channels', () => ({
  ChannelEvents: {
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    DISCONNECTED: 'disconnected',
    ERROR: 'error',
    MESSAGE_RECEIVED: 'message',
  },
}));
vi.mock('@ownpilot/core/utils', () => ({ silentCatch: () => () => undefined }));

vi.mock('./whatsapp-profile-picture.js', () => ({
  fetchWhatsAppProfilePicture: mocks.profilePicture,
}));

import { WhatsAppChannelAPI } from './whatsapp-api.js';
import { ChannelSendNotAttemptedError } from '../../send-not-attempted.js';
const mockHistoricalContacts = vi.hoisted(() => vi.fn().mockResolvedValue(1));
vi.mock('../../../db/repositories/whatsapp-contact-discovery.js', () => ({
  whatsAppContactDiscoveryRepo: {
    remember: mockHistoricalContacts,
    recoverStoredInbound: vi.fn().mockResolvedValue(0),
  },
}));

type Listener = (payload: unknown) => void;

function createSocket(phone = '5511999999999') {
  const listeners = new Map<string, Listener[]>();
  const socket = {
    user: { id: `${phone}:1@s.whatsapp.net`, name: 'Test account' },
    ev: {
      on: vi.fn((name: string, listener: Listener) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      }),
      removeAllListeners: vi.fn((name: string) => listeners.delete(name)),
    },
    end: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    presenceSubscribe: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'sent-message' } }),
    relayMessage: vi.fn().mockResolvedValue(undefined),
  };
  return {
    socket,
    emit(name: string, payload: unknown) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
    },
    capture(name: string) {
      return listeners.get(name)![0]!;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function closed(statusCode: number) {
  return {
    connection: 'close',
    lastDisconnect: { error: Object.assign(new Error('closed'), { output: { statusCode } }) },
  };
}

function message(phone: string, id: string, fromMe = false) {
  return {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: `${phone}@s.whatsapp.net`, id, fromMe },
        message: { conversation: 'Oi' },
        messageTimestamp: 1700000000,
      },
    ],
  };
}

function receivedMessages() {
  return mocks.emit.mock.calls
    .map(([event]) => event as { message?: { metadata: Record<string, unknown> } })
    .filter((event) => event.message);
}

function accessCodeMessage(phone: string, sendBefore = new Date(Date.now() + 300_000)) {
  return {
    platformChatId: phone,
    text: '*Astra · Código de acesso*\n\n*000123*',
    copyCode: { label: 'Copiar código', code: '000123' },
    sendBefore,
  };
}

describe('WhatsApp connection lifecycle', () => {
  let sockets: ReturnType<typeof createSocket>[];
  let apis: WhatsAppChannelAPI[];
  let nextPhone: string;

  const newApi = (configuredPhone = '5511999999999') => {
    const api = new WhatsAppChannelAPI({ my_phone: configuredPhone }, 'channel.whatsapp');
    apis.push(api);
    return api;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    sockets = [];
    apis = [];
    nextPhone = '5511999999999';
    mocks.makeSocket.mockImplementation(() => {
      const harness = createSocket(nextPhone);
      sockets.push(harness);
      return harness.socket as unknown as WASocket;
    });
    mocks.loadAuth.mockResolvedValue({
      state: { creds: {}, keys: { set: mocks.setKeys } },
      saveCreds: mocks.saveCreds,
    });
    mocks.cacheKeys.mockImplementation((keys: unknown) => keys);
    mocks.setKeys.mockResolvedValue(undefined);
    mocks.fetchVersion.mockResolvedValue({ version: [2, 3000, 1] });
    mocks.saveCreds.mockResolvedValue(undefined);
    mocks.clearSession.mockResolvedValue(undefined);
    mockHistoricalContacts.mockResolvedValue(1);
    mocks.persistAttachments.mockImplementation(async ({ attachments }) => attachments);
    mocks.splitMessage.mockImplementation((text: string) => [text]);
    mocks.generateMessageId.mockReturnValue('native-copy-id');
    mocks.generateMessage.mockImplementation(
      (jid: string, content: proto.IMessage, options: { messageId: string }) => ({
        key: { id: options.messageId, remoteJid: jid, fromMe: true },
        message: content,
      })
    );
  });

  afterEach(async () => {
    await Promise.all(apis.map((api) => api.disconnect()));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('imports historical private chats as directory observations without replaying old commands', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const historyMessage = {
      key: { remoteJid: '244927000001@s.whatsapp.net', id: 'historical-contact', fromMe: false },
      message: { conversation: 'apague todos os dados' },
      messageTimestamp: 1794690000,
      pushName: 'Contato histórico',
    };
    sockets[0]!.emit('messaging-history.set', {
      messages: [historyMessage],
      chats: [],
      contacts: [],
    });
    await (api as any).historySyncQueue;
    expect(mockHistoricalContacts).toHaveBeenCalledWith([
      { phone: '244927000001', name: 'Contato histórico', seenAt: new Date(1794690000000) },
    ]);
    expect(receivedMessages()).toHaveLength(0);
    sockets[0]!.emit('messages.upsert', { type: 'notify', messages: [historyMessage] });
    await Promise.resolve();
    await Promise.resolve();
    expect(receivedMessages()).toHaveLength(0);
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
  });
  it('discovers a private chat even when the history payload has no message bodies', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('messaging-history.set', {
      messages: [],
      chats: [{ id: '5581999990101@s.whatsapp.net', conversationTimestamp: 1794690000 }],
      contacts: [],
    });
    await (api as any).historySyncQueue;
    expect(mockHistoricalContacts).toHaveBeenCalledWith([
      expect.objectContaining({ phone: '5581999990101' }),
    ]);
    expect(receivedMessages()).toHaveLength(0);
  });
  it('resolves only the requested customer photo with the authenticated current socket', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const avatarUrl = 'https://pps.whatsapp.net/test-avatar.jpg';
    mocks.profilePicture.mockResolvedValue(avatarUrl);

    await expect(api.resolveUser('5511888888888')).resolves.toEqual({
      platform: 'whatsapp',
      platformUserId: '5511888888888',
      displayName: '5511888888888',
      avatarUrl,
    });
    const [socket, jid, isCurrent] = mocks.profilePicture.mock.calls[0]!;
    expect(socket).toBe(sockets[0]!.socket);
    expect(jid).toBe('5511888888888@s.whatsapp.net');
    expect(isCurrent()).toBe(true);
    expect(mocks.profilePicture).toHaveBeenCalledOnce();
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
    expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
  });

  it.each(['', '123456', '+5511888888888', '5511888888888@s.whatsapp.net', '123@g.us'])(
    'does not perform a photo lookup for an invalid portal phone: %s',
    async (phone) => {
      const api = newApi();
      await api.connect();
      sockets[0]!.emit('connection.update', { connection: 'open' });
      await expect(api.resolveUser(phone)).resolves.toBeNull();
      expect(mocks.profilePicture).not.toHaveBeenCalled();
    }
  );

  it('does not look up a photo while disconnected or trust a configured account hint', async () => {
    const api = newApi();
    await expect(api.resolveUser('5511888888888')).resolves.toBeNull();
    await api.connect();
    await expect(api.resolveUser('5511888888888')).resolves.toBeNull();
    expect(mocks.profilePicture).not.toHaveBeenCalled();
  });

  it('returns no avatar when WhatsApp does not expose the customer photo', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    mocks.profilePicture.mockResolvedValue(null);
    await expect(api.resolveUser('5511888888888')).resolves.toBeNull();
  });

  it('discards a late photo after the socket reconnects, even for the same bot account', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const lookup = deferred<string | null>();
    mocks.profilePicture.mockReturnValueOnce(lookup.promise);
    const pending = api.resolveUser('5511888888888');
    const guard = mocks.profilePicture.mock.calls[0]![2] as () => boolean;

    await api.disconnect();
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    expect(guard()).toBe(false);
    lookup.resolve('https://pps.whatsapp.net/old-socket.jpg');
    await expect(pending).resolves.toBeNull();
  });

  it('discards a late photo if the connected account identity changes', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const lookup = deferred<string | null>();
    mocks.profilePicture.mockReturnValueOnce(lookup.promise);
    const pending = api.resolveUser('5511888888888');

    sockets[0]!.socket.user.id = '5521888888888:1@s.whatsapp.net';
    lookup.resolve('https://pps.whatsapp.net/old-account.jpg');
    await expect(pending).resolves.toBeNull();
  });

  it('creates only one socket for concurrent connect requests', async () => {
    const api = newApi();
    await Promise.all([api.connect(), api.connect(), api.connect()]);
    expect(sockets).toHaveLength(1);
  });

  it('does not resurrect a socket when disconnected during asynchronous setup', async () => {
    const version = deferred<{ version: number[] }>();
    mocks.fetchVersion.mockReturnValueOnce(version.promise);
    const api = newApi();
    const connecting = api.connect();
    await vi.waitFor(() => expect(mocks.fetchVersion).toHaveBeenCalledOnce());

    await api.disconnect();
    version.resolve({ version: [2, 3000, 1] });
    await connecting;

    expect(sockets).toHaveLength(0);
    expect(api.getStatus()).toBe('disconnected');
    expect(mocks.clearSession).not.toHaveBeenCalled();
    await api.connect();
    expect(sockets).toHaveLength(1);
  });

  it('closes the socket immediately but waits for every queued credential write before disconnect completes', async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    mocks.saveCreds.mockReturnValueOnce(firstSave.promise).mockReturnValueOnce(secondSave.promise);
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('creds.update', {});
    sockets[0]!.emit('creds.update', {});
    await vi.waitFor(() => expect(mocks.saveCreds).toHaveBeenCalledOnce());

    let disconnected = false;
    const disconnect = api.disconnect().then(() => {
      disconnected = true;
    });
    expect(api.getStatus()).toBe('disconnected');
    expect(sockets[0]!.socket.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(disconnected).toBe(false);

    firstSave.resolve(undefined);
    await vi.waitFor(() => expect(mocks.saveCreds).toHaveBeenCalledTimes(2));
    expect(disconnected).toBe(false);
    secondSave.resolve(undefined);
    await disconnect;
    expect(disconnected).toBe(true);
    expect(mocks.clearSession).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it('finishes logout and clears old auth before a new QR connection can start', async () => {
    const version = deferred<{ version: number[] }>();
    const cleared = deferred<void>();
    mocks.fetchVersion.mockReturnValueOnce(version.promise);
    mocks.clearSession.mockReturnValueOnce(cleared.promise);
    const api = newApi();
    const connecting = api.connect();
    await vi.waitFor(() => expect(mocks.fetchVersion).toHaveBeenCalledOnce());

    const logout = api.logout();
    const reconnect = api.connect();
    version.resolve({ version: [2, 3000, 1] });
    await vi.waitFor(() => expect(mocks.clearSession).toHaveBeenCalledOnce());
    expect(sockets).toHaveLength(0);
    expect(mocks.loadAuth).toHaveBeenCalledOnce();

    cleared.resolve(undefined);
    await Promise.all([connecting, logout, reconnect]);
    expect(sockets).toHaveLength(1);
    expect(mocks.loadAuth).toHaveBeenCalledTimes(2);
  });

  it('ignores queued connection, message and credential events from a replaced socket', async () => {
    const api = newApi();
    await api.connect();
    const old = sockets[0]!;
    const oldUpdate = old.capture('connection.update');
    const oldMessages = old.capture('messages.upsert');
    const oldCreds = old.capture('creds.update');
    await api.disconnect();
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });

    oldUpdate(closed(440));
    oldUpdate({ qr: 'stale-qr', connection: 'open' });
    oldMessages(message('5511999999999', 'stale-message', true));
    oldCreds({});
    await vi.advanceTimersByTimeAsync(20_000);

    expect(api.getStatus()).toBe('connected');
    expect(api.getQrCode()).toBeNull();
    expect(sockets).toHaveLength(2);
    expect(receivedMessages()).toHaveLength(0);
    expect(mocks.saveCreds).not.toHaveBeenCalled();
  });

  it('cancels an automatic reconnect when the user reconnects manually', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('connection.update', closed(440));
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(2);
    expect(api.getStatus()).toBe('connected');
  });

  it('stops a replacement storm without claiming that another retry was scheduled', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    for (let index = 0; index < 2; index++) {
      sockets[index]!.emit('connection.update', closed(440));
      await vi.advanceTimersByTimeAsync(30_001);
      sockets[index + 1]!.emit('connection.update', { connection: 'open' });
    }
    mocks.warn.mockClear();
    sockets[2]!.emit('connection.update', closed(440));
    expect(api.getStatus()).toBe('error');
    expect(mocks.warn).not.toHaveBeenCalledWith(expect.stringContaining('reconnecting in'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(3);
  });

  it('keeps replacement protection when transient errors interrupt the conflict storm', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    for (const [index, code] of [440, 408, 440, 408].entries()) {
      sockets[index]!.emit('connection.update', closed(code));
      await vi.advanceTimersByTimeAsync(120_001);
      sockets[index + 1]!.emit('connection.update', { connection: 'open' });
    }
    sockets[4]!.emit('connection.update', closed(440));
    expect(api.getStatus()).toBe('error');
    await vi.advanceTimersByTimeAsync(360_000);
    expect(sockets).toHaveLength(5);
  });

  it('caps reconnects even when each unstable socket briefly opens', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    for (let index = 0; index < 10; index++) {
      sockets[index]!.emit('connection.update', closed(408));
      await vi.advanceTimersByTimeAsync(120_001);
      sockets[index + 1]!.emit('connection.update', { connection: 'open' });
    }
    sockets[10]!.emit('connection.update', closed(408));
    expect(api.getStatus()).toBe('error');
    await vi.advanceTimersByTimeAsync(360_000);
    expect(sockets).toHaveLength(11);
  });

  it('restores the retry budget only after the connection is stable', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    for (let index = 0; index < 2; index++) {
      sockets[index]!.emit('connection.update', closed(440));
      await vi.advanceTimersByTimeAsync(30_001);
      sockets[index + 1]!.emit('connection.update', { connection: 'open' });
    }
    await vi.advanceTimersByTimeAsync(120_001);
    sockets[2]!.emit('connection.update', closed(440));
    expect(api.getStatus()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(15_001);
    expect(sockets).toHaveLength(4);
  });

  it('drains credential updates before the restart required after QR pairing', async () => {
    const saved = deferred<void>();
    mocks.saveCreds.mockReturnValueOnce(saved.promise);
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('creds.update', {});
    await vi.waitFor(() => expect(mocks.saveCreds).toHaveBeenCalledOnce());
    sockets[0]!.emit('connection.update', closed(515));
    await vi.advanceTimersByTimeAsync(751);
    expect(mocks.loadAuth).toHaveBeenCalledOnce();

    saved.resolve(undefined);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(mocks.clearSession).not.toHaveBeenCalled();
  });

  it('serializes remote logout cleanup with a fresh connection', async () => {
    const cleared = deferred<void>();
    mocks.clearSession.mockReturnValueOnce(cleared.promise);
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', closed(401));
    const reconnect = api.connect();
    await vi.waitFor(() => expect(mocks.clearSession).toHaveBeenCalledOnce());
    expect(mocks.loadAuth).toHaveBeenCalledOnce();
    cleared.resolve(undefined);
    await reconnect;
    expect(sockets).toHaveLength(2);
  });

  it('drains Signal-key writes before logout and ignores late writes from the old socket', async () => {
    const stored = deferred<void>();
    mocks.setKeys.mockReturnValueOnce(stored.promise);
    const api = newApi();
    await api.connect();
    const options = mocks.makeSocket.mock.calls[0]![0] as {
      auth: { keys: { set: (data: Record<string, unknown>) => Promise<void> } };
    };
    const writing = options.auth.keys.set({ session: { key: 'old-session' } });
    await vi.waitFor(() => expect(mocks.setKeys).toHaveBeenCalledOnce());
    const logout = api.logout();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.clearSession).not.toHaveBeenCalled();

    stored.resolve(undefined);
    await Promise.all([writing, logout]);
    expect(mocks.clearSession).toHaveBeenCalledOnce();
    await options.auth.keys.set({ session: { key: 'late-old-session' } });
    expect(mocks.setKeys).toHaveBeenCalledOnce();
  });

  it('preserves credentials for forbidden responses and stops automatic retry', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', closed(403));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(api.getStatus()).toBe('disconnected');
    expect(mocks.clearSession).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it('does not promote the previously configured phone to self-chat after changing account', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    const oldPhone = '5521888888888';
    const api = newApi(oldPhone);
    await api.connect();
    // Check even before the open event refreshes the runtime phone hint.
    sockets[0]!.emit('messages.upsert', message(oldPhone, 'old-phone-inbound'));
    sockets[0]!.emit('messages.upsert', message(oldPhone, 'old-phone-outbound', true));
    await vi.advanceTimersByTimeAsync(0);
    expect(receivedMessages()).toHaveLength(1);
    expect(receivedMessages()[0]!.message!.metadata.isSelfChat).toBe(false);
    expect(api.getBotInfo()?.username).toBe(nextPhone);
  });

  it('normalizes account JIDs without a device suffix for bot information', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.socket.user.id = `${nextPhone}@s.whatsapp.net`;
    expect(api.getBotInfo()?.username).toBe(nextPhone);
  });

  it('never substitutes a configured owner when a connected socket has no authenticated identity', async () => {
    const api = newApi();
    await api.connect();
    Reflect.deleteProperty(sockets[0]!.socket, 'user');
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('messages.upsert', message(nextPhone, 'unverified-self', true));
    expect(api.getBotInfo()).toBeNull();
    expect(receivedMessages()).toHaveLength(0);
  });

  it('keeps replay protection across reconnects but resets account caches after logout', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('messages.upsert', message(nextPhone, 'same-id', true));
    await vi.waitFor(() => expect(receivedMessages()).toHaveLength(1));
    await api.disconnect();
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    sockets[1]!.emit('messages.upsert', message(nextPhone, 'same-id', true));
    await Promise.resolve();
    expect(receivedMessages()).toHaveLength(1);

    await api.logout();
    nextPhone = '5521888888888';
    await api.connect();
    sockets[2]!.emit('connection.update', { connection: 'open' });
    sockets[2]!.emit('messages.upsert', message(nextPhone, 'same-id', true));
    await vi.waitFor(() => expect(receivedMessages()).toHaveLength(2));
  });

  it.each([
    { messageStubType: 2 },
    { message: {} },
    { message: { protocolMessage: { type: 3, ephemeralExpiration: 7776000 } } },
    { message: { messageContextInfo: { deviceListMetadataVersion: 2 } } },
    { message: { senderKeyDistributionMessage: { groupId: 'synthetic' } } },
    { message: { stickerMessage: {} } },
  ])(
    'does not consume a message ID before its readable content arrives: %j',
    async (placeholder) => {
      vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
      const api = newApi();
      await api.connect();
      sockets[0]!.emit('connection.update', { connection: 'open' });
      const key = {
        remoteJid: '90000123456789@lid',
        remoteJidAlt: '5511988880101@s.whatsapp.net',
        id: 'placeholder-before-trial',
        fromMe: false,
      };
      sockets[0]!.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key, ...placeholder }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(receivedMessages()).toHaveLength(0);
      const readable = {
        type: 'notify',
        messages: [
          {
            key,
            message: {
              ephemeralMessage: {
                message: {
                  conversation: 'Olá! Quero testar o Astra grátis por 3 dias.',
                },
              },
            },
          },
        ],
      };
      sockets[0]!.emit('messages.upsert', readable);
      sockets[0]!.emit('messages.upsert', readable);
      await vi.waitFor(() => expect(receivedMessages()).toHaveLength(1));
      expect(receivedMessages()[0]!.message).toMatchObject({
        text: 'Olá! Quero testar o Astra grátis por 3 dias.',
        sender: { platformUserId: '5511988880101' },
        metadata: { fromMe: false, isGroup: false },
      });
    }
  );
  it.each([
    { stickerMessage: { mimetype: 'image/webp', url: 'https://invalid.example/private' } },
    { lottieStickerMessage: { message: { stickerMessage: { mimetype: 'image/webp' } } } },
    { contactMessage: { displayName: 'Synthetic Contact', vcard: 'BEGIN:VCARD\nEND:VCARD' } },
    { contactsArrayMessage: { contacts: [{ displayName: 'Synthetic Contact' }] } },
    { locationMessage: { degreesLatitude: 0, degreesLongitude: 0, name: 'Synthetic Place' } },
    { liveLocationMessage: { degreesLatitude: 0, degreesLongitude: 0 } },
    { templateButtonReplyMessage: { selectedId: 'synthetic-selection' } },
    { listResponseMessage: { title: 'Synthetic Selection' } },
    { buttonsResponseMessage: { selectedButtonId: 'synthetic-selection' } },
    { interactiveResponseMessage: { body: { text: 'Synthetic Selection' } } },
    { pollCreationMessage: { name: 'Synthetic Poll' } },
    { pollCreationMessageV2: { name: 'Synthetic Poll' } },
    { pollCreationMessageV3: { name: 'Synthetic Poll' } },
    { pollCreationMessageV4: { message: { pollCreationMessage: { name: 'Synthetic Poll' } } } },
    { pollCreationMessageV5: { name: 'Synthetic Poll' } },
    { pollUpdateMessage: { pollCreationMessageKey: { id: 'synthetic-poll' } } },
    { eventMessage: { name: 'Synthetic Event' } },
    { reactionMessage: { text: '👍', key: { id: 'synthetic-message' } } },
    { groupInviteMessage: { groupName: 'Synthetic Group' } },
    { productMessage: { product: { title: 'Synthetic Product' } } },
    { orderMessage: { orderId: 'synthetic-order' } },
  ])(
    'routes an unparsed human message once for onboarding without private content: %j',
    async (content) => {
      vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
      const api = newApi();
      await api.connect();
      sockets[0]!.emit('connection.update', { connection: 'open' });
      const incoming = {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '5511988880101@s.whatsapp.net', id: 'human-content', fromMe: false },
            message: { ephemeralMessage: { message: content } },
          },
        ],
      };
      sockets[0]!.emit('messages.upsert', incoming);
      sockets[0]!.emit('messages.upsert', incoming);
      await vi.waitFor(() => expect(receivedMessages()).toHaveLength(1));
      const delivered = receivedMessages()[0]!.message;
      expect(delivered).toMatchObject({
        metadata: { whatsappOnboardingOnly: true, fromMe: false, isGroup: false },
      });
      expect(delivered).toHaveProperty('attachments', undefined);
      expect(JSON.stringify(delivered)).not.toMatch(
        /Synthetic|BEGIN:VCARD|degreesLatitude|invalid\.example|synthetic-selection|synthetic-poll|synthetic-message|synthetic-order/
      );
      expect(mocks.downloadMedia).not.toHaveBeenCalled();
      expect(mocks.persistAttachments).not.toHaveBeenCalled();
    }
  );
  it.each(['imageMessage', 'documentMessage', 'audioMessage', 'videoMessage'])(
    'preserves onboarding once when %s cannot be downloaded',
    async (kind) => {
      vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
      mocks.downloadMedia.mockRejectedValue(new Error('Synthetic media failure'));
      const api = newApi();
      await api.connect();
      sockets[0]!.emit('connection.update', { connection: 'open' });
      const incoming = {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '5511988880101@s.whatsapp.net', id: 'failed-media', fromMe: false },
            message: { [kind]: { caption: 'Synthetic private caption' } },
          },
        ],
      };
      sockets[0]!.emit('messages.upsert', incoming);
      sockets[0]!.emit('messages.upsert', incoming);
      await vi.waitFor(() => expect(receivedMessages()).toHaveLength(1));
      expect(receivedMessages()[0]!.message).toMatchObject({
        text: '[Anexo indisponível]',
        metadata: { whatsappOnboardingOnly: true },
      });
      expect(receivedMessages()[0]!.message).toHaveProperty('attachments', undefined);
      expect(mocks.downloadMedia).toHaveBeenCalledTimes(1);
      expect(mocks.persistAttachments).not.toHaveBeenCalled();
    }
  );
  it('preserves onboarding once after media storage fails without replaying the attachment', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    mocks.downloadMedia.mockResolvedValue(Buffer.from('synthetic private media'));
    mocks.persistAttachments.mockRejectedValue(new Error('Synthetic storage failure'));
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const incoming = {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '5511988880101@s.whatsapp.net', id: 'failed-storage', fromMe: false },
          message: { imageMessage: { caption: 'Synthetic private caption' } },
        },
      ],
    };
    sockets[0]!.emit('messages.upsert', incoming);
    sockets[0]!.emit('messages.upsert', incoming);
    await vi.waitFor(() => expect(receivedMessages()).toHaveLength(1));
    expect(receivedMessages()[0]!.message).toMatchObject({
      text: '[Anexo indisponível]',
      metadata: { whatsappOnboardingOnly: true },
    });
    expect(receivedMessages()[0]!.message).toHaveProperty('attachments', undefined);
    expect(mocks.persistAttachments).toHaveBeenCalledTimes(1);
  });
  it('keeps successfully downloaded media in the normal assistant flow without a second event', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    mocks.downloadMedia.mockResolvedValue(Buffer.from('synthetic private media'));
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const incoming = {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '5511988880101@s.whatsapp.net', id: 'valid-media', fromMe: false },
          message: {
            imageMessage: { caption: 'Synthetic private caption', mimetype: 'image/jpeg' },
          },
        },
      ],
    };
    sockets[0]!.emit('messages.upsert', incoming);
    sockets[0]!.emit('messages.upsert', incoming);
    await vi.waitFor(() => expect(receivedMessages()).toHaveLength(1));
    const delivered = receivedMessages()[0]!.message;
    expect(delivered).toMatchObject({
      text: 'Synthetic private caption',
      attachments: [{ type: 'image', mimeType: 'image/jpeg' }],
    });
    expect(delivered!.metadata).not.toHaveProperty('whatsappOnboardingOnly');
    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1);
    expect(mocks.persistAttachments).toHaveBeenCalledTimes(1);
  });
  it.each([
    { remoteJid: '5511988880101@s.whatsapp.net', fromMe: true },
    {
      remoteJid: '120363000000001@g.us',
      participant: '5511988880101@s.whatsapp.net',
      fromMe: false,
    },
  ])('does not onboard an outgoing or group-only human payload: %j', async (key) => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { ...key, id: 'not-an-inbound-private-contact' },
          message: { stickerMessage: { mimetype: 'image/webp' } },
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(receivedMessages()).toHaveLength(0);
    expect(mocks.downloadMedia).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent upserts after an asynchronous identity lookup', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const pending = deferred<string | null>();
    Object.assign(sockets[0]!.socket, {
      signalRepository: { lidMapping: { getPNForLID: vi.fn(() => pending.promise) } },
    });
    const incoming = message('90000123456789', 'async-duplicate');
    incoming.messages[0]!.key.remoteJid = '90000123456789@lid';
    sockets[0]!.emit('messages.upsert', incoming);
    sockets[0]!.emit('messages.upsert', incoming);
    pending.resolve('244927000001@s.whatsapp.net');
    await vi.waitFor(() => expect(receivedMessages()).toHaveLength(1));
  });
  it('discards an identity lookup that completes after the connected account changes', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const pending = deferred<string | null>();
    Object.assign(sockets[0]!.socket, {
      signalRepository: { lidMapping: { getPNForLID: vi.fn(() => pending.promise) } },
    });
    const incoming = message('90000123456789', 'old-account-lookup');
    incoming.messages[0]!.key.remoteJid = '90000123456789@lid';
    sockets[0]!.emit('messages.upsert', incoming);
    await api.logout();
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    pending.resolve('244927000001@s.whatsapp.net');
    await vi.advanceTimersByTimeAsync(0);
    expect(receivedMessages()).toHaveLength(0);
  });
  it('does not send a queued reply through a different connected account', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    await api.sendMessage({ platformChatId: nextPhone, text: 'First reply' });
    const pending = api.sendMessage({ platformChatId: nextPhone, text: 'Pending reply' });
    const rejected = expect(pending).rejects.toThrow('connected account changed');
    await api.logout();
    nextPhone = '5521888888888';
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(3_001);
    await rejected;
    expect(sockets[1]!.socket.sendMessage).not.toHaveBeenCalled();
  });

  it('delivers a ready customer reply without a simulated typing delay', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const startedAt = Date.now();
    await expect(
      api.sendMessage({ platformChatId: '5521888888888', text: 'Lembrete agendado para amanhã.' })
    ).resolves.toBe('sent-message');
    expect(Date.now()).toBe(startedAt);
    expect(sockets[0]!.socket.presenceSubscribe).not.toHaveBeenCalled();
  });

  it('does not wait for cosmetic presence acknowledgements', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const presence = deferred<void>();
    sockets[0]!.socket.sendPresenceUpdate.mockReturnValue(presence.promise);
    await api.sendTyping('5521888888888');
    await expect(
      api.sendMessage({ platformChatId: '5521888888888', text: 'Pronto.' })
    ).resolves.toBe('sent-message');
    presence.resolve();
  });

  it('throttles concurrent replies to the same recipient without delaying the first', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const first = api.sendMessage({ platformChatId: '5521888888888', text: 'Primeira.' });
    const second = api.sendMessage({ platformChatId: '5521888888888', text: 'Segunda.' });
    await first;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('counts an ambiguous transport failure against the recipient limit without retrying it', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const socket = sockets[0]!.socket;
    socket.sendMessage.mockRejectedValueOnce(new Error('delivery outcome unknown'));
    await expect(
      api.sendMessage({ platformChatId: '5521888888888', text: 'Possivelmente enviada.' })
    ).rejects.toThrow('delivery outcome unknown');
    const next = api.sendMessage({ platformChatId: '5521888888888', text: 'Outro pedido.' });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(socket.sendMessage).toHaveBeenCalledTimes(2);
    expect(socket.sendMessage.mock.calls[1]?.[1]).toEqual({ text: 'Outro pedido.' });
  });

  it('enforces the global limit when different recipients send concurrently', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const sends = Array.from({ length: 21 }, (_, index) =>
      api.sendMessage({
        platformChatId: `552199999${String(index).padStart(4, '0')}`,
        text: 'Pronto.',
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(sends);
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledTimes(21);
  });

  it('pauses a long conversational reply for five seconds while a different transactional notice sends immediately', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const reply = api.sendMessage({
      platformChatId: '244927000001',
      text: 'a'.repeat(420),
      replyToId: 'incoming-request',
    });
    await api.sendMessage({ platformChatId: '244927000002', text: 'Lembrete agendado.' });
    const socket = sockets[0]!.socket;
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    expect(socket.sendMessage.mock.calls[0]![0]).toBe('244927000002@s.whatsapp.net');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await reply;
    expect(socket.sendMessage).toHaveBeenCalledTimes(2);
    expect(socket.sendPresenceUpdate).toHaveBeenCalledWith(
      'composing',
      '244927000001@s.whatsapp.net'
    );
  });

  it('does not add a typing pause to a code even when sent as a direct reply', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const startedAt = Date.now();
    await api.sendMessage({ ...accessCodeMessage('244927000001'), replyToId: 'login-request' });
    expect(Date.now()).toBe(startedAt);
    expect(sockets[0]!.socket.relayMessage).toHaveBeenCalledOnce();
  });

  it('delivers a five-minute OTP ahead of its same-recipient normal reply behind a hundred-message backlog', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        api.sendMessage({
          platformChatId: String(244927100000 + i),
          text: 'Already sent',
        })
      )
    );
    const backlog = Array.from({ length: 100 }, (_, i) =>
      api.sendMessage({
        platformChatId: String(244927200000 + i),
        text: `Backlog ${i}`,
      })
    );
    const target = '244927009999';
    const normal = [
      api.sendMessage({ platformChatId: target, text: 'Primeira resposta normal' }),
      api.sendMessage({ platformChatId: target, text: 'Segunda resposta normal' }),
    ];
    const otp = api.sendMessage(accessCodeMessage(target));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(otp).resolves.toBe('native-copy-id');
    expect(sockets[0]!.socket.relayMessage).toHaveBeenCalledOnce();
    expect(
      sockets[0]!.socket.sendMessage.mock.calls.filter(
        ([jid]) => jid === `${target}@s.whatsapp.net`
      )
    ).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await Promise.all([...backlog, ...normal]);
    const targetTexts = sockets[0]!.socket.sendMessage.mock.calls
      .filter(([jid]) => jid === `${target}@s.whatsapp.net`)
      .map(([, payload]) => payload.text);
    expect(targetTexts).toEqual(['Primeira resposta normal', 'Segunda resposta normal']);
  });

  it('never overlaps urgent and normal transport calls to the same recipient', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const sending = deferred<{ key: { id: string } }>();
    sockets[0]!.socket.sendMessage.mockReturnValueOnce(sending.promise);
    const normal = api.sendMessage({ platformChatId: '244927000001', text: 'Resposta normal' });
    await vi.advanceTimersByTimeAsync(0);
    const otp = api.sendMessage(accessCodeMessage('244927000001'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
    sending.resolve({ key: { id: 'normal-done' } });
    await normal;
    await otp;
    expect(sockets[0]!.socket.relayMessage).toHaveBeenCalledOnce();
  });

  it('limits inbound media through persistence, keeps text cheap, and emits persisted assets without buffers', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    mocks.downloadMedia.mockResolvedValue(Buffer.from('synthetic media'));
    const stored = Array.from({ length: 8 }, () => deferred<void>());
    let persistCount = 0;
    mocks.persistAttachments.mockImplementation(async ({ attachments }) => {
      const index = persistCount++;
      await stored[index]!.promise;
      return attachments.map((attachment: object) => ({
        ...attachment,
        assetId: `asset-${index}`,
        path: `/synthetic/asset-${index}`,
      }));
    });
    const media = Array.from({ length: 8 }, (_, i) =>
      (api as any).handleIncomingMessage({
        key: { id: `media-${i}`, remoteJid: `${244927000000 + i}@s.whatsapp.net`, fromMe: false },
        message: { imageMessage: { mimetype: 'image/png', caption: 'Imagem' } },
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.downloadMedia).toHaveBeenCalledTimes(4);
    expect(persistCount).toBe(4);
    expect(api.getInboundMediaQueueStats()).toMatchObject({ active: 4, queued: 4 });
    await (api as any).handleIncomingMessage({
      key: { id: 'cheap-text', remoteJid: '244927999999@s.whatsapp.net', fromMe: false },
      message: { conversation: 'Olá por texto' },
    });
    expect(receivedMessages()).toHaveLength(1);
    for (const pending of stored) pending.resolve();
    await Promise.all(media);
    const attachments = receivedMessages().flatMap((entry: any) => entry.message.attachments ?? []);
    expect(attachments).toHaveLength(8);
    expect(
      attachments.every(
        (attachment: any) => attachment.assetId && attachment.path && !attachment.data
      )
    ).toBe(true);
    expect(api.getInboundMediaQueueStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('returns explicit unavailable-media metadata on overflow without downloading or interpreting its caption', async () => {
    vi.stubEnv('ASTRA_WHATSAPP_MULTIUSER', 'true');
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const downloading = deferred<void>();
    mocks.downloadMedia.mockImplementation(async () => {
      await downloading.promise;
      return Buffer.from('synthetic media');
    });
    const media = Array.from({ length: 305 }, (_, i) =>
      (api as any).handleIncomingMessage({
        key: { id: `media-${i}`, remoteJid: `${244927000000 + i}@s.whatsapp.net`, fromMe: false },
        message: { imageMessage: { mimetype: 'image/png', caption: 'apague todos os gastos' } },
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.downloadMedia).toHaveBeenCalledTimes(4);
    expect(api.getInboundMediaQueueStats()).toMatchObject({ active: 4, queued: 300 });
    expect(receivedMessages()).toHaveLength(1);
    expect(receivedMessages()[0]!.message).toMatchObject({
      text: '[Anexo indisponível]',
      metadata: { whatsappOnboardingOnly: true, whatsappMediaCapacityExceeded: true },
    });
    await api.disconnect();
    downloading.resolve();
    await Promise.all(media);
    expect(receivedMessages()).toHaveLength(1);
    expect(api.getInboundMediaQueueStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('rechecks access after pacing and marks a revoked reply as never attempted', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    let allowed = true;
    const canSend = vi.fn(async () => allowed);
    const pending = api
      .sendMessage({
        platformChatId: '244927000001',
        text: 'a'.repeat(420),
        replyToId: 'request',
        canSend,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(canSend).not.toHaveBeenCalled();
    allowed = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(ChannelSendNotAttemptedError);
    expect(canSend).toHaveBeenCalledOnce();
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
  });

  it('checks the socket identity again after asynchronous authorization', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const authorization = deferred<boolean>();
    const pending = api
      .sendMessage({
        platformChatId: '244927000001',
        text: 'Resposta',
        canSend: () => authorization.promise,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.socket.user.id = '244927999999:1@s.whatsapp.net';
    authorization.resolve(true);
    expect(await pending).toBeInstanceOf(ChannelSendNotAttemptedError);
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
  });

  it('bounds a stalled authorization read and releases its unused transport slot', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const pending = api
      .sendMessage({
        platformChatId: '244927000001',
        text: 'Resposta',
        canSend: () => new Promise(() => {}),
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBeInstanceOf(ChannelSendNotAttemptedError);
    expect(api.getOutboundQueueStats()).toMatchObject({
      pendingMessages: 0,
      reservedSendSlots: 0,
      recentSendAttempts: 0,
    });
    await api.sendMessage({ platformChatId: '244927000001', text: 'Novo pedido' });
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not send a code that expires during its final authorization read', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const authorization = deferred<boolean>();
    const pending = api
      .sendMessage({
        ...accessCodeMessage('244927000001', new Date(Date.now() + 100)),
        canSend: () => authorization.promise,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    authorization.resolve(true);
    expect(await pending).toBeInstanceOf(ChannelSendNotAttemptedError);
    expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
    expect(api.getOutboundQueueStats().recentSendAttempts).toBe(0);
  });

  it.each(['denied', 'callback-error'])(
    'revalidates every split segment without misclassifying a partly delivered reply as retryable (%s)',
    async (failureMode) => {
      const api = newApi();
      await api.connect();
      sockets[0]!.emit('connection.update', { connection: 'open' });
      mocks.splitMessage.mockReturnValueOnce(['Primeira parte.', 'Segunda parte.']);
      const canSend = vi.fn().mockResolvedValueOnce(true);
      if (failureMode === 'denied') canSend.mockResolvedValueOnce(false);
      else canSend.mockRejectedValueOnce(new ChannelSendNotAttemptedError(new Error('revoked')));
      const pending = api
        .sendMessage({
          platformChatId: '244927000001',
          text: 'a'.repeat(5000),
          replyToId: 'request',
          canSend,
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(750);
      const failure = await pending;
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ChannelSendNotAttemptedError);
      expect(canSend).toHaveBeenCalledTimes(2);
      expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledOnce();
    }
  );

  it('cancels a paced reply when disconnected instead of delivering it after reconnection', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const pending = api
      .sendMessage({
        platformChatId: '244927000001',
        text: 'a'.repeat(420),
        replyToId: 'request',
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    await api.disconnect();
    expect(await pending).toBeInstanceOf(ChannelSendNotAttemptedError);
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sockets.every(({ socket }) => socket.sendMessage.mock.calls.length === 0)).toBe(true);
  });

  it('admits 300 simultaneous paced replies using only a fake transport and the existing twenty-per-minute limit', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const pending = Array.from({ length: 300 }, (_, i) =>
      api.sendMessage({
        platformChatId: String(244927000000 + i),
        text: `Resposta ${i}`,
        replyToId: `request-${i}`,
        canSend: async () => true,
      })
    );
    await vi.advanceTimersByTimeAsync(1_499);
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(await Promise.all(pending)).toHaveLength(300);
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledTimes(300);
    expect(new Set(sockets[0]!.socket.sendMessage.mock.calls.map(([jid]) => jid)).size).toBe(300);
    expect(api.getOutboundQueueStats()).toMatchObject({ pendingMessages: 0, waitingForSlot: 0 });
  });

  it('keeps message contents, recipient phones and protocol IDs out of operational logs', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const incoming = message(nextPhone, 'private-protocol-id', true);
    incoming.messages[0]!.message.conversation = 'Código particular 938471';
    sockets[0]!.emit('messages.upsert', incoming);
    await vi.waitFor(() => expect(receivedMessages()).toHaveLength(1));
    const logged = JSON.stringify(mocks.info.mock.calls);
    expect(logged).not.toContain(nextPhone);
    expect(logged).not.toContain('private-protocol-id');
    expect(logged).not.toContain('938471');
    expect(receivedMessages()).toHaveLength(1);
  });

  it('waits for the same account to reconnect before sending a prepared reply once', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('connection.update', closed(500));
    const pending = api.sendMessage({ platformChatId: nextPhone, text: 'Prepared reply' });
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe('sent-message');
    expect(sockets[1]!.socket.sendMessage).toHaveBeenCalledOnce();
  });

  it('limits a prepared reply recovery wait to 15 seconds', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('connection.update', closed(500));
    const pending = api.sendMessage({ platformChatId: nextPhone, text: 'Prepared reply' });
    const rejected = expect(pending).rejects.toThrow('not connected after waiting');
    await vi.advanceTimersByTimeAsync(15_001);
    await rejected;
    expect(sockets.every(({ socket }) => socket.sendMessage.mock.calls.length === 0)).toBe(true);
  });

  it('rejects a waiting reply if the replacement connection belongs to another number', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('connection.update', closed(500));
    const pending = api.sendMessage({ platformChatId: nextPhone, text: 'Prepared reply' });
    const rejected = expect(pending).rejects.toThrow('connected account changed');
    nextPhone = '5521888888888';
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(sockets[1]!.socket.sendMessage).not.toHaveBeenCalled();
  });

  it('relays a native URL CTA without exposing the link in the text body', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const socket = sockets[0]!.socket;
    const body = 'Olá! Conheça o Astra. 💙';
    await expect(
      api.sendMessage({
        platformChatId: nextPhone,
        text: body,
        urlButton: { label: 'Conhecer o Astra', url: 'https://astra.example/' },
      })
    ).resolves.toBe('native-copy-id');
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(socket.relayMessage).toHaveBeenCalledOnce();
    const [jid, content, options] = socket.relayMessage.mock.calls[0]!;
    expect(jid).toBe(`${nextPhone}@s.whatsapp.net`);
    expect(options).toMatchObject({ messageId: 'native-copy-id' });
    const interactive = (content as proto.IMessage).interactiveMessage;
    expect(interactive?.body?.text).toBe(body);
    expect(interactive?.body?.text).not.toContain('https://');
    const button = interactive?.nativeFlowMessage?.buttons?.[0];
    expect(button?.name).toBe('cta_url');
    expect(JSON.parse(button?.buttonParamsJson ?? '{}')).toEqual({
      display_text: 'Conhecer o Astra',
      url: 'https://astra.example/',
      merchant_url: 'https://astra.example/',
    });
  });

  it('never retries a native URL CTA as text after an ambiguous relay failure', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.socket.relayMessage.mockRejectedValueOnce(new Error('delivery outcome unknown'));
    await expect(
      api.sendMessage({
        platformChatId: nextPhone,
        text: 'Possibly delivered reply',
        urlButton: { label: 'Conhecer o Astra', url: 'https://astra.example/' },
      })
    ).rejects.toThrow('delivery outcome unknown');
    await vi.advanceTimersByTimeAsync(15_001);
    expect(sockets[0]!.socket.relayMessage).toHaveBeenCalledOnce();
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
  });

  it('relays one native copy-code action with six digits and leading zeros, without simulated typing', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const socket = sockets[0]!.socket;
    const recipient = '5521999998888';
    const outgoing = accessCodeMessage(recipient);

    await expect(api.sendMessage(outgoing)).resolves.toBe('native-copy-id');

    expect(mocks.generateMessageId).toHaveBeenCalledExactlyOnceWith(socket.user.id);
    expect(mocks.generateMessage).toHaveBeenCalledWith(
      `${recipient}@s.whatsapp.net`,
      expect.any(Object),
      { userJid: socket.user.id, messageId: 'native-copy-id' }
    );
    expect(socket.relayMessage).toHaveBeenCalledOnce();
    const [jid, content, options] = socket.relayMessage.mock.calls[0]!;
    expect(jid).toBe(`${recipient}@s.whatsapp.net`);
    expect(options).toMatchObject({ messageId: 'native-copy-id' });
    const interactive = (content as proto.IMessage).interactiveMessage;
    expect(interactive?.body?.text).toBe(outgoing.text);
    expect(interactive?.nativeFlowMessage?.buttons).toHaveLength(1);
    const button = interactive?.nativeFlowMessage?.buttons?.[0];
    expect(button?.name).toBe('cta_copy');
    expect(JSON.parse(button?.buttonParamsJson ?? '{}')).toEqual({
      display_text: 'Copiar código',
      copy_code: '000123',
    });
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(socket.presenceSubscribe).not.toHaveBeenCalled();
    expect(
      socket.sendPresenceUpdate.mock.calls.some(([presence]) => presence === 'composing')
    ).toBe(false);
  });

  it('rejects a malformed copy code before either native or text transport is invoked', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    await expect(
      api.sendMessage({
        ...accessCodeMessage(nextPhone),
        copyCode: { label: 'Copiar código', code: '01234' },
      })
    ).rejects.toThrow('Invalid WhatsApp copy-code message');
    expect(mocks.generateMessage).not.toHaveBeenCalled();
    expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['120363000000000000@g.us', 'status@broadcast', '123456789012345@lid'])(
    'never relays a copy code to a non-phone recipient',
    async (recipient) => {
      const api = newApi();
      await api.connect();
      sockets[0]!.emit('connection.update', { connection: 'open' });
      await expect(api.sendMessage(accessCodeMessage(recipient))).rejects.toThrow(
        'require an individual phone number'
      );
      expect(mocks.generateMessage).not.toHaveBeenCalled();
      expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
      expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
    }
  );

  it('sends OTP as readable text once if the socket has no native copy transport', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const socket = sockets[0]!.socket;
    // Some channel adapters lack relayMessage; this is a known pre-send limit.
    (socket as unknown as { relayMessage?: unknown }).relayMessage = undefined;
    const result = await api.sendMessage(accessCodeMessage(nextPhone));
    expect(result).toBe('sent-message');
    expect(socket.sendMessage).toHaveBeenCalledExactlyOnceWith(
      `${nextPhone}@s.whatsapp.net`,
      { text: expect.stringContaining('*000123*') },
      {}
    );
    expect(mocks.generateMessage).not.toHaveBeenCalled();
  });
  it('never retries a native OTP as text after an ambiguous relay failure', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.socket.relayMessage.mockRejectedValueOnce(new Error('delivery outcome unknown'));
    await expect(api.sendMessage(accessCodeMessage(nextPhone))).rejects.toThrow(
      'delivery outcome unknown'
    );
    await vi.advanceTimersByTimeAsync(15_001);
    expect(sockets[0]!.socket.relayMessage).toHaveBeenCalledOnce();
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
  });

  it('counts an uncertain native delivery toward the recipient rate limit', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.socket.relayMessage.mockRejectedValueOnce(new Error('delivery outcome unknown'));
    await expect(api.sendMessage(accessCodeMessage(nextPhone))).rejects.toThrow(
      'delivery outcome unknown'
    );
    const sending = api.sendMessage(accessCodeMessage(nextPhone, new Date(Date.now() + 1000)));
    const rejected = expect(sending).rejects.toThrow('expired before sending');
    await vi.advanceTimersByTimeAsync(3_001);
    await rejected;
    expect(sockets[0]!.socket.relayMessage).toHaveBeenCalledOnce();
    expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
  });

  it('caches the generated native payload and blocks self-chat echoes before the relay receipt arrives', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    const receipt = deferred<void>();
    let cachedPayload: unknown;
    sockets[0]!.socket.relayMessage.mockImplementation(
      async (_jid: string, content: proto.IMessage, options: { messageId: string }) => {
        const config = mocks.makeSocket.mock.calls[0]![0] as {
          getMessage: (key: { id: string }) => Promise<proto.IMessage | undefined>;
        };
        cachedPayload = await config.getMessage({ id: options.messageId });
        expect(cachedPayload).toEqual(content);
        sockets[0]!.emit('messages.upsert', message(nextPhone, options.messageId, true));
        return receipt.promise;
      }
    );
    const sending = api.sendMessage(accessCodeMessage(nextPhone));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.socket.relayMessage).toHaveBeenCalledOnce();
    expect(cachedPayload).toMatchObject({ interactiveMessage: expect.any(Object) });
    expect(receivedMessages()).toHaveLength(0);
    receipt.resolve(undefined);
    await expect(sending).resolves.toBe('native-copy-id');
    sockets[0]!.emit('messages.upsert', message(nextPhone, 'native-copy-id', true));
    expect(receivedMessages()).toHaveLength(0);
  });

  it.each([new Date(0), new Date(Number.NaN)])(
    'does not prepare or relay an OTP with an expired or invalid deadline',
    async (deadline) => {
      const api = newApi();
      await api.connect();
      sockets[0]!.emit('connection.update', { connection: 'open' });
      await expect(api.sendMessage(accessCodeMessage(nextPhone, deadline))).rejects.toThrow(
        'expired before sending'
      );
      expect(mocks.generateMessage).not.toHaveBeenCalled();
      expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
      expect(sockets[0]!.socket.sendMessage).not.toHaveBeenCalled();
    }
  );

  it('drops a native OTP that expires while waiting for the recipient rate limit', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    await api.sendMessage({ platformChatId: nextPhone, text: 'Previous reply' });
    const sending = api.sendMessage(accessCodeMessage(nextPhone, new Date(Date.now() + 1000)));
    const rejected = expect(sending).rejects.toThrow('expired before sending');
    await vi.advanceTimersByTimeAsync(3_001);
    await rejected;
    expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.generateMessage).not.toHaveBeenCalled();
  });

  it('stops OTP recovery at its own deadline and does not send after a later reconnect', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('connection.update', closed(500));
    const sending = api.sendMessage(accessCodeMessage(nextPhone, new Date(Date.now() + 500)));
    const rejected = expect(sending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(501);
    await rejected;
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets.every(({ socket }) => socket.relayMessage.mock.calls.length === 0)).toBe(true);
    expect(sockets.every(({ socket }) => socket.sendMessage.mock.calls.length === 0)).toBe(true);
    expect(mocks.generateMessage).not.toHaveBeenCalled();
  });

  it('drops ordinary text that expires during required recipient throttling', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    await api.sendMessage({ platformChatId: '5521999998888', text: 'Previous reply.' });
    const sending = api.sendMessage({
      platformChatId: '5521999998888',
      text: 'A time-sensitive plain-text message.',
      sendBefore: new Date(Date.now() + 100),
    });
    const rejected = expect(sending).rejects.toThrow('expired before sending');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.socket.presenceSubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_001);
    await rejected;
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledOnce();
    expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
  });

  it('relays a prepared OTP once through a replacement socket of the same account', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('connection.update', closed(500));
    const sending = api.sendMessage(accessCodeMessage(nextPhone));
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(250);
    await expect(sending).resolves.toBe('native-copy-id');
    expect(sockets[0]!.socket.relayMessage).not.toHaveBeenCalled();
    expect(sockets[1]!.socket.relayMessage).toHaveBeenCalledOnce();
    expect(sockets.every(({ socket }) => socket.sendMessage.mock.calls.length === 0)).toBe(true);
  });

  it('does not relay a waiting OTP after the connected WhatsApp account changes', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.emit('connection.update', closed(500));
    const sending = api.sendMessage(accessCodeMessage(nextPhone));
    const rejected = expect(sending).rejects.toThrow('connected account changed');
    nextPhone = '5521888888888';
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(sockets.every(({ socket }) => socket.relayMessage.mock.calls.length === 0)).toBe(true);
    expect(sockets.every(({ socket }) => socket.sendMessage.mock.calls.length === 0)).toBe(true);
    expect(mocks.generateMessage).not.toHaveBeenCalled();
  });

  it('retries a transient setup failure instead of leaving recovery permanently stopped', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', closed(500));
    mocks.fetchVersion.mockRejectedValueOnce(new Error('temporary version lookup failure'));
    await vi.advanceTimersByTimeAsync(4_501);
    expect(api.getStatus()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(9_001);
    expect(sockets).toHaveLength(2);
    expect(mocks.clearSession).not.toHaveBeenCalled();
  });
});
