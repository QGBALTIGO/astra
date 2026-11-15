import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import type { ChannelAttachment } from '@ownpilot/core/channels';
import {
  channelAssetsRepo,
  type ChannelAssetsRepository,
  type ExpiredAssetCursor,
} from '../db/repositories/channels/assets.js';
import { getLog } from './log.js';

const log = getLog('ChannelAssetStore');
import { CHANNEL_ASSET_TTL_MS, CHANNEL_ASSET_MAX_FILENAME_LENGTH } from '../config/defaults.js';

const DEFAULT_TTL_MS = CHANNEL_ASSET_TTL_MS;
const MAX_PURGE_BATCHES = 5;

function safeSegment(value: string): string {
  const segment =
    value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, CHANNEL_ASSET_MAX_FILENAME_LENGTH) || 'unknown';
  return segment === '.' || segment === '..' ? 'unknown' : segment;
}

function extensionForAttachment(attachment: ChannelAttachment): string {
  if (attachment.filename) {
    const ext = extname(attachment.filename);
    // The original name remains metadata. Only a short ASCII extension may
    // reach the generated storage basename (also safe on Windows).
    if (/^\.[a-zA-Z0-9]{1,16}$/.test(ext)) return ext;
  }

  const mime = attachment.mimeType.toLowerCase();
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'audio/ogg') return '.ogg';
  if (mime === 'audio/mpeg') return '.mp3';
  if (mime === 'audio/wav') return '.wav';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'application/pdf') return '.pdf';
  return '';
}

/**
 * On Railway the gateway runs as an unprivileged user and its persistent
 * writable data volume is mounted at /app/data. process.cwd() (/app) is not
 * writable. Respect the same configured data root used for WhatsApp sessions.
 */
export function resolveChannelAssetBaseDir(): string {
  const configured = process.env.OWNPILOT_DATA_DIR?.trim();
  if (configured && !isAbsolute(configured)) {
    throw new Error('OWNPILOT_DATA_DIR must be an absolute path');
  }
  const root =
    configured ||
    (process.env.NODE_ENV === 'production' ? '/app/data' : join(process.cwd(), '.ownpilot'));
  return join(root, 'tmp', 'channel-assets');
}

export class ChannelAssetStore {
  private lastPurgeAt = 0;
  private purgeCursor?: ExpiredAssetCursor;
  private purgePromise?: Promise<number>;

  constructor(
    private readonly repo: ChannelAssetsRepository = channelAssetsRepo,
    private readonly baseDir = resolveChannelAssetBaseDir(),
    private readonly ttlMs = DEFAULT_TTL_MS
  ) {}

  async persistIncomingAttachments(params: {
    messageId: string;
    channelPluginId: string;
    platform: string;
    platformChatId: string;
    conversationId?: string;
    attachments: ChannelAttachment[];
  }): Promise<ChannelAttachment[]> {
    await this.purgeExpiredIfNeeded();

    const stored: ChannelAttachment[] = [];
    for (const attachment of params.attachments) {
      if (!attachment.data || attachment.data.length === 0) {
        stored.push(attachment);
        continue;
      }

      const assetId = randomUUID();
      const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
      const dir = join(
        this.baseDir,
        safeSegment(params.channelPluginId),
        safeSegment(params.platformChatId),
        safeSegment(params.messageId)
      );
      const extension = extensionForAttachment(attachment);
      const filename = attachment.filename ?? `${attachment.type}${extension}`;
      const storagePath = join(dir, `${assetId}${extension}`);
      const data = Buffer.from(attachment.data);
      const sha256 = createHash('sha256').update(data).digest('hex');
      // Persist the TTL cleanup reference before writing private bytes. This
      // ordering also handles an ambiguous database commit: no file is written
      // unless the durable record was acknowledged, so no compensating delete
      // can remove a file that the database successfully committed.
      await this.repo.create({
        id: assetId,
        channelMessageId: params.messageId,
        channelPluginId: params.channelPluginId,
        platform: params.platform,
        platformChatId: params.platformChatId,
        conversationId: params.conversationId,
        type: attachment.type,
        mimeType: attachment.mimeType,
        filename,
        size: attachment.size ?? data.length,
        storagePath,
        sha256,
        expiresAt,
        metadata: {},
      });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(storagePath, data, { flag: 'wx', mode: 0o600 });

      stored.push({
        ...attachment,
        assetId,
        path: storagePath,
        expiresAt,
        size: attachment.size ?? data.length,
      });
    }

    return stored;
  }

  async linkConversation(assetIds: string[], conversationId: string): Promise<void> {
    await this.repo.linkConversation(assetIds, conversationId);
  }

  purgeExpired(): Promise<number> {
    // Concurrent arrivals share one scan instead of racing its cursor.
    this.purgePromise ??= this.purgeExpiredBatches().finally(() => {
      this.purgePromise = undefined;
    });
    return this.purgePromise;
  }

  private async purgeExpiredBatches(): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch++) {
      const expired = await this.repo.listExpired(now, this.purgeCursor);
      if (expired.length === 0) {
        this.purgeCursor = undefined;
        break;
      }
      const removed: string[] = [];
      for (const asset of expired) {
        if (asset.storagePath) {
          try {
            await rm(asset.storagePath, { force: true });
          } catch {
            log.warn('Channel asset cleanup deferred', { assetId: asset.id });
            continue;
          }
        }
        removed.push(asset.id);
      }
      if (removed.length) await this.repo.deleteMany(removed);
      count += removed.length;
      const last = expired[expired.length - 1]!;
      // Failed records remain available for retry after the scan wraps. Keep
      // moving past them so they cannot monopolize the first 100 slots.
      this.purgeCursor = { expiresAt: last.expiresAt, id: last.id };
      if (expired.length < 100) {
        this.purgeCursor = undefined;
        break;
      }
    }
    return count;
  }

  private async purgeExpiredIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPurgeAt < 15 * 60 * 1000) return;
    this.lastPurgeAt = now;

    try {
      const purged = await this.purgeExpired();
      if (purged > 0) log.info(`Purged ${purged} expired channel asset(s)`);
    } catch {
      log.warn('Failed to purge expired channel assets');
    }
  }
}

export const channelAssetStore = new ChannelAssetStore();
