/**
 * Integration smoke against an isolated, real PostgreSQL test database.
 * Never point this script to production. Only synthetic, non-personal media
 * are persisted, and all test rows/files are removed in a finally block.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeAdapter, closeAdapter } from '../src/db/adapters/index.js';
import { ChannelAssetStore } from '../src/services/channel-asset-store.js';
import { createChannelAssetsRepository } from '../src/db/repositories/channels/assets.js';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT_NAME === 'production') {
    throw new Error('Refusing to run synthetic integration tests in production');
  }
  if (!process.env.POSTGRES_HOST?.includes('127.0.0.1') &&
      process.env.POSTGRES_HOST !== 'localhost') {
    throw new Error('Integration test requires loopback PostgreSQL only');
  }

  const baseDir = await mkdtemp(join(tmpdir(), 'astra-real-asset-smoke-'));
  const adapter = await initializeAdapter();
  const repository = createChannelAssetsRepository();
  const store = new ChannelAssetStore(repository, baseDir, 60_000);
  const prefix = 'astra-smoke-' + randomUUID();
  const uploadedIds: string[] = [];
  try {
    const sampleA = Buffer.from('%PDF-1.4\nsynthetic-document-A');
    const sampleB = Buffer.from('OggSsynthetic-audio-B');

    const messages = await Promise.all([
      store.persistIncomingAttachments({
        messageId: prefix + '-message-A',
        channelPluginId: 'synthetic-whatsapp',
        platform: 'whatsapp',
        platformChatId: prefix + '-chat-A',
        attachments: [
          { type: 'file', mimeType: 'application/pdf', filename: '../invoice.pdf', data: sampleA },
        ],
      }),
      store.persistIncomingAttachments({
        messageId: prefix + '-message-B',
        channelPluginId: 'synthetic-whatsapp',
        platform: 'whatsapp',
        platformChatId: prefix + '-chat-B',
        attachments: [
          { type: 'audio', mimeType: 'audio/ogg; codecs=opus', data: sampleB },
        ],
      }),
    ]);
    const assetA = messages[0]?.[0];
    const assetB = messages[1]?.[0];
    if (!assetA?.assetId || !assetA.path || !assetB?.assetId || !assetB.path) {
      throw new Error('Failed to persist two synthetic attachments');
    }
    uploadedIds.push(assetA.assetId, assetB.assetId);
    if (assetA.path === assetB.path ||
        assetA.path.includes(prefix) ||
        assetB.path.includes(prefix)) {
      throw new Error('A file path leaked the original chat ID or mixed two senders');
    }
    if (!(await readFile(assetA.path)).equals(sampleA) ||
        !(await readFile(assetB.path)).equals(sampleB)) {
      throw new Error('Stored attachment differs from incoming synthetic bytes');
    }

    const [rowA, rowB] = await Promise.all([
      repository.getById(assetA.assetId),
      repository.getById(assetB.assetId),
    ]);
    if (!rowA || !rowB ||
        rowA.platformChatId !== prefix + '-chat-A' ||
        rowB.platformChatId !== prefix + '-chat-B' ||
        rowA.sha256 === rowB.sha256) {
      throw new Error('Real PostgreSQL attachment records are inconsistent');
    }
    if (rowA.storagePath === rowB.storagePath) {
      throw new Error('Cross-user path collision');
    }

    // Keep byte-level evidence after creating a fresh store instance, which
    // models code restart without deleting persisted media.
    const restartedStore = new ChannelAssetStore(repository, baseDir, 60_000);
    if (!restartedStore ||
        !(await readFile(assetA.path)).equals(sampleA)) {
      throw new Error('Attachment did not survive a fresh store instance');
    }

    // Unsupported payload must never produce a misleading PostgreSQL row.
    let refused = false;
    try {
      await store.persistIncomingAttachments({
        messageId: prefix + '-invalid',
        channelPluginId: 'synthetic-whatsapp',
        platform: 'whatsapp',
        platformChatId: prefix + '-chat-A',
        attachments: [
          { type: 'file', mimeType: 'application/pdf', data: Buffer.from('not-a-pdf') },
        ],
      });
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('Corrupt PDF was accepted');
    const remaining = await adapter.queryOne<{ n: string }>(
      'SELECT COUNT(*) AS n FROM channel_assets WHERE channel_message_id = $1',
      [prefix + '-invalid'],
    );
    if (Number(remaining?.n) !== 0) throw new Error('Corrupt PDF left a database row');

    console.log('[astra] Real PostgreSQL channel-asset integration OK: two isolated senders, concurrent files, persistence and invalid input');
  } finally {
    if (uploadedIds.length) await repository.deleteMany(uploadedIds);
    await rm(baseDir, { recursive: true, force: true });
    await closeAdapter();
  }
}
main().catch((error) => {
  console.error('[astra] Real channel-asset integration failed:', error instanceof Error ? error.message : 'unknown');
  process.exitCode = 1;
});
