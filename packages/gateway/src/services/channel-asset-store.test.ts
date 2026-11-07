import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelAssetStore } from './channel-asset-store.js';

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
