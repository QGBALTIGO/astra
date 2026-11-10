import {
  decodeBinaryNode,
  encodeBinaryNode,
  getBinaryNodeChild,
  type BinaryNode,
  type WASocket,
} from '@whiskeysockets/baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWhatsAppProfilePicture } from './whatsapp-profile-picture.js';

const PHONE = '5511999999999@s.whatsapp.net';
const LID = '100000000000001@lid';
const SELF = '5511888888888:1@s.whatsapp.net';
const SELF_LID = '100000000000002@lid';
const AVATAR_URL = 'https://pps.whatsapp.net/avatar-test.jpg';
const TOKEN = Buffer.from([4, 1, 33]);
const WEEK = 604_800;
type TokenEntries = Record<string, { token: Buffer; timestamp?: string; senderTimestamp?: number }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const entries: TokenEntries = { [LID]: { token: TOKEN, timestamp } };
  const response: BinaryNode = {
    tag: 'iq',
    attrs: {},
    content: [{ tag: 'picture', attrs: { url: AVATAR_URL } }],
  };
  const get = vi
    .fn<(type: string, ids: string[]) => Promise<TokenEntries>>()
    .mockResolvedValue(entries);
  const set = vi.fn();
  const getLIDForPN = vi.fn<(pn: string) => Promise<string | null>>().mockResolvedValue(LID);
  const query = vi
    .fn<(node: BinaryNode, timeout?: number) => Promise<BinaryNode>>()
    .mockResolvedValue(response);
  const value = {
    authState: { creds: { me: { id: SELF, lid: SELF_LID } }, keys: { get, set } },
    signalRepository: { lidMapping: { getLIDForPN } },
    serverProps: { profilePicPrivacyToken: true },
    query,
  };
  return {
    sock: value as unknown as WASocket,
    value,
    get,
    set,
    getLIDForPN,
    query,
    entries,
    response,
    timestamp,
  };
}

