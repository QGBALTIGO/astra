import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WASocket } from '@whiskeysockets/baileys';

const mocks = vi.hoisted(() => ({
  makeSocket: vi.fn(),
  loadAuth: vi.fn(),
  fetchVersion: vi.fn(),
  cacheKeys: vi.fn(),
  setKeys: vi.fn(),
  saveCreds: vi.fn(),
  clearSession: vi.fn(),
  emit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: mocks.makeSocket,
  useMultiFileAuthState: mocks.loadAuth,
  makeCacheableSignalKeyStore: mocks.cacheKeys,
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  fetchLatestBaileysVersion: mocks.fetchVersion,
  downloadMediaMessage: vi.fn(),
  Browsers: { appropriate: vi.fn() },
  proto: { HistorySync: { HistorySyncType: {} } },
}));
vi.mock('pino', () => ({ default: vi.fn(() => ({})) }));
vi.mock('../../../services/log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../config/defaults.js', () => ({ MAX_MESSAGE_CHAT_MAP_SIZE: 1000 }));
vi.mock('../../utils/message-utils.js', () => ({ splitMessage: (text: string) => [text] }));
vi.mock('./session-store.js', () => ({
  getSessionDir: () => '/test/whatsapp-session',
  clearSession: mocks.clearSession,
}));
vi.mock('../../../ws/server.js', () => ({ wsGateway: { broadcast: vi.fn() } }));
vi.mock('../../../services/channel-asset-store.js', () => ({ channelAssetStore: {} }));
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

import { WhatsAppChannelAPI } from './whatsapp-api.js';

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
  });

  afterEach(async () => {
    await Promise.all(apis.map((api) => api.disconnect()));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
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
      await vi.advanceTimersByTimeAsync(15_001);
      sockets[index + 1]!.emit('connection.update', { connection: 'open' });
    }
    mocks.warn.mockClear();
    sockets[2]!.emit('connection.update', closed(440));
    expect(api.getStatus()).toBe('error');
    expect(mocks.warn).not.toHaveBeenCalledWith(expect.stringContaining('reconnecting in'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(3);
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
    await api.disconnect();
    await api.connect();
    sockets[1]!.emit('connection.update', { connection: 'open' });
    sockets[1]!.emit('messages.upsert', message(nextPhone, 'same-id', true));
    expect(receivedMessages()).toHaveLength(1);

    await api.logout();
    nextPhone = '5521888888888';
    await api.connect();
    sockets[2]!.emit('connection.update', { connection: 'open' });
    sockets[2]!.emit('messages.upsert', message(nextPhone, 'same-id', true));
    expect(receivedMessages()).toHaveLength(2);
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

  it('never retries an ambiguous network failure after sendMessage has been invoked', async () => {
    const api = newApi();
    await api.connect();
    sockets[0]!.emit('connection.update', { connection: 'open' });
    sockets[0]!.socket.sendMessage.mockRejectedValueOnce(new Error('delivery outcome unknown'));
    await expect(
      api.sendMessage({ platformChatId: nextPhone, text: 'Possibly delivered reply' })
    ).rejects.toThrow('delivery outcome unknown');
    await vi.advanceTimersByTimeAsync(15_001);
    expect(sockets[0]!.socket.sendMessage).toHaveBeenCalledOnce();
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
