import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