describe('WhatsApp profile-picture compatibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('serializes a valid token inside the preview query with its timestamp, without fetching bytes', async () => {
    const f = fixture();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected download'));

    await expect(fetchWhatsAppProfilePicture(f.sock, PHONE, () => true)).resolves.toBe(AVATAR_URL);

    expect(f.getLIDForPN).toHaveBeenCalledWith(PHONE);
    expect(f.get).toHaveBeenCalledWith('tctoken', [LID]);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls[0]?.[1]).toBe(3000);
    const iq = f.query.mock.calls[0]![0];
    expect(iq.attrs.to).toBe('@s.whatsapp.net');
    const decoded = await decodeBinaryNode(encodeBinaryNode(iq));
    expect(decoded.attrs).toMatchObject({
      target: PHONE,
      to: '@s.whatsapp.net',
      type: 'get',
      xmlns: 'w:profile:picture',
    });
    expect(getBinaryNodeChild(decoded, 'tctoken')).toBeUndefined();
    const picture = getBinaryNodeChild(decoded, 'picture')!;
    expect(picture.attrs).toEqual({ type: 'preview', query: 'url' });
    const token = getBinaryNodeChild(picture, 'tctoken')!;
    expect(token.attrs).toEqual({ t: f.timestamp });
    expect(token.content).toEqual(TOKEN);
    expect(f.set).not.toHaveBeenCalled();
    expect(f.value.serverProps.profilePicPrivacyToken).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads a LID directly and falls back to PN storage only when no LID mapping exists', async () => {
    const lid = fixture();
    await expect(fetchWhatsAppProfilePicture(lid.sock, LID, () => true)).resolves.toBe(AVATAR_URL);
    expect(lid.getLIDForPN).not.toHaveBeenCalled();
    expect(lid.get).toHaveBeenCalledWith('tctoken', [LID]);

    const pn = fixture();
    pn.getLIDForPN.mockResolvedValue(null);
    pn.get.mockResolvedValue({ [PHONE]: { token: TOKEN, timestamp: pn.timestamp } });
    await expect(fetchWhatsAppProfilePicture(pn.sock, PHONE, () => true)).resolves.toBe(AVATAR_URL);
    expect(pn.get).toHaveBeenCalledWith('tctoken', [PHONE]);
    const picture = getBinaryNodeChild(pn.query.mock.calls[0]![0], 'picture')!;
    expect(getBinaryNodeChild(picture, 'tctoken')?.content).toBe(TOKEN);
  });

  it.each([SELF, SELF_LID])(
    'does not attach or read a token for the connected identity %s',
    async (jid) => {
      const f = fixture();
      await expect(fetchWhatsAppProfilePicture(f.sock, jid, () => true)).resolves.toBe(AVATAR_URL);
      expect(f.get).not.toHaveBeenCalled();
      expect(f.getLIDForPN).not.toHaveBeenCalled();
      expect(getBinaryNodeChild(f.query.mock.calls[0]![0], 'picture')?.content).toBeUndefined();
    }
  );

  it('respects the server token feature setting without changing it', async () => {
    const f = fixture();
    f.value.serverProps.profilePicPrivacyToken = false;
    await expect(fetchWhatsAppProfilePicture(f.sock, PHONE, () => true)).resolves.toBe(AVATAR_URL);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.getLIDForPN).not.toHaveBeenCalled();
    expect(f.value.serverProps.profilePicPrivacyToken).toBe(false);
    expect(getBinaryNodeChild(f.query.mock.calls[0]![0], 'picture')?.content).toBeUndefined();
  });

  it.each([undefined, '', 'not-a-timestamp', '123junk'])(
    'never sends an unusable token timestamp %j or modifies its stored record',
    async (timestamp) => {
      const f = fixture();
      f.get.mockResolvedValue({ [LID]: { token: TOKEN, timestamp } });
      await expect(fetchWhatsAppProfilePicture(f.sock, PHONE, () => true)).resolves.toBe(
        AVATAR_URL
      );
      expect(getBinaryNodeChild(f.query.mock.calls[0]![0], 'picture')?.content).toBeUndefined();
      expect(f.set).not.toHaveBeenCalled();
    }
  );

  it('retains the token at the upstream weekly cutoff and omits one older by a second', async () => {
    const cutoff = (Math.floor(Date.now() / 1000 / WEEK) - 3) * WEEK;
    for (const timestamp of [cutoff, cutoff - 1]) {
      const f = fixture();
      f.get.mockResolvedValue({ [LID]: { token: TOKEN, timestamp: String(timestamp) } });
      await expect(fetchWhatsAppProfilePicture(f.sock, PHONE, () => true)).resolves.toBe(
        AVATAR_URL
      );
      const picture = getBinaryNodeChild(f.query.mock.calls[0]![0], 'picture')!;
      expect(Boolean(getBinaryNodeChild(picture, 'tctoken'))).toBe(timestamp === cutoff);
      expect(f.set).not.toHaveBeenCalled();
    }
  });

  it('lets the server decide visibility when no token or picture is available', async () => {
    const f = fixture();
    f.get.mockResolvedValue({});
    f.query.mockResolvedValue({ tag: 'iq', attrs: {}, content: [] });
    await expect(fetchWhatsAppProfilePicture(f.sock, PHONE, () => true)).resolves.toBeNull();
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(getBinaryNodeChild(f.query.mock.calls[0]![0], 'picture')?.content).toBeUndefined();
    expect(f.set).not.toHaveBeenCalled();
  });

  it.each(['mapping', 'keys'] as const)(
    'does not query without a token when the %s lookup fails',
    async (stage) => {
      const f = fixture();
      if (stage === 'mapping') f.getLIDForPN.mockRejectedValue(new Error('lookup failed'));
      else f.get.mockRejectedValue(new Error('read failed'));

      await expect(fetchWhatsAppProfilePicture(f.sock, PHONE, () => true)).resolves.toBeNull();
      expect(f.query).not.toHaveBeenCalled();
      expect(f.set).not.toHaveBeenCalled();
    }
  );

  it.each([401, 403, 404, 408])(
    'returns null without retry after provider status %s',
    async (status) => {
      const f = fixture();
      f.query.mockRejectedValue({ output: { statusCode: status } });
      await expect(fetchWhatsAppProfilePicture(f.sock, PHONE, () => true)).resolves.toBeNull();
      expect(f.query).toHaveBeenCalledTimes(1);
      expect(f.set).not.toHaveBeenCalled();
    }
  );

  it.each(['mapping', 'keys'] as const)(
    'bounds a stalled %s read and prevents a late query after the deadline',
    async (stage) => {
      const f = fixture();
      const mapping = deferred<string | null>();
      const keys = deferred<TokenEntries>();
      if (stage === 'mapping') f.getLIDForPN.mockReturnValue(mapping.promise);
      else f.get.mockReturnValue(keys.promise);

      const result = fetchWhatsAppProfilePicture(f.sock, PHONE, () => true, 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toBeNull();
      mapping.resolve(LID);
      keys.resolve(f.entries);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.query).not.toHaveBeenCalled();
      expect(f.set).not.toHaveBeenCalled();
    }
  );

  it('uses only the remaining budget for the query and ignores a late provider response', async () => {
    const f = fixture();
    const keys = deferred<TokenEntries>();
    const response = deferred<BinaryNode>();
    f.get.mockReturnValue(keys.promise);
    f.query.mockReturnValue(response.promise);

    const result = fetchWhatsAppProfilePicture(f.sock, PHONE, () => true);
    await vi.advanceTimersByTimeAsync(2400);
    keys.resolve(f.entries);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.query.mock.calls[0]?.[1]).toBe(600);
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toBeNull();
    response.resolve(f.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it.each(['mapping', 'keys', 'query'] as const)(
    'discards a result when the authenticated connection changes during %s',
    async (stage) => {
      const f = fixture();
      let active = true;
      const mapping = deferred<string | null>();
      const keys = deferred<TokenEntries>();
      const response = deferred<BinaryNode>();
      if (stage === 'mapping') f.getLIDForPN.mockReturnValue(mapping.promise);
      if (stage === 'keys') f.get.mockReturnValue(keys.promise);
      if (stage === 'query') f.query.mockReturnValue(response.promise);

      const result = fetchWhatsAppProfilePicture(f.sock, PHONE, () => active);
      await vi.advanceTimersByTimeAsync(0);
      active = false;
      mapping.resolve(LID);
      keys.resolve(f.entries);
      response.resolve(f.response);
      await expect(result).resolves.toBeNull();
      expect(f.query).toHaveBeenCalledTimes(stage === 'query' ? 1 : 0);
      expect(f.set).not.toHaveBeenCalled();
    }
  );

  it('refuses stale connections and non-user targets before any lookup', async () => {
    const f = fixture();
    await expect(fetchWhatsAppProfilePicture(f.sock, PHONE, () => false)).resolves.toBeNull();
    await expect(fetchWhatsAppProfilePicture(f.sock, '123@g.us', () => true)).resolves.toBeNull();
    await expect(
      fetchWhatsAppProfilePicture(f.sock, 'status@broadcast', () => true)
    ).resolves.toBeNull();
    expect(f.getLIDForPN).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity])('rejects an invalid timeout %s', async (timeout) => {
    const f = fixture();
    await expect(
      fetchWhatsAppProfilePicture(f.sock, PHONE, () => true, timeout)
    ).resolves.toBeNull();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });

  it('never waits more than three seconds even if a larger timeout is supplied', async () => {
    const f = fixture();
    const pending = deferred<string | null>();
    f.getLIDForPN.mockReturnValue(pending.promise);
    const result = fetchWhatsAppProfilePicture(f.sock, PHONE, () => true, 60_000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toBeNull();
    pending.resolve(LID);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.query).not.toHaveBeenCalled();
  });
});
