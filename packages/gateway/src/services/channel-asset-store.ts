import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { ChannelAttachment } from '@ownpilot/core/channels';
import {
  channelAssetsRepo,
  type ChannelAssetsRepository,
} from '../db/repositories/channels/assets.js';
import { getLog } from './log.js';

const log = getLog('ChannelAssetStore');
import { CHANNEL_ASSET_TTL_MS, CHANNEL_ASSET_MAX_FILENAME_LENGTH } from '../config/defaults.js';

const DEFAULT_TTL_MS = CHANNEL_ASSET_TTL_MS;

// Keep channel identities opaque in filesystem paths, including phone numbers.
function storageSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'audio/webm': '.webm',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/zip': '.zip',
  'application/octet-stream': '.bin',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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

function safeFilename(filename: string | undefined, fallback: string): string {
  const name = basename((filename || fallback).replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .slice(0, CHANNEL_ASSET_MAX_FILENAME_LENGTH);
  return name && name !== '.' && name !== '..' ? name : fallback;
}

function validateAttachment(
  attachment: ChannelAttachment,
  data: Uint8Array
): {
  mime: string;
  extension: string;
} {
  const mime = (attachment.mimeType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  const extension = MIME_EXTENSIONS[mime];
  if (!extension) throw new Error('Unsupported attachment MIME type');
  const limit = mime.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_ASSET_BYTES;
  if (data.length === 0) throw new Error('Empty attachment');
  if (data.length > limit) throw new Error('Attachment exceeds size limit');
  // Check signatures for formats with stable headers. A corrupt attachment
  // must not be silently stored as a legitimate receipt or document.
  const header = Buffer.from(data.subarray(0, 16));
  const begins = (bytes: number[]) => bytes.every((byte, i) => header[i] === byte);
  const text = header.toString('ascii');
  const checks: Record<string, boolean> = {
    'image/jpeg': begins([0xff, 0xd8, 0xff]),
    'image/png': begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'image/webp': text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP',
    'image/gif': text.startsWith('GIF87a') || text.startsWith('GIF89a'),
    'audio/ogg': text.startsWith('OggS'),
    'audio/opus': text.startsWith('OggS'),
    'audio/wav': text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE',
    'audio/x-wav': text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE',
    'application/pdf': text.startsWith('%PDF-'),
  };
  if (checks[mime] === false) throw new Error('Attachment content does not match MIME type');
  return { mime, extension };
}

function isWithinManagedRoot(baseDir: string, target: string): boolean {
  return resolve(target).startsWith(resolve(baseDir) + sep);
}

export class ChannelAssetStore {
  private lastPurgeAt = 0;

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
    const writtenPaths: string[] = [];
    const pendingPaths: string[] = [];
    const attemptedIds: string[] = [];

    try {
      for (const attachment of params.attachments) {
        // Some channels intentionally send metadata-only references. Preserve
        // them for the channel adapter rather than falsely claiming storage.
        if (attachment.data === undefined) {
          stored.push(attachment);
          continue;
        }
        const data = Buffer.from(attachment.data);
        const { mime, extension } = validateAttachment(attachment, data);
        const assetId = randomUUID();
        const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
        const dir = join(
          this.baseDir,
          storageSegment(params.channelPluginId),
          storageSegment(params.platformChatId),
          storageSegment(params.messageId)
        );
        await mkdir(dir, { recursive: true, mode: 0o700 });

        const filename = safeFilename(attachment.filename, attachment.type + extension);
        const storagePath = join(dir, assetId + extension);
        const partialPath = storagePath + '.part-' + randomUUID();

        pendingPaths.push(partialPath);
        await writeFile(partialPath, data, { flag: 'wx', mode: 0o600 });
        await rename(partialPath, storagePath);
        pendingPaths.pop();
        writtenPaths.push(storagePath);

        const sha256 = createHash('sha256').update(data).digest('hex');
        attemptedIds.push(assetId);
        await this.repo.create({
          id: assetId,
          channelMessageId: params.messageId,
          channelPluginId: params.channelPluginId,
          platform: params.platform,
          platformChatId: params.platformChatId,
          conversationId: params.conversationId,
          type: attachment.type,
          mimeType: mime,
          filename,
          size: data.length,
          storagePath,
          sha256,
          expiresAt,
          metadata: {},
        });

        stored.push({
          ...attachment,
          assetId,
          path: storagePath,
          expiresAt,
          size: data.length,
        });
      }
      return stored;
    } catch (error) {
      // Compensate for a partially completed batch. Never report a saved
      // attachment if a later write or database operation failed.
      let recordsRemoved = true;
      if (attemptedIds.length) {
        try {
          await this.repo.deleteMany(attemptedIds);
        } catch {
          recordsRemoved = false;
          log.error('Could not roll back channel asset database records');
        }
      }
      // If rollback of DB records fails, retain complete files for the
      // expiry process instead of leaving dangling database references.
      const toRemove = recordsRemoved ? [...writtenPaths, ...pendingPaths] : pendingPaths;
      for (const path of toRemove) {
        await rm(path, { force: true }).catch(() => {
          log.warn('Could not remove incomplete channel attachment');
        });
      }
      throw error;
    }
  }

  async linkConversation(assetIds: string[], conversationId: string): Promise<void> {
    await this.repo.linkConversation(assetIds, conversationId);
  }

  async purgeExpired(): Promise<number> {
    const expired = await this.repo.listExpired(new Date().toISOString());
    const removedIds: string[] = [];
    for (const asset of expired) {
      if (asset.storagePath) {
        if (!isWithinManagedRoot(this.baseDir, asset.storagePath)) {
          log.warn('Expired channel asset has an unmanaged path; refusing deletion');
          continue;
        }
        try {
          await rm(asset.storagePath, { force: true });
        } catch {
          log.warn('Expired channel asset deletion failed; will retry later');
          continue;
        }
      }
      removedIds.push(asset.id);
    }
    await this.repo.deleteMany(removedIds);
    return removedIds.length;
  }

  private async purgeExpiredIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPurgeAt < 15 * 60 * 1000) return;
    this.lastPurgeAt = now;

    try {
      const purged = await this.purgeExpired();
      if (purged > 0) log.info(`Purged ${purged} expired channel asset(s)`);
    } catch (error) {
      log.warn('Failed to purge expired channel assets', { error });
    }
  }
}

export const channelAssetStore = new ChannelAssetStore();

// Expiry cleanup also runs when traffic is idle. Do not keep the process alive.
const channelAssetPurgeTimer = setInterval(
  () => {
    void channelAssetStore.purgeExpired().catch(() => {
      log.warn('Scheduled channel asset cleanup failed');
    });
  },
  15 * 60 * 1000
);
channelAssetPurgeTimer.unref();
