import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelAssetStore, resolveChannelAssetBaseDir } from './channel-asset-store.js';

describe('ChannelAssetStore', () => {
  let baseDir: string;
  let repo: {
    create: ReturnType<typeof vi.fn>;
    linkConversation: ReturnType<typeof vi.fn>;
    listExpired: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'ownpilot-channel-assets-'));
    repo = {
      create: vi.fn(async (input) => input),
      linkConversation: vi.fn(async () => undefined),
      listExpired: vi.fn(async () => []),
      deleteMany: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
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
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11]),
        },
      ],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.assetId).toBeTruthy();
    expect(attachments[0]?.path).toBeTruthy();
    expect(repo.create).toHaveBeenCalledTimes(1);

    const saved = await readFile(attachments[0]!.path!);
    expect(saved).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11]));
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

  it('resolves the storage directory from the persistent volume configuration', () => {
    vi.stubEnv('OWNPILOT_DATA_DIR', baseDir);
    expect(resolveChannelAssetBaseDir()).toBe(join(baseDir, 'tmp', 'channel-assets'));
    vi.stubEnv('OWNPILOT_DATA_DIR', 'relative/data');
    expect(() => resolveChannelAssetBaseDir()).toThrow('absolute');
  });

  it('isolates simultaneous users using opaque hashed path segments', async () => {
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    const make = (chat: string) =>
      store.persistIncomingAttachments({
        messageId: '../same-message',
        channelPluginId: 'whatsapp',
        platform: 'whatsapp',
        platformChatId: chat,
        attachments: [
          {
            type: 'image' as const,
            mimeType: 'image/jpeg',
            filename: '../../receipt.jpg',
            data: Buffer.from([0xff, 0xd8, 0xff, 0x01]),
          },
        ],
      });
    const [a, b] = await Promise.all([make('user-1'), make('user-2')]);
    const pathA = a[0]!.path!;
    const pathB = b[0]!.path!;
    expect(pathA).not.toBe(pathB);
    expect(relative(baseDir, pathA).startsWith('..')).toBe(false);
    expect(relative(baseDir, pathB).startsWith('..')).toBe(false);
    expect(pathA).not.toContain('user-1');
    expect(pathB).not.toContain('user-2');
    expect(pathA).not.toContain('receipt.jpg');
    expect(await readFile(pathA)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x01]));
    expect(repo.create).toHaveBeenCalledTimes(2);
  });

  it('persists supported audio, WebP, and PDF documents with safe extensions', async () => {
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    const assets = await store.persistIncomingAttachments({
      messageId: 'mixed',
      channelPluginId: 'whatsapp',
      platform: 'whatsapp',
      platformChatId: 'user-A',
      attachments: [
        { type: 'audio', mimeType: 'audio/ogg; codecs=opus', data: Buffer.from('OggS\0\0\0\0') },
        { type: 'audio', mimeType: 'audio/mp4', data: Buffer.from('....ftyp') },
        { type: 'image', mimeType: 'image/webp', data: Buffer.from('RIFF____WEBP') },
        { type: 'file', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7\nexample') },
      ],
    });
    expect(assets.map((a) => a.path!.split('.').at(-1))).toEqual(['ogg', 'm4a', 'webp', 'pdf']);
    for (const asset of assets) expect(await readFile(asset.path!)).toHaveLength(asset.size);
  });

  it('rejects corrupt images and PDFs before creating database rows', async () => {
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']) {
      await expect(
        store.persistIncomingAttachments({
          messageId: 'bad',
          channelPluginId: 'wa',
          platform: 'whatsapp',
          platformChatId: 'user',
          attachments: [{ type: 'file', mimeType: mime, data: Buffer.from('not real media') }],
        })
      ).rejects.toThrow('does not match');
    }
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects zero-byte and oversized attachments', async () => {
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    const make = (data: Buffer) =>
      store.persistIncomingAttachments({
        messageId: 'bad',
        channelPluginId: 'wa',
        platform: 'whatsapp',
        platformChatId: 'user',
        attachments: [{ type: 'audio' as const, mimeType: 'audio/mpeg', data }],
      });
    await expect(make(Buffer.alloc(0))).rejects.toThrow('Empty');
    await expect(make(Buffer.alloc(25 * 1024 * 1024 + 1))).rejects.toThrow('size limit');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rolls back files and database records if a later attachment fails', async () => {
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    let firstPath = '';
    repo.create.mockImplementationOnce(async (input) => {
      firstPath = input.storagePath;
      return input;
    });
    repo.create.mockRejectedValueOnce(new Error('db down'));
    // The second attachment still fails after the first succeeds.
    await expect(
      store.persistIncomingAttachments({
        messageId: 'partial',
        channelPluginId: 'wa',
        platform: 'whatsapp',
        platformChatId: 'user',
        attachments: [
          { type: 'image', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x01]) },
          { type: 'image', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x02]) },
        ],
      })
    ).rejects.toThrow('db down');
    await expect(readFile(firstPath)).rejects.toThrow();
    // Initial periodic purge can call deleteMany([]); only count rollback deletes.
    expect(repo.deleteMany.mock.calls.filter(([ids]) => ids.length > 0)).toHaveLength(1);
  });

  it('does not leave partial files when the directory cannot be written', async () => {
    const blocked = join(baseDir, 'blocked');
    await writeFile(blocked, 'file instead of directory');
    const store = new ChannelAssetStore(repo as never, join(blocked, 'nested'), 60_000);
    await expect(
      store.persistIncomingAttachments({
        messageId: 'blocked',
        channelPluginId: 'wa',
        platform: 'whatsapp',
        platformChatId: 'user',
        attachments: [
          { type: 'image', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x01]) },
        ],
      })
    ).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('keeps files readable after constructing a fresh store instance', async () => {
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    const [asset] = await store.persistIncomingAttachments({
      messageId: 'persist',
      channelPluginId: 'wa',
      platform: 'whatsapp',
      platformChatId: 'user',
      attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: Buffer.from('OggS1234') }],
    });
    const newStore = new ChannelAssetStore(repo as never, baseDir, 60_000);
    expect(newStore).toBeInstanceOf(ChannelAssetStore);
    expect(await readFile(asset!.path!)).toEqual(Buffer.from('OggS1234'));
  });

  it('never deletes expired assets pointing outside its managed directory', async () => {
    const foreign = join(await mkdtemp(join(tmpdir(), 'foreign-asset-')), 'keep.txt');
    try {
      await writeFile(foreign, 'must survive');
      repo.listExpired.mockResolvedValueOnce([{ id: 'foreign', storagePath: foreign }]);
      const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
      expect(await store.purgeExpired()).toBe(0);
      expect(await readFile(foreign, 'utf8')).toBe('must survive');
      expect(repo.deleteMany).toHaveBeenCalledWith([]);
    } finally {
      await rm(join(foreign, '..'), { recursive: true, force: true });
    }
  });
  it('removes only stale interrupted .part files, preserving live writes', async () => {
    const dir = join(baseDir, 'a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32));
    await mkdir(dir, { recursive: true });
    const assetId = '00000000-0000-4000-8000-000000000001';
    const stale = join(dir, assetId + '.jpg.part-00000000-0000-4000-8000-000000000002');
    const recent = join(dir, assetId + '.jpg.part-00000000-0000-4000-8000-000000000003');
    const complete = join(dir, assetId + '.jpg');
    await writeFile(stale, 'aborted');
    await writeFile(recent, 'in flight');
    await writeFile(complete, 'finished');
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, longAgo, longAgo);
    const store = new ChannelAssetStore(repo as never, baseDir, 60_000);
    expect(await store.purgeOrphanPartials()).toBe(1);
    await expect(readFile(stale)).rejects.toThrow();
    expect(await readFile(recent, 'utf8')).toBe('in flight');
    expect(await readFile(complete, 'utf8')).toBe('finished');
  });

});
