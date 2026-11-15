import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WASocket } from '@whiskeysockets/baileys';
const f = vi.hoisted(() => ({
  patches: vi.fn(),
  extract: vi.fn(),
  decode: vi.fn(),
  query: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock('@whiskeysockets/baileys', () => ({
  extractSyncdPatches: f.extract,
  decodeSyncdSnapshot: f.decode,
  decodePatches: f.patches,
}));
import { readWhatsAppServerContacts } from './whatsapp-server-contacts.js';
const socket = () =>
  ({ query: f.query, authState: { keys: { get: f.get, set: f.set } } }) as unknown as WASocket;
beforeEach(() => {
  vi.clearAllMocks();
  f.query.mockResolvedValue({ tag: 'iq', attrs: {} });
  f.get.mockResolvedValue({ key: { keyData: new Uint8Array(32) } });
  f.extract.mockResolvedValue({ regular: { snapshot: { version: { version: 10 } } } });
  f.decode.mockResolvedValue({
    mutationMap: {
      a: {
        index: ['contact', '244927000001@s.whatsapp.net'],
        syncAction: { value: { contactAction: { fullName: 'Contato Angola' } } },
      },
      b: {
        index: ['archive', '5581999990101@s.whatsapp.net'],
        syncAction: { value: { archiveChatAction: {} } },
      },
      c: { index: ['mute', '123@g.us'], syncAction: { value: { muteAction: {} } } },
    },
  });
});
describe('read-only linked-session contact snapshots', () => {
  it('includes recent signed patches after the base snapshot without advancing SDK state', async () => {
    const at = Math.floor(new Date('2026-11-14T17:59:00Z').getTime() / 1000);
    f.extract.mockResolvedValueOnce({ regular: { snapshot: {}, patches: [{}] } });
    const state = { version: 7 };
    f.decode.mockResolvedValueOnce({ state, mutationMap: {} });
    f.patches.mockResolvedValueOnce({
      mutationMap: {
        recent: {
          index: ['read', '244927000072@s.whatsapp.net'],
          syncAction: {
            value: {
              markChatAsReadAction: {
                messageRange: { messages: [{ key: { fromMe: false }, timestamp: at }] },
              },
            },
          },
        },
      },
    });
    const rows = await readWhatsAppServerContacts(
      socket(),
      () => true,
      async (key) => key.remoteJid ?? null,
      () => false
    );
    expect(rows).toEqual([
      {
        phone: '244927000072',
        name: undefined,
        seenAt: new Date(at * 1000),
        interactionConfirmed: true,
      },
    ]);
    expect(f.patches).toHaveBeenCalledWith(
      'regular',
      [{}],
      state,
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      undefined,
      undefined,
      true
    );
    expect(f.set).not.toHaveBeenCalled();
  });
  it('uses explicit authenticated incoming-message evidence but never an outgoing message or aggregate clock as proof', async () => {
    const at = Math.floor(new Date('2026-11-14T17:59:00Z').getTime() / 1000);
    f.decode.mockResolvedValueOnce({
      mutationMap: {
        incoming: {
          index: ['markChatAsRead', '244927000072@s.whatsapp.net'],
          syncAction: {
            value: {
              markChatAsReadAction: {
                messageRange: {
                  messages: [
                    {
                      key: { remoteJid: '244927000072@s.whatsapp.net', fromMe: false },
                      timestamp: at,
                    },
                  ],
                },
              },
            },
          },
        },
        outgoing: {
          index: ['archive', '5581999990101@s.whatsapp.net'],
          syncAction: {
            value: {
              archiveChatAction: {
                messageRange: {
                  lastMessageTimestamp: at,
                  messages: [{ key: { fromMe: true }, timestamp: at }],
                },
              },
            },
          },
        },
      },
    });
    const rows = await readWhatsAppServerContacts(
      socket(),
      () => true,
      async (key) => key.remoteJid ?? null,
      () => false
    );
    expect(rows.find((row) => row.phone === '244927000072')).toMatchObject({
      interactionConfirmed: true,
      seenAt: new Date(at * 1000),
    });
    expect(rows.find((row) => row.phone === '5581999990101')?.interactionConfirmed).toBeUndefined();
  });
  it('requests verified server snapshots without resetting keys, sync cursors or chats', async () => {
    const s = socket();
    const rows = await readWhatsAppServerContacts(
      s,
      () => true,
      async (k) => k.remoteJid ?? null,
      () => false
    );
    expect(rows.map((c) => c.phone).sort()).toEqual(['244927000001', '5581999990101']);
    expect(rows.find((c) => c.phone.startsWith('244'))?.name).toBe('Contato Angola');
    expect(f.query).toHaveBeenCalledWith(
      expect.objectContaining({
        attrs: { to: 's.whatsapp.net', xmlns: 'w:sync:app:state', type: 'set' },
        content: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                attrs: { name: 'regular', version: '0', return_snapshot: 'true' },
              }),
            ]),
          }),
        ],
      }),
      8000
    );
    expect(f.decode).toHaveBeenCalledWith(
      'regular',
      expect.any(Object),
      expect.any(Function),
      undefined,
      true
    );
    const getKey = f.decode.mock.calls[0]![2];
    expect(await getKey('key')).toMatchObject({ keyData: expect.any(Uint8Array) });
    expect(f.set).not.toHaveBeenCalled();
  });
  it('discards results when the connection changes while requesting snapshots', async () => {
    let active = true;
    f.query.mockImplementationOnce(async () => {
      active = false;
      return {};
    });
    expect(
      await readWhatsAppServerContacts(
        socket(),
        () => active,
        async (k) => k.remoteJid ?? null,
        () => false
      )
    ).toEqual([]);
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.set).not.toHaveBeenCalled();
  });
  it('does not accept snapshots that fail MAC authentication', async () => {
    f.decode.mockRejectedValueOnce(new Error('invalid MAC'));
    await expect(
      readWhatsAppServerContacts(
        socket(),
        () => true,
        async (k) => k.remoteJid ?? null,
        () => false
      )
    ).rejects.toThrow('invalid MAC');
    expect(f.set).not.toHaveBeenCalled();
  });
});
