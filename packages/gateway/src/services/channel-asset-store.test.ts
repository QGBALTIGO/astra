import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChannelAssetStore,
  ChannelAssetUnavailableError,
  resolveChannelAssetBaseDir,
} from './channel-asset-store.js';

describe('ChannelAssetStore', () => {
  let baseDir: string;
  let repo: {
    create: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    linkConversation: ReturnType<typeof vi.fn>;
    listExpired: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'ownpilot-channel-assets-'));
    repo = {
      create: vi.fn(async (input) => input),
      getById: vi.fn(
        async (id: string) => repo.create.mock.calls.find(([asset]) => asset.id === id)?.[0] ?? null
      ),
      linkConversation: vi.fn(async () => undefined),
      listExpired: vi.fn(async () => []),
      deleteMany: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('writes to the existing Railway volume instead of /app/.ownpilot in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OWNPILOT_DATA_DIR', '/app/data');
    expect(resolveChannelAssetBaseDir()).toBe('/app/data/tmp/channel-assets');
    vi.stubEnv('OWNPILOT_DATA_DIR', '');
    expect(resolveChannelAssetBaseDir()).toBe('/app/data/tmp/channel-assets');
  });

  it('honors the configured absolute data directory and refuses relative traversal', () => {
    vi.stubEnv('OWNPILOT_DATA_DIR', baseDir);
    expect(resolveChannelAssetBaseDir()).toBe(join(baseDir, 'tmp', 'channel-assets'));
    vi.stubEnv('OWNPILOT_DATA_DIR', '../private');
    expect(() => resolveChannelAssetBaseDir()).toThrow('absolute path');
  });

  it('stores binary attachments on disk and returns asset references', async () => {
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);

    const attachments = await store.persistIncomingAttachments({
      messageId: 'channel.telegram:1',
      channelPluginId: 'channel.telegram',
      platform: 'telegram',
      platformChatId: 'chat-1',
      attachments: [
        {
          type: 'image',
          mimeType: 'image/png',
          filename: 'photo.png',
          data: Buffer.from('png-bytes'),
        },
      ],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.assetId).toBeTruthy();
    expect(attachments[0]?.path).toBeTruthy();
    expect(repo.create).toHaveBeenCalledTimes(1);

    const saved = await readFile(attachments[0]!.path!, 'utf8');
    expect(saved).toBe('png-bytes');
  });

  it('passes through metadata-only attachments unchanged', async () => {
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);

    const attachments = await store.persistIncomingAttachments({
      messageId: 'channel.telegram:2',
      channelPluginId: 'channel.telegram',
      platform: 'telegram',
      platformChatId: 'chat-1',
      attachments: [{ type: 'file', mimeType: 'application/pdf', filename: 'doc.pdf' }],
    });

    expect(attachments).toEqual([
      { type: 'file', mimeType: 'application/pdf', filename: 'doc.pdf' },
    ]);
    expect(repo.create).not.toHaveBeenCalled();
  });

  describe('scoped hydration after AI admission', () => {
    const scope = {
      messageId: 'channel.whatsapp:media-1',
      channelPluginId: 'channel.whatsapp',
      platform: 'whatsapp',
      platformChatId: 'synthetic-chat',
    };

    async function fixture(storageDir = baseDir, data = Buffer.from('private synthetic image')) {
      const store = new ChannelAssetStore(repo as never, storageDir, 60_000);
      const [stored] = await store.persistIncomingAttachments({
        ...scope,
        attachments: [{ type: 'image', mimeType: 'image/png', filename: 'photo.png', data }],
      });
      const { data: _data, ...reference } = stored!;
      return { store, reference, record: repo.create.mock.calls.at(-1)![0], data };
    }

    it('hydrates a clone from the authorized record, ignoring a caller path and MIME', async () => {
      const { store, reference, data } = await fixture();
      const caller = { ...reference, path: '/not-authorized/private.txt', mimeType: 'text/plain' };
      const [hydrated] = await store.hydrateIncomingAttachments({
        ...scope,
        conversationId: 'conversation-still-linking',
        attachments: [caller],
      });
      expect(hydrated?.data).toEqual(data);
      expect(hydrated?.mimeType).toBe('image/png');
      expect(hydrated?.path).toBeUndefined();
      expect(caller).not.toHaveProperty('data');
      expect(caller.path).toBe('/not-authorized/private.txt');
    });

    it.each([
      ['messageId', 'another-message'],
      ['channelPluginId', 'channel.other'],
      ['platform', 'telegram'],
      ['platformChatId', 'another-customer-chat'],
    ] as const)(
      'refuses a record outside the %s scope before reading bytes',
      async (field, value) => {
        const { store, reference } = await fixture();
        await rm(reference.path!);
        await expect(
          store.hydrateIncomingAttachments({ ...scope, [field]: value, attachments: [reference] })
        ).rejects.toBeInstanceOf(ChannelAssetUnavailableError);
      }
    );

    it('rejects another conversation when both durable links are present', async () => {
      const { store, reference, record } = await fixture();
      record.conversationId = 'conversation-owner';
      await expect(
        store.hydrateIncomingAttachments({
          ...scope,
          conversationId: 'conversation-other',
          attachments: [reference],
        })
      ).rejects.toBeInstanceOf(ChannelAssetUnavailableError);
    });

    it.each(['missing', 'expired', 'invalid-expiry'] as const)(
      'rejects %s assets even when the caller supplies bytes',
      async (reason) => {
        const { store, reference, record, data } = await fixture();
        if (reason === 'missing') repo.getById.mockResolvedValueOnce(null);
        else record.expiresAt = reason === 'expired' ? '2000-01-01T00:00:00Z' : 'invalid';
        await expect(
          store.hydrateIncomingAttachments({
            ...scope,
            attachments: [{ ...reference, data }],
          })
        ).rejects.toBeInstanceOf(ChannelAssetUnavailableError);
      }
    );

    it('never reads a path-only reference and preserves unpersisted inline bytes', async () => {
      const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
      const inline = { type: 'image' as const, mimeType: 'image/png', data: Buffer.from('inline') };
      expect(await store.hydrateIncomingAttachments({ ...scope, attachments: [inline] })).toEqual([
        inline,
      ]);
      expect(repo.getById).not.toHaveBeenCalled();
      await expect(
        store.hydrateIncomingAttachments({
          ...scope,
          attachments: [{ type: 'file', mimeType: 'text/plain', path: '/private-file' }],
        })
      ).rejects.toBeInstanceOf(ChannelAssetUnavailableError);
    });

    it('rejects a durable path outside its generated scope', async () => {
      const { store, reference, record } = await fixture();
      record.storagePath = join(baseDir, 'another-file.png');
      await expect(
        store.hydrateIncomingAttachments({ ...scope, attachments: [reference] })
      ).rejects.toBeInstanceOf(ChannelAssetUnavailableError);
    });

    it('rejects a symlink that escapes the private asset root', async () => {
      const { store, reference, data } = await fixture(join(baseDir, 'private-assets'));
      const outside = join(baseDir, basename(reference.path!));
      await writeFile(outside, data);
      await rm(reference.path!);
      await symlink(outside, reference.path!);
      await expect(
        store.hydrateIncomingAttachments({ ...scope, attachments: [reference] })
      ).rejects.toBeInstanceOf(ChannelAssetUnavailableError);
    });

    it('rejects corrupted or missing files without fabricating an attachment', async () => {
      const { store, reference } = await fixture();
      await writeFile(reference.path!, 'different private bytes');
      await expect(
        store.hydrateIncomingAttachments({ ...scope, attachments: [reference] })
      ).rejects.toBeInstanceOf(ChannelAssetUnavailableError);
      await rm(reference.path!);
      await expect(
        store.hydrateIncomingAttachments({ ...scope, attachments: [reference] })
      ).rejects.toThrow();
    });

    it('checks the actual file size before allocating an oversized attachment', async () => {
      const { store, reference } = await fixture();
      const file = await open(reference.path!, 'r+');
      try {
        await file.truncate(12 * 1024 * 1024 + 1);
      } finally {
        await file.close();
      }
      await expect(
        store.hydrateIncomingAttachments({ ...scope, attachments: [reference] })
      ).rejects.toBeInstanceOf(ChannelAssetUnavailableError);
    });

    it('bounds total hydrated bytes across multiple valid attachments', async () => {
      const { store, reference } = await fixture(baseDir, Buffer.alloc(12 * 1024 * 1024, 1));
      await expect(
        store.hydrateIncomingAttachments({
          ...scope,
          attachments: [reference, reference, reference, reference],
        })
      ).rejects.toBeInstanceOf(ChannelAssetUnavailableError);
    });
  });

  it.each(['a.' + 'x'.repeat(240), 'a.' + 'ç'.repeat(120), 'a.p$d$f'])(
    'stores unsafe extensions using a bounded MIME fallback: %s',
    async (filename) => {
      const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
      const [attachment] = await store.persistIncomingAttachments({
        messageId: 'long-filename',
        channelPluginId: 'channel.whatsapp',
        platform: 'whatsapp',
        platformChatId: 'synthetic-chat',
        attachments: [
          { type: 'file', mimeType: 'application/pdf', filename, data: Buffer.from('synthetic') },
        ],
      });
      expect(Buffer.byteLength(basename(attachment!.path!))).toBeLessThanOrEqual(53);
      expect(extname(attachment!.path!)).toBe('.pdf');
      expect(attachment!.filename).toBe(filename);
      expect(await readFile(attachment!.path!, 'utf8')).toBe('synthetic');
    }
  );

  it('keeps an unknown MIME attachment usable without copying an unsafe extension', async () => {
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    const [attachment] = await store.persistIncomingAttachments({
      messageId: 'unknown-format',
      channelPluginId: 'channel.whatsapp',
      platform: 'whatsapp',
      platformChatId: 'synthetic-chat',
      attachments: [
        {
          type: 'file',
          mimeType: 'application/octet-stream',
          filename: 'a.' + 'x'.repeat(240),
          data: Buffer.from('synthetic'),
        },
      ],
    });
    expect(extname(attachment!.path!)).toBe('');
    expect(await readFile(attachment!.path!, 'utf8')).toBe('synthetic');
  });

  it('does not write a private file when its database record cannot be saved', async () => {
    repo.create.mockRejectedValueOnce(new Error('synthetic_database_failure'));
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    await expect(
      store.persistIncomingAttachments({
        messageId: 'message-rollback',
        channelPluginId: 'channel.whatsapp',
        platform: 'whatsapp',
        platformChatId: 'synthetic-chat',
        attachments: [
          {
            type: 'file',
            mimeType: 'application/pdf',
            data: Buffer.from('private synthetic document'),
          },
        ],
      })
    ).rejects.toThrow('synthetic_database_failure');
    expect(
      (await readdir(baseDir, { recursive: true })).filter((name) => name.endsWith('.pdf'))
    ).toEqual([]);
  });

  it('acknowledges the cleanup record before writing the document bytes', async () => {
    repo.create.mockImplementationOnce(async (input) => {
      await expect(readFile(input.storagePath)).rejects.toThrow();
      return input;
    });
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    const attachments = await store.persistIncomingAttachments({
      messageId: 'persist-first',
      channelPluginId: 'channel.whatsapp',
      platform: 'whatsapp',
      platformChatId: 'synthetic-chat',
      attachments: [{ type: 'file', mimeType: 'application/pdf', data: Buffer.from('synthetic') }],
    });
    expect(await readFile(attachments[0]!.path!, 'utf8')).toBe('synthetic');
  });

  it('retains failed deletions for retry while retiring successfully removed assets', async () => {
    const directory = join(baseDir, 'unexpected-directory');
    const file = join(baseDir, 'expired-file.bin');
    await mkdir(directory);
    await writeFile(file, 'old');
    repo.listExpired.mockResolvedValueOnce([
      { id: 'retry-me', storagePath: directory },
      { id: 'remove-me', storagePath: file },
    ]);
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    expect(await store.purgeExpired()).toBe(1);
    expect(repo.deleteMany).toHaveBeenCalledWith(['remove-me']);
    expect(await readdir(baseDir)).toContain('unexpected-directory');
  });

  it('contains dot-only identifier segments inside the configured asset directory', async () => {
    // Escapes remain inside this test’s disposable parent even before the fix.
    const storage = join(baseDir, 'scoped', 'assets');
    await mkdir(storage, { recursive: true });
    const store = new ChannelAssetStore(repo as never, storage, 60_000);
    const attachments = await store.persistIncomingAttachments({
      messageId: '..',
      channelPluginId: '.',
      platform: 'synthetic',
      platformChatId: '..',
      attachments: [{ type: 'file', mimeType: 'application/pdf', data: Buffer.from('synthetic') }],
    });
    const storedRelative = relative(storage, attachments[0]!.path!);
    expect(storedRelative).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(await readFile(attachments[0]!.path!, 'utf8')).toBe('synthetic');
  });

  it('purges expired assets from disk and repository', async () => {
    const filePath = join(baseDir, 'expired.bin');
    await writeFile(filePath, 'old-bytes');
    repo.listExpired.mockResolvedValueOnce([
      {
        id: 'asset-1',
        storagePath: filePath,
      },
    ]);

    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    const purged = await store.purgeExpired();

    expect(purged).toBe(1);
    expect(repo.deleteMany).toHaveBeenCalledWith(['asset-1']);
    await expect(readFile(filePath)).rejects.toThrow();
  });
});
