import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerSessionContext } from './customer-identity.js';

vi.mock('@ownpilot/core/channels', () => ({ getChannelService: vi.fn() }));
vi.mock('./customer-identity.js', () => ({ getCustomerIdentityService: () => ({}) }));
vi.mock('../utils/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
import { CustomerAvatarService, CUSTOMER_AVATAR_MAX_BYTES } from './customer-avatar.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const avatarUrl = 'https://pps.whatsapp.net/synthetic-avatar?token=synthetic-secret';
const botPhone = '5511999991111';

function customer(overrides: Partial<CustomerSessionContext> = {}): CustomerSessionContext {
  return {
    accountId: 'customer-a',
    dataUserId: 'whatsapp:5567999998888',
    phoneNumber: '5567999998888',
    displayName: 'Ana',
    timeZone: 'America/Campo_Grande',
    currency: 'BRL',
    theme: 'system',
    hideAmounts: false,
    access: { status: 'active', expiresAt: null, canWrite: true },
    ...overrides,
  };
}
function imageResponse(bytes: Uint8Array = png, contentType = 'image/png') {
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': contentType } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const own = customer();
  const contexts = new Map<string, CustomerSessionContext>([[own.accountId, own]]);
  const api = {
    getStatus: vi.fn().mockReturnValue('connected'),
    getPlatform: vi.fn().mockReturnValue('whatsapp'),
    getBotInfo: vi.fn().mockReturnValue({ username: botPhone }),
    resolveUser: vi.fn().mockImplementation(async (phone: string) => ({
      platformUserId: phone,
      platform: 'whatsapp',
      displayName: 'Synthetic',
      avatarUrl,
    })),
  };
  const channels = {
    listChannels: vi.fn().mockReturnValue([
      {
        pluginId: 'channel.whatsapp',
        platform: 'whatsapp',
        status: 'connected',
        name: 'Synthetic WhatsApp',
      },
    ]),
    getChannel: vi.fn().mockReturnValue(api),
  };
  const identity = {
    getContext: vi.fn().mockImplementation(async (id: string) => {
      const current = contexts.get(id);
      return current ? { customer: current } : null;
    }),
  };
  const fetch = vi.fn().mockImplementation(async () => imageResponse());
  const service = new CustomerAvatarService({ channels: () => channels, identity, fetch });
  return { service, own, api, channels, identity, fetch, contexts };
}

describe('CustomerAvatarService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    ['image/png', png],
    ['image/jpeg', jpeg],
    ['image/webp', webp],
  ] as const)(
    'returns only validated %s bytes through the safe downloader',
    async (type, bytes) => {
      const h = setup();
      h.fetch.mockImplementation(async () => imageResponse(bytes, type));
      expect(await h.service.getAvatar(h.own)).toEqual({ bytes, contentType: type });
      expect(h.api.resolveUser).toHaveBeenCalledExactlyOnceWith(h.own.phoneNumber);
      expect(h.fetch).toHaveBeenCalledExactlyOnceWith(
        avatarUrl,
        expect.objectContaining({
          maxRedirects: 0,
          redactUrl: true,
          timeoutMs: 5000,
          credentials: 'omit',
          signal: expect.any(AbortSignal),
          headers: { Accept: 'image/jpeg,image/png,image/webp' },
        })
      );
      expect(h.identity.getContext).toHaveBeenCalledWith(h.own.accountId);
    }
  );

  it('coalesces concurrent requests and caches an avatar for five minutes', async () => {
    const h = setup();
    const download = deferred<Response>();
    h.fetch.mockReturnValueOnce(download.promise);
    const first = h.service.getAvatar(h.own);
    const second = h.service.getAvatar(h.own);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.resolveUser).toHaveBeenCalledOnce();
    expect(h.fetch).toHaveBeenCalledOnce();
    download.resolve(imageResponse());
    expect(await first).toEqual(await second);
    expect(await h.service.getAvatar(h.own)).toEqual({ bytes: png, contentType: 'image/png' });
    expect(h.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300_001);
    await h.service.getAvatar(h.own);
    expect(h.api.resolveUser).toHaveBeenCalledTimes(2);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('briefly caches a missing or private photo without downloading anything', async () => {
    const h = setup();
    h.api.resolveUser.mockResolvedValue(null);
    expect(await h.service.getAvatar(h.own)).toBeNull();
    expect(await h.service.getAvatar(h.own)).toBeNull();
    expect(h.api.resolveUser).toHaveBeenCalledOnce();
    expect(h.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_001);
    await h.service.getAvatar(h.own);
    expect(h.api.resolveUser).toHaveBeenCalledTimes(2);
  });

  it.each(['offline', 'unknown bot', 'owner phone', 'owner scope'])(
    'does not look up a picture for %s',
    async (reason) => {
      const h = setup();
      let own = h.own;
      if (reason === 'offline') h.api.getStatus.mockReturnValue('disconnected');
      if (reason === 'unknown bot') h.api.getBotInfo.mockReturnValue(null);
      if (reason === 'owner phone') own = customer({ phoneNumber: botPhone });
      if (reason === 'owner scope') own = customer({ dataUserId: 'default' });
      expect(await h.service.getAvatar(own)).toBeNull();
      expect(h.api.resolveUser).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    }
  );

  it('does not serve a cached photo while the provider is disconnected', async () => {
    const h = setup();
    expect(await h.service.getAvatar(h.own)).not.toBeNull();
    h.api.getStatus.mockReturnValue('disconnected');
    expect(await h.service.getAvatar(h.own)).toBeNull();
    expect(h.api.resolveUser).toHaveBeenCalledOnce();
  });

  it('permits an expired customer to read their own avatar', async () => {
    const h = setup();
    const expired = customer({
      access: { status: 'expired', canWrite: false, expiresAt: '2026-11-09T12:00:00Z' },
    });
    h.contexts.set(expired.accountId, expired);
    expect(await h.service.getAvatar(expired)).not.toBeNull();
  });

  it('does not reuse a cached picture across customers or connected WhatsApp accounts', async () => {
    const h = setup();
    const other = customer({
      accountId: 'customer-b',
      dataUserId: 'whatsapp:5521999997777',
      phoneNumber: '5521999997777',
    });
    h.contexts.set(other.accountId, other);
    await h.service.getAvatar(h.own);
    await h.service.getAvatar(other);
    expect(h.api.resolveUser.mock.calls.map(([phone]) => phone)).toEqual([
      h.own.phoneNumber,
      other.phoneNumber,
    ]);
    h.api.getBotInfo.mockReturnValue({ username: '5511999992222' });
    await h.service.getAvatar(h.own);
    expect(h.api.resolveUser).toHaveBeenCalledTimes(3);
  });

  it.each(['phone changed', 'scope changed', 'revoked', 'bot changed'])(
    'discards a completed download when %s during the request',
    async (change) => {
      const h = setup();
      const download = deferred<Response>();
      h.fetch.mockReturnValueOnce(download.promise);
      const pending = h.service.getAvatar(h.own);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fetch).toHaveBeenCalledOnce();
      if (change === 'phone changed')
        h.contexts.set(h.own.accountId, customer({ phoneNumber: '5521999997777' }));
      if (change === 'scope changed')
        h.contexts.set(h.own.accountId, customer({ dataUserId: 'default' }));
      if (change === 'revoked') h.contexts.delete(h.own.accountId);
      if (change === 'bot changed') h.api.getBotInfo.mockReturnValue({ username: '5511999992222' });
      download.resolve(imageResponse());
      expect(await pending).toBeNull();
    }
  );

  it('rechecks authorization before serving a cached avatar', async () => {
    const h = setup();
    await h.service.getAvatar(h.own);
    h.contexts.delete(h.own.accountId);
    expect(await h.service.getAvatar(h.own)).toBeNull();
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it('does not download a picture returned for another platform identity', async () => {
    const h = setup();
    h.api.resolveUser.mockResolvedValue({
      platform: 'whatsapp',
      platformUserId: '5521999997777',
      displayName: 'Other',
      avatarUrl,
    });
    expect(await h.service.getAvatar(h.own)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://pps.whatsapp.net/avatar',
    'https://127.0.0.1/avatar',
    'https://pps.whatsapp.net.attacker.example/avatar',
    'https://scontent.example.fbcdn.net/avatar',
    'https://user:secret@pps.whatsapp.net/avatar',
    'https://pps.whatsapp.net:8443/avatar',
    'https://pps.whatsapp.net/avatar#private',
    'data:image/png;base64,AAAA',
  ])('rejects an unsafe or unexpected provider URL before fetching', async (url) => {
    const h = setup();
    h.api.resolveUser.mockResolvedValue({
      platform: 'whatsapp',
      platformUserId: h.own.phoneNumber,
      displayName: 'Synthetic',
      avatarUrl: url,
    });
    expect(await h.service.getAvatar(h.own)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('never follows a redirect or returns an upstream redirect body', async () => {
    const h = setup();
    h.fetch.mockResolvedValueOnce(
      new Response('sensitive upstream text', {
        status: 302,
        headers: { Location: 'http://localhost/private' },
      })
    );
    expect(await h.service.getAvatar(h.own)).toBeNull();
    expect(h.fetch).toHaveBeenCalledExactlyOnceWith(
      avatarUrl,
      expect.objectContaining({
        maxRedirects: 0,
        redactUrl: true,
      })
    );
  });

  it.each([
    ['image/svg+xml', new TextEncoder().encode('<svg/>')],
    ['image/png', new TextEncoder().encode('<html>not an image</html>')],
    ['image/webp', png],
    ['text/html', png],
  ])('rejects a missing or mismatched raster signature', async (type, bytes) => {
    const h = setup();
    h.fetch.mockImplementation(async () => imageResponse(bytes as Uint8Array, type as string));
    expect(await h.service.getAvatar(h.own)).toBeNull();
  });

  it('rejects oversized Content-Length before reading the image', async () => {
    const h = setup();
    const response = imageResponse();
    response.headers.set('Content-Length', String(CUSTOMER_AVATAR_MAX_BYTES + 1));
    const read = vi.spyOn(response.body!, 'getReader');
    h.fetch.mockResolvedValueOnce(response);
    expect(await h.service.getAvatar(h.own)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('caps streamed bytes even when Content-Length is missing', async () => {
    const h = setup();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(CUSTOMER_AVATAR_MAX_BYTES);
        chunk.set(png);
        controller.enqueue(chunk);
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    h.fetch.mockResolvedValueOnce(
      new Response(stream, { headers: { 'Content-Type': 'image/png' } })
    );
    expect(await h.service.getAvatar(h.own)).toBeNull();
  });

  it('keeps the abort deadline active after headers while the body is stalled', async () => {
    const h = setup();
    let signal: AbortSignal | undefined;
    h.fetch.mockImplementation(async (_url: string, options?: RequestInit) => {
      signal = options?.signal ?? undefined;
      if (!signal) throw new Error('Missing test abort signal');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(png);
          signal!.addEventListener('abort', () => controller.error(new Error('aborted')), {
            once: true,
          });
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'image/png' } });
    });
    const pending = h.service.getAvatar(h.own);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('limits global in-flight picture lookups to four without queueing more work', async () => {
    const h = setup();
    const lookup = deferred<void>();
    h.api.resolveUser.mockImplementation(async (phone: string) => {
      await lookup.promise;
      return { platform: 'whatsapp', platformUserId: phone, displayName: 'Synthetic', avatarUrl };
    });
    const customers = Array.from({ length: 5 }, (_, index) =>
      customer({
        accountId: 'customer-' + index,
        phoneNumber: '556799999880' + index,
        dataUserId: 'whatsapp:556799999880' + index,
      })
    );
    customers.forEach((value) => h.contexts.set(value.accountId, value));
    const pending = customers.slice(0, 4).map((value) => h.service.getAvatar(value));
    expect(await h.service.getAvatar(customers[4]!)).toBeNull();
    expect(h.api.resolveUser).toHaveBeenCalledTimes(4);
    lookup.resolve(undefined);
    expect((await Promise.all(pending)).every(Boolean)).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });

  it('evicts the oldest entry after the sixty-four-image cache bound', async () => {
    const h = setup();
    const customers = Array.from({ length: 65 }, (_, index) =>
      customer({
        accountId: 'customer-' + index,
        phoneNumber: '556799999' + String(8000 + index),
        dataUserId: 'whatsapp:556799999' + String(8000 + index),
      })
    );
    for (const value of customers) {
      h.contexts.set(value.accountId, value);
      expect(await h.service.getAvatar(value)).not.toBeNull();
    }
    expect(h.fetch).toHaveBeenCalledTimes(65);
    await h.service.getAvatar(customers[0]!);
    expect(h.fetch).toHaveBeenCalledTimes(66);
  });

  it.each(['provider', 'download'])(
    'returns a quiet fallback for a sensitive %s error',
    async (stage) => {
      const h = setup();
      const failure = new Error('Private provider URL ' + avatarUrl);
      if (stage === 'provider') h.api.resolveUser.mockRejectedValueOnce(failure);
      else h.fetch.mockRejectedValueOnce(failure);
      await expect(h.service.getAvatar(h.own)).resolves.toBeNull();
    }
  );
});
