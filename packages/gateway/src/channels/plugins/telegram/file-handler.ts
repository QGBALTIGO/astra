/**
 * Telegram File Download Handler
 *
 * Downloads files from Telegram (photos, documents, audio, voice)
 * and converts them to base64-encoded data for AI processing.
 */

import type { Bot } from 'grammy';
import type { Message, PhotoSize } from 'grammy/types';
import type { ChannelAttachment } from '@ownpilot/core/channels';
import { getLog } from '../../../services/log.js';

const log = getLog('TelegramFile');

/** Match the WhatsApp download and shared asset hydration limit. */
const MAX_FILE_SIZE = 12 * 1024 * 1024;

/** MIME types we support for AI analysis. */
const ANALYZABLE_MIME_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Documents
  'application/pdf',
  // Audio
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
]);

/**
 * Download a file from Telegram and return its data as base64.
 */
async function downloadTelegramFile(
  bot: Bot,
  fileId: string
): Promise<{ buffer: Buffer; filePath: string } | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  try {
    const signal = AbortSignal.timeout(15_000);
    // Grammy declares its legacy AbortSignal polyfill; Node supplies the same
    // cancellation contract for its HTTP transport and the subsequent fetch.
    const file = await bot.api.getFile(
      fileId,
      signal as unknown as Parameters<typeof bot.api.getFile>[1]
    );
    if (!file.file_path) {
      log.warn('Telegram getFile returned no file_path', { fileId });
      return null;
    }

    // Pre-download size check (avoid buffering huge files)
    if (file.file_size && file.file_size > MAX_FILE_SIZE) {
      log.warn('File exceeds size limit (pre-download)', {
        size: file.file_size,
        max: MAX_FILE_SIZE,
      });
      return null;
    }

    // Construct download URL
    const token = bot.token;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    response = await fetch(url, { signal, redirect: 'error' });
    if (!response.ok) {
      log.warn('Telegram file download failed', { status: response.status, fileId });
      return null;
    }

    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_FILE_SIZE)) {
      log.warn('File exceeds size limit', { size: Number(length), max: MAX_FILE_SIZE });
      return null;
    }
    if (!response.body) return null;
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_SIZE) {
        log.warn('File exceeds size limit', { size, max: MAX_FILE_SIZE });
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    if (!size || signal.aborted) return null;
    return { buffer: Buffer.concat(chunks, size), filePath: file.file_path };
  } catch (err) {
    // Fetch errors may embed the bot token in the download URL.
    log.warn('Failed to download file from Telegram', {
      fileId,
      category: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  } finally {
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else {
      void response?.body?.cancel().catch(() => undefined);
    }
  }
}

/**
 * Process all attachments from a Telegram message.
 * Downloads analyzable files and returns enriched ChannelAttachment array.
 */
export async function downloadTelegramAttachments(
  bot: Bot,
  message: Message
): Promise<ChannelAttachment[]> {
  const attachments: ChannelAttachment[] = [];

  // Photos — pick the largest version
  if (message.photo && message.photo.length > 0) {
    const largest: PhotoSize = message.photo[message.photo.length - 1]!;
    if (!largest.file_size || largest.file_size <= MAX_FILE_SIZE) {
      const result = await downloadTelegramFile(bot, largest.file_id);
      if (result) {
        attachments.push({
          type: 'image',
          mimeType: 'image/jpeg',
          filename: `photo_${largest.file_id}.jpg`,
          size: result.buffer.length,
          data: result.buffer,
        });
      }
    }
  }

  // Documents
  if (message.document) {
    const mime = message.document.mime_type ?? 'application/octet-stream';
    if (ANALYZABLE_MIME_TYPES.has(mime)) {
      if (!message.document.file_size || message.document.file_size <= MAX_FILE_SIZE) {
        const result = await downloadTelegramFile(bot, message.document.file_id);
        if (result) {
          attachments.push({
            type: mime.startsWith('image/') ? 'image' : 'file',
            mimeType: mime,
            filename: message.document.file_name ?? `doc_${message.document.file_id}`,
            size: result.buffer.length,
            data: result.buffer,
          });
        }
      }
    } else {
      // Non-analyzable document — metadata only
      attachments.push({
        type: 'file',
        mimeType: mime,
        filename: message.document.file_name ?? `doc_${message.document.file_id}`,
        size: message.document.file_size,
      });
    }
  }

  // Audio files
  if (message.audio) {
    const mime = message.audio.mime_type ?? 'audio/mpeg';
    if (!message.audio.file_size || message.audio.file_size <= MAX_FILE_SIZE) {
      const result = await downloadTelegramFile(bot, message.audio.file_id);
      if (result) {
        attachments.push({
          type: 'audio',
          mimeType: mime,
          filename: message.audio.file_name ?? `audio_${message.audio.file_id}`,
          size: result.buffer.length,
          data: result.buffer,
        });
      }
    }
  }

  // Voice messages
  if (message.voice) {
    const mime = message.voice.mime_type ?? 'audio/ogg';
    if (!message.voice.file_size || message.voice.file_size <= MAX_FILE_SIZE) {
      const result = await downloadTelegramFile(bot, message.voice.file_id);
      if (result) {
        attachments.push({
          type: 'audio',
          mimeType: mime,
          filename: `voice_${message.voice.file_id}.ogg`,
          size: result.buffer.length,
          data: result.buffer,
        });
      }
    }
  }

  // Video
  if (message.video) {
    const mime = message.video.mime_type ?? 'video/mp4';
    // Videos are large — only download if under limit
    if (message.video.file_size && message.video.file_size <= MAX_FILE_SIZE) {
      const result = await downloadTelegramFile(bot, message.video.file_id);
      if (result) {
        attachments.push({
          type: 'video',
          mimeType: mime,
          filename: message.video.file_name ?? `video_${message.video.file_id}`,
          size: result.buffer.length,
          data: result.buffer,
        });
      }
    } else {
      // Too large — metadata only
      attachments.push({
        type: 'video',
        mimeType: mime,
        filename: message.video.file_name ?? `video_${message.video.file_id}`,
        size: message.video.file_size,
      });
    }
  }

  return attachments;
}
