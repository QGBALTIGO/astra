/**
 * WhatsApp Channel API (Baileys)
 *
 * Implements ChannelPluginAPI using @whiskeysockets/baileys.
 * Connects via WhatsApp Web's WebSocket protocol using QR code authentication.
 * No Meta Business account needed — works with personal WhatsApp accounts.
 *
 * Trust boundary: Baileys group-metadata has a loose metadata shape that does not declare isCommunity, isCommunityAnnounce, or linkedParent. The helpers below read those optional runtime fields without depending on Baileys' narrower TypeScript surface.
 */

import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  generateWAMessageFromContent,
  generateMessageIDV2,
  Browsers,
  type WASocket,
  type WAMessage,
  proto,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { randomInt } from 'node:crypto';
import pino from 'pino';
import {
  type ChannelPluginAPI,
  type ChannelConnectionStatus,
  type ChannelPlatform,
  type ChannelOutgoingMessage,
  type ChannelUser,
  type ChannelIncomingMessage,
  type ChannelAttachment,
  type ChannelMessageReceivedData,
  type ChannelConnectionEventData,
} from '@ownpilot/core/channels';
import { getEventBus, createEvent } from '@ownpilot/core/events';
import { ChannelEvents } from '@ownpilot/core/channels';
import { silentCatch } from '@ownpilot/core/utils';
import { getLog } from '../../../services/log.js';
import { getErrorMessage } from '../../../utils/common.js';
import { MAX_MESSAGE_CHAT_MAP_SIZE } from '../../../config/defaults.js';
import { splitMessage } from '../../utils/message-utils.js';
import { renderUrlButtonAsText } from '../../utils/url-button.js';
import { getSessionDir, clearSession } from './session-store.js';
import { buildWhatsAppCopyCodePayload } from './whatsapp-copy-code.js';
import { fetchWhatsAppProfilePicture } from './whatsapp-profile-picture.js';
import { wsGateway } from '../../../ws/server.js';
import { channelAssetStore } from '../../../services/channel-asset-store.js';
import { SimpleTTLCache } from '../../../utils/simple-ttl-cache.js';

const log = getLog('WhatsApp');
const WHATSAPP_MAX_LENGTH = 4096;
const RANDOM_UNIT_SCALE = 1_000_000_000;

function randomUnit(): number {
  return randomInt(RANDOM_UNIT_SCALE) / RANDOM_UNIT_SCALE;
}

function assertSendDeadline(deadline: Date | undefined): void {
  if (deadline && (!Number.isFinite(deadline.getTime()) || Date.now() >= deadline.getTime())) {
    throw new Error('WhatsApp message expired before sending');
  }
}

function metadataRecord(metadata: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata));
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** Anti-ban constants */
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_CONSECUTIVE_440 = 3;
/**
 * Time the connection must remain `open` before we trust it and reset the
 * consecutive-440 counter. A `conflict:replaced` (440) storm typically fires
 * within 5–15s of each reconnect, so 2 minutes gives a comfortable margin
 * for separating "we're actually stable" from "we briefly reconnected before
 * the next displace event."
 *
 * Trust boundary: Baileys group-metadata has a loose metadata shape that does not declare isCommunity, isCommunityAnnounce, or linkedParent. The casts below read those optional fields; the runtime object is documented upstream to have them when relevant. The cast is a documented trust boundary with the upstream type.
 */
const STABLE_CONNECTION_MS = 2 * 60_000;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 20; // max 20 messages per minute (global)
const RATE_LIMIT_PER_JID_MS = 3_000; // min 3s gap per recipient
const MESSAGE_CACHE_SIZE = 500; // getMessage cache for retry/decryption
const PROCESSED_MSG_IDS_CAP = 5000; // dedup cap for processedMsgIds (shared across upsert + history sync)
const SEND_RECONNECT_WAIT_MS = 15_000;

// Connection state machine
// disconnected → connecting → connected
//                      ↓
//                reconnecting ─┘ (temporary error)
//                      ↓
//                disconnected (permanent error or logout)
type WhatsAppInternalState =
  'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'reconnecting' | 'error';

// Baileys logger — silent in production to prevent leaking JIDs/message content
const baileysLogger = pino({
  level: process.env.NODE_ENV === 'production' ? 'silent' : 'warn',
}) as ReturnType<typeof pino>;

// ============================================================================
// Types
// ============================================================================

interface WhatsAppBaileysConfig {
  /** Own phone number in international format without + (e.g. 905551234567) */
  my_phone: string;
}

// ============================================================================
// Group/Chat Listing Types
// ============================================================================

interface WhatsAppGroupSummary {
  id: string;
  subject: string;
  description: string | null;
  participantCount: number;
  createdAt: number | null;
  owner: string | null;
  isAnnounceGroup: boolean;
  isLocked: boolean;
  isCommunity: boolean;
  isCommunityAnnounce: boolean;
  linkedParent: string | null;
}

interface WhatsAppGroupDetail extends WhatsAppGroupSummary {
  participants: Array<{
    jid: string;
    phone: string;
    isAdmin: boolean;
    isSuperAdmin: boolean;
  }>;
}

// ============================================================================
// WhatsApp Baileys API
// ============================================================================

export class WhatsAppChannelAPI implements ChannelPluginAPI {
  private sock: WASocket | null = null;
  private status: ChannelConnectionStatus = 'disconnected';
  private internalState: WhatsAppInternalState = 'disconnected';
  private readonly pluginId: string;
  private readonly config: WhatsAppBaileysConfig;
  private messageChatMap = new Map<string, string>();
  private sentMessageIds = new Set<string>();
  private qrCode: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private consecutive440Count = 0;
  /**
   * Deferred clear of consecutive440Count. The counter must only be reset
   * after the connection has been STABLE long enough to indicate the displace-
   * loop is actually over — otherwise a 440-storm with brief reconnects
   * between disconnects bypasses MAX_CONSECUTIVE_440 entirely because the
   * counter resets on every connect.
   */
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private currentOperation: Promise<void> | null = null;
  /** Invalidates asynchronous setup and callbacks when a connection is replaced. */
  private connectionGeneration = 0;
  /** Drain credentials and Signal-key writes before reopening/deleting auth. */
  private authWriteQueue: Promise<void> = Promise.resolve();
  private sessionCleanup: Promise<void> = Promise.resolve();
  private connectedAccountPhone: string | null = null;
  private preventAutoReconnect = false; // Set by logout() to stop auto-reconnect

  // Anti-ban: message cache for getMessage callback (retry/decryption)
  private messageCache = new Map<string, proto.IMessage>();

  // Anti-ban: rate limiting
  private globalSendTimes: number[] = [];
  private perJidLastSend = new Map<string, number>();
  /** Admit sends atomically so concurrent replies cannot bypass the limits. */
  private sendRateLimitQueue: Promise<void> = Promise.resolve();

  // Anti-ban: message deduplication (prevent double AI responses on reconnect)
  private processedMsgIds = new Set<string>();

  // Anti-ban: retry counter cache (prevents infinite retry loops — Evolution + WAHA pattern)
  private msgRetryCounterCache = new SimpleTTLCache<number>(300_000); // 5 min TTL
  // Anti-ban: device info cache (reduces protocol overhead — WAHA pattern)
  private userDevicesCache = new SimpleTTLCache<string[]>(300_000); // 5 min TTL

  // History sync tracking — promise queue serializes concurrent batches (Node.js can context-switch at await)
  private historySyncQueue: Promise<void> = Promise.resolve();
  private lastHistoryFetchTime: number | null = null;

  // Group listing cache (5 min TTL — prevents excessive groupFetchAllParticipating calls)
  private groupsCache: WhatsAppGroupSummary[] | null = null;
  private groupsRawParticipants: Map<string, Array<{ id: string; admin?: string | null }>> | null =
    null;
  private groupsCacheTime = 0;
  private groupsFetchInFlight: Promise<WhatsAppGroupSummary[]> | null = null;
  private static readonly GROUPS_CACHE_TTL = 5 * 60_000;

  constructor(config: Record<string, unknown>, pluginId: string) {
    this.pluginId = pluginId;
    // Normalize phone: strip all non-digit characters
    const raw = config.my_phone ? String(config.my_phone).replace(/\D/g, '') : '';
    this.config = { my_phone: raw };
    if (!raw) {
      log.debug(
        'WhatsApp: my_phone not configured — will auto-detect from sock.user.id on connect'
      );
    }
  }

  // ==========================================================================
  // ChannelPluginAPI — Required
  // ==========================================================================

  async connect(): Promise<void> {
    return this.connectInternal(false);
  }

  private async connectInternal(automatic: boolean): Promise<void> {
    const requestedGeneration = this.connectionGeneration;
    // State machine guard: prevent concurrent operations
    if (this.currentOperation) {
      log.debug('WhatsApp connect() waiting for current operation to complete...');
      try {
        await this.currentOperation;
      } catch {
        // Previous operation failed, continue with new connect attempt
      }
    }

    // A disconnect/logout requested while setup was pending takes precedence.
    if (requestedGeneration !== this.connectionGeneration) return;
    if (automatic && this.preventAutoReconnect) return;

    // If already connected or connecting, nothing to do
    if (this.internalState === 'connected' || this.internalState === 'connecting') {
      log.debug(`WhatsApp connect() skipped — already ${this.internalState}`);
      return;
    }

    if (!automatic) {
      this.preventAutoReconnect = false;
      this.reconnectAttempt = 0;
      this.consecutive440Count = 0;
    }

    // Create new operation promise. A later logout may replace currentOperation.
    const operation = this.doConnect(++this.connectionGeneration);
    this.currentOperation = operation;
    try {
      await operation;
    } finally {
      if (this.currentOperation === operation) this.currentOperation = null;
    }
  }

  private async doConnect(generation: number): Promise<void> {
    // Final state check before proceeding
    if (this.internalState === 'connected' || this.internalState === 'connecting') {
      return;
    }

    // Clean up any existing socket
    this.cleanupSocket();
    this.clearReconnectTimer();

    this.internalState = 'connecting';
    this.status = 'connecting';
    this.emitConnectionEvent('connecting');
    log.info('WhatsApp connecting...');

    try {
      await this.sessionCleanup;
      await this.authWriteQueue;
      if (generation !== this.connectionGeneration) return;
      const sessionDir = getSessionDir(this.pluginId);
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      if (generation !== this.connectionGeneration) return;
      const { version } = await fetchLatestBaileysVersion();
      if (generation !== this.connectionGeneration) return;

      const authKeys: typeof state.keys = {
        ...state.keys,
        set: (data) => {
          // Retired Baileys tasks must not recreate keys after logout/new QR.
          if (generation !== this.connectionGeneration) return Promise.resolve();
          return this.queueAuthWrite(() => state.keys.set(data));
        },
      };

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(authKeys, baileysLogger),
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        // Anti-ban: realistic browser fingerprint (matches actual OS)
        browser: Browsers.appropriate('Chrome'),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        // History sync: accept all passive sync messages (Evolution API + WAHA pattern)
        // REQUIRED for messaging-history.set to fire (GitHub Issue #1934)
        shouldSyncHistoryMessage: () => true,
        // Anti-ban: don't appear online 24/7 (bot signal)
        markOnlineOnConnect: false,
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 30_000,
        retryRequestDelayMs: 350,
        maxMsgRetryCount: 4,
        // Anti-ban: retry counter prevents infinite retry loops (Evolution + WAHA pattern)
        msgRetryCounterCache: this.msgRetryCounterCache as never,
        // Anti-ban: cache device info to reduce protocol overhead
        userDevicesCache: this.userDevicesCache as never,
        // Anti-ban: Signal key store transaction retry (Evolution API pattern)
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
        // getMessage is REQUIRED in Baileys 7.x for message retry/decryption.
        // Without it, messages.upsert may never fire.
        // Returns cached message or undefined (NEVER empty string — would signal "found but empty").
        getMessage: async (key) => {
          const cached = this.messageCache.get(key.id ?? '');
          if (cached) {
            log.debug('[getMessage] Cached message available for protocol retry');
            return cached;
          }
          log.debug('[getMessage] Message unavailable in protocol retry cache');
          return undefined;
        },
      });
      this.sock = sock;
      const isCurrentSocket = () => this.sock === sock && generation === this.connectionGeneration;

      // Handle connection updates (QR code, connect, disconnect)
      sock.ev.on('connection.update', (update) => {
        if (!isCurrentSocket()) return;
        this.handleConnectionUpdate(update);
      });

      // Receive inbound direct messages from other contacts only in explicit multi-user mode.
      sock.ev.on('messages.upsert', (upsert) => {
        if (!isCurrentSocket()) return;
        log.info(
          `[WhatsApp] UPSERT EVENT received — type: ${upsert.type}, count: ${upsert.messages.length}`
        );

        // Cache ALL messages for getMessage retry/decryption (both append and notify)
        for (const msg of upsert.messages) {
          if (msg.key.id && msg.message) {
            this.cacheMessage(msg.key.id, msg.message);
          }
        }

        if (upsert.type !== 'notify') return;
        for (const msg of upsert.messages) {
          log.debug('[WhatsApp] Processing message', { fromMe: msg.key.fromMe === true });

          // Anti-ban: deduplication — skip already-processed messages (reconnect replays)
          const msgId = msg.key.id;
          if (msgId && this.processedMsgIds.has(msgId)) {
            log.debug('[WhatsApp] Skipping duplicate message');
            continue;
          }

          const effectiveJid = this.resolveIncomingJid(msg.key);
          const isSelf = this.isSelfChat(effectiveJid);
          const isInboundDM = effectiveJid?.endsWith('@s.whatsapp.net') && !msg.key.fromMe;
          const acceptsGuest = process.env.ASTRA_WHATSAPP_MULTIUSER === 'true' && isInboundDM;
          if (!isSelf && !acceptsGuest) {
            log.debug('[WhatsApp] Skipping message outside authorized DM handling');
            continue;
          }
          // Never answer the connected account's outgoing messages to third parties.
          if (msg.key.fromMe && !isSelf) continue;
          // In self-chat, skip messages the bot sent (prevent infinite loop)
          if (msg.key.id && this.sentMessageIds.has(msg.key.id)) continue;

          // Track as processed BEFORE handling (idempotency)
          if (msgId) {
            this.processedMsgIds.add(msgId);
            // Cap the set to prevent memory leak
            if (this.processedMsgIds.size > PROCESSED_MSG_IDS_CAP) {
              const first = this.processedMsgIds.values().next().value;
              if (first !== undefined) this.processedMsgIds.delete(first);
            }
          }

          this.handleIncomingMessage(msg, sock, generation).catch((err) => {
            log.error('Failed to handle WhatsApp message:', err);
          });
        }
      });

      // Save credentials on update
      sock.ev.on('creds.update', () => {
        if (!isCurrentSocket()) return;
        void this.queueAuthWrite(saveCreds).catch(() => undefined);
      });

      // Handle passive history sync (WhatsApp sends past messages on first connect)
      // Uses promise queue to serialize concurrent batches (Baileys can fire multiple events rapidly)
      sock.ev.on(
        'messaging-history.set',
        ({ messages, chats, contacts, syncType, progress, isLatest }) => {
          if (!isCurrentSocket()) return;
          this.historySyncQueue = this.historySyncQueue.then(async () => {
            if (!isCurrentSocket()) return;
            try {
              const syncTypeName =
                syncType != null
                  ? (proto.HistorySync.HistorySyncType[syncType] ?? String(syncType))
                  : 'unknown';
              log.info(
                `[WhatsApp] History sync received — type: ${syncTypeName}, messages: ${messages.length}, chats: ${chats?.length ?? 0}, contacts: ${contacts?.length ?? 0}, progress: ${progress ?? 'N/A'}%, isLatest: ${isLatest ?? 'N/A'}`
              );

              if (messages.length === 0) {
                log.info('[WhatsApp] History sync batch empty — skipping');
                return;
              }

              const { ChannelMessagesRepository } =
                await import('../../../db/repositories/channels/messages.js');
              if (!isCurrentSocket()) return;
              const messagesRepo = new ChannelMessagesRepository();

              // Transform WAMessage[] to DB rows
              const rows: Array<Parameters<typeof messagesRepo.createBatch>[0][number]> = [];

              for (const msg of messages) {
                const remoteJid = this.resolveIncomingJid(msg.key);
                if (!remoteJid) continue;

                const isGroup = remoteJid.endsWith('@g.us');
                const isDM = remoteJid.endsWith('@s.whatsapp.net');
                if (!isDM && !isGroup) continue;

                // Skip protocol/stub messages (Baileys isRealMessage pattern — WAHA best practice)
                if (msg.messageStubType != null && !msg.message) continue;

                // Skip our own outbound messages (except self-chat)
                const isSelf = this.isSelfChat(remoteJid);
                if (!isSelf) continue;

                const messageId = msg.key.id ?? '';
                if (!messageId) continue;

                // Extract text content
                const m = msg.message;
                let text = '';
                if (m?.conversation) text = m.conversation;
                else if (m?.extendedTextMessage?.text) text = m.extendedTextMessage.text;
                else if (m?.imageMessage?.caption) text = m.imageMessage.caption;
                else if (m?.videoMessage?.caption) text = m.videoMessage.caption;
                else if (m?.documentMessage?.caption) text = m.documentMessage.caption;

                // Skip empty messages (no text, no recognizable content)
                if (
                  !text &&
                  !m?.imageMessage &&
                  !m?.audioMessage &&
                  !m?.videoMessage &&
                  !m?.documentMessage
                )
                  continue;
                if (!text) text = '[Attachment]';

                const participantJid = isGroup ? (msg.key.participant ?? '') : remoteJid;
                const phone = this.phoneFromJid(participantJid || remoteJid);

                // Parse timestamp (handles number, protobuf Long, and BigInt)
                const rawTs = msg.messageTimestamp;
                let timestamp: Date;
                if (typeof rawTs === 'number') {
                  timestamp = new Date(rawTs * 1000);
                } else if (typeof rawTs === 'bigint') {
                  timestamp = new Date(Number(rawTs) * 1000);
                } else if (typeof rawTs === 'object' && rawTs !== null && 'toNumber' in rawTs) {
                  timestamp = new Date((rawTs as { toNumber(): number }).toNumber() * 1000);
                } else {
                  // No valid timestamp — skip message (bad data is worse than missing data)
                  log.warn('[WhatsApp] History sync: skipping message without a valid timestamp');
                  continue;
                }

                rows.push({
                  id: `${this.pluginId}:${messageId}`,
                  channelId: this.pluginId,
                  externalId: messageId,
                  direction: msg.key.fromMe ? ('outbound' as const) : ('inbound' as const),
                  senderId: phone,
                  senderName: msg.pushName || phone,
                  content: text,
                  contentType:
                    m?.imageMessage || m?.audioMessage || m?.videoMessage || m?.documentMessage
                      ? 'attachment'
                      : 'text',
                  metadata: {
                    platformMessageId: messageId,
                    jid: remoteJid,
                    isGroup,
                    pushName: msg.pushName || undefined,
                    ...(isGroup && participantJid ? { participant: participantJid } : {}),
                    historySync: true,
                    syncType: syncTypeName,
                  },
                  createdAt: timestamp,
                });

                // Seed processedMsgIds to prevent double-processing on reconnect
                if (messageId) {
                  this.processedMsgIds.add(messageId);
                  if (this.processedMsgIds.size > PROCESSED_MSG_IDS_CAP) {
                    const first = this.processedMsgIds.values().next().value;
                    if (first !== undefined) this.processedMsgIds.delete(first);
                  }
                }

                // NOTE: Do NOT seed messageCache from history — it wastes cache slots
                // that real-time getMessage retry needs. History messages are already delivered.
              }

              if (rows.length > 0) {
                const inserted = await messagesRepo.createBatch(rows);
                log.info(
                  `[WhatsApp] History sync saved ${inserted}/${rows.length} messages to DB (type: ${syncTypeName})`
                );
              } else {
                log.info('[WhatsApp] History sync — no processable messages in batch');
              }
            } catch (err) {
              log.error('[WhatsApp] History sync failed:', err);
            }
          });
        }
      );

      log.info('WhatsApp socket created, waiting for authentication...');
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      this.cleanupSocket();
      this.internalState = 'error';
      this.status = 'error';
      this.emitConnectionEvent('error');
      throw new Error(`Failed to connect WhatsApp: ${getErrorMessage(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    // Soft disconnect: tear down the socket but keep session files so the
    // next explicit connect() can resume without a fresh QR. Invalidate any
    // setup that is still awaiting auth/version discovery as well as callbacks.
    this.connectionGeneration++;
    this.preventAutoReconnect = true;
    this.clearReconnectTimer();
    this.cleanupSocket();

    this.qrCode = null;
    this.reconnectAttempt = 0;
    this.internalState = 'disconnected';
    this.status = 'disconnected';
    this.emitConnectionEvent('disconnected');
    // Graceful shutdown must not exit while accepted auth writes are pending.
    await this.authWriteQueue;
    log.info('WhatsApp disconnected (session preserved — reconnect without QR)');
  }

  /**
   * Logout: disconnect AND clear session files.
   * Next connect() will require a fresh QR code scan.
   * NO auto-reconnect after logout.
   */
  async logout(): Promise<void> {
    // CRITICAL: Set flag to prevent auto-reconnect
    this.preventAutoReconnect = true;
    this.connectionGeneration++;
    this.clearReconnectTimer();
    this.internalState = 'disconnecting';
    this.status = 'disconnected';
    this.qrCode = null;

    const pendingOperation = this.currentOperation;
    const operation = this.doLogout(pendingOperation);
    this.currentOperation = operation;
    try {
      await operation;
    } finally {
      if (this.currentOperation === operation) this.currentOperation = null;
    }
  }

  private async doLogout(pendingOperation: Promise<void> | null): Promise<void> {
    // In-flight setup has been invalidated. Wait for it to stop before removing
    // auth files, and make subsequent connect() calls wait for this operation.
    await pendingOperation?.catch(() => undefined);

    // Properly logout from WhatsApp servers
    if (this.sock) {
      try {
        // Use Baileys logout which properly terminates the session
        await this.sock.logout();
        log.info('WhatsApp logout() called on socket');
      } catch (err) {
        // logout may fail if already disconnected — that's fine
        log.debug('WhatsApp logout() failed or already disconnected:', err);
      }
    }

    // Clean up socket and listeners
    this.cleanupSocket();

    // Clear local session files
    try {
      await this.queueSessionCleanup();
      log.info('WhatsApp session files cleared');
    } catch (err) {
      log.warn('Failed to clear WhatsApp session files:', err);
    }

    // Reset all state
    this.qrCode = null;
    this.reconnectAttempt = 0;
    this.consecutive440Count = 0;
    this.clearAccountCaches();
    this.connectedAccountPhone = null;
    this.config.my_phone = '';
    this.internalState = 'disconnected';
    this.status = 'disconnected';
    // Only an explicit connect() can re-enable automatic reconnect after logout.
    this.emitConnectionEvent('disconnected');
    log.info('WhatsApp logged out (session cleared — new QR scan required)');
  }

  async sendMessage(message: ChannelOutgoingMessage): Promise<string> {
    assertSendDeadline(message.sendBefore);
    if (message.copyCode && (message.urlButton || message.attachments?.length)) {
      throw new Error('WhatsApp copy-code messages cannot contain other actions or attachments');
    }
    const copyPayload = message.copyCode
      ? buildWhatsAppCopyCodePayload(message.text, message.copyCode)
      : undefined;
    // Replies already being prepared may outlive a temporary transport outage.
    // Wait only before sending, for the same authenticated account, and never
    // retry sendMessage itself: a failed send may already have been delivered.
    const accountPhone = this.connectedAccountPhone;
    if (!accountPhone) {
      throw new Error('WhatsApp is not connected');
    }
    const recoveryDeadline = Math.min(
      Date.now() + SEND_RECONNECT_WAIT_MS,
      message.sendBefore?.getTime() ?? Infinity
    );
    await this.waitForConnectedAccount(accountPhone, recoveryDeadline);

    const jid = this.toJid(message.platformChatId);
    if (copyPayload && !/^\d{7,15}@s\.whatsapp\.net$/.test(jid)) {
      throw new Error('WhatsApp copy-code messages require an individual phone number');
    }
    const isSelf = this.isSelfChat(jid);
    // URL actions retain their text-link path. Copy-code messages use the
    // native-flow relay below; neither path retries a possibly delivered CTA.
    const parts = splitMessage(renderUrlButtonAsText(message), WHATSAPP_MAX_LENGTH);
    let lastMessageId = '';

    for (let i = 0; i < parts.length; i++) {
      const options: Record<string, unknown> = {};

      // Reply context for first part — include fromMe flag so Baileys can locate
      // the original message in the correct direction (critical for self-chat)
      if (i === 0 && message.replyToId) {
        const externalId = message.replyToId.includes(':')
          ? message.replyToId.split(':').pop()
          : message.replyToId;
        if (externalId) {
          options.quoted = {
            key: { remoteJid: jid, id: externalId, fromMe: isSelf },
            message: {},
          };
        }
      }

      // Typing is shown while the AI is working through sendTyping(). Once the
      // reply is ready, do not add an artificial 1–6s delay. Transport throttles
      // still apply, including to concurrent sends and ambiguous failures.
      const sock = await this.acquireSendSlot(
        jid,
        accountPhone,
        recoveryDeadline,
        message.sendBefore
      );
      if (sock !== this.sock || this.status !== 'connected') {
        throw new Error('WhatsApp disconnected before sending');
      }
      assertSendDeadline(message.sendBefore);

      if (copyPayload) {
        const userJid = sock.user?.id;
        if (!userJid) throw new Error('WhatsApp account unavailable before sending');
        const generated = generateWAMessageFromContent(jid, copyPayload.content, {
          ...options,
          userJid,
          messageId: generateMessageIDV2(userJid),
        });
        const messageId = generated.key.id;
        if (!messageId || !generated.message) {
          throw new Error('WhatsApp copy-code message could not be prepared');
        }
        // Remember before relay: a self-chat echo may arrive before its receipt.
        // Cache the exact protocol for same-ID decryption retries, never resend
        // a possibly delivered OTP as a new text message after a relay failure.
        this.rememberSentMessage(messageId);
        this.cacheMessage(messageId, generated.message);
        assertSendDeadline(message.sendBefore);
        await sock.relayMessage(jid, generated.message, {
          ...copyPayload.relayOptions,
          messageId,
        });
        lastMessageId = messageId;
      } else {
        const result = await sock.sendMessage(
          jid,
          // CTA URLs are already usable as links; avoid an unnecessary preview fetch.
          message.urlButton ? { text: parts[i]!, linkPreview: null } : { text: parts[i]! },
          options
        );
        lastMessageId = result?.key?.id ?? '';
      }

      if (lastMessageId) {
        this.trackMessage(lastMessageId, message.platformChatId);
        // Track our own sent messages to avoid self-chat loops
        this.rememberSentMessage(lastMessageId);
      }

      // Small delay between split messages
      if (i < parts.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // Anti-ban: go offline after sending (don't stay 'available' like a bot)
    // Only relevant for non-self-chat (self-chat has no presence observers)
    if (!isSelf) {
      try {
        void this.sock?.sendPresenceUpdate('unavailable').catch(() => undefined);
      } catch {
        // Non-fatal
      }
    }

    return lastMessageId;
  }

  getStatus(): ChannelConnectionStatus {
    return this.status;
  }

  getPlatform(): ChannelPlatform {
    return 'whatsapp';
  }

  // ==========================================================================
  // ChannelPluginAPI — Optional
  // ==========================================================================

  async sendTyping(platformChatId: string): Promise<void> {
    const sock = this.sock;
    if (!sock || this.status !== 'connected') return;
    try {
      const jid = this.toJid(platformChatId);
      if (this.isSelfChat(jid)) return;
      // Presence is cosmetic: a slow presence acknowledgement must not delay
      // the request entering the AI pipeline or the eventual response.
      void sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
    } catch {
      // Non-fatal
    }
  }

  /** Fetch the current customer's profile image only when requested by the portal. */
  async resolveUser(platformUserId: string): Promise<ChannelUser | null> {
    if (!/^\d{7,15}$/.test(platformUserId)) return null;
    const sock = this.sock;
    const generation = this.connectionGeneration;
    const accountPhone = this.connectedAccountPhone;
    if (!sock || !accountPhone || this.status !== 'connected') return null;
    const isCurrent = () =>
      this.sock === sock &&
      this.connectionGeneration === generation &&
      this.status === 'connected' &&
      this.connectedAccountPhone === accountPhone &&
      Boolean(sock.user?.id) &&
      this.phoneFromJid(sock.user!.id) === accountPhone;
    if (!isCurrent()) return null;
    const avatarUrl = await fetchWhatsAppProfilePicture(
      sock,
      this.toJid(platformUserId),
      isCurrent
    );
    if (!avatarUrl || !isCurrent()) return null;
    return { platform: 'whatsapp', platformUserId, displayName: platformUserId, avatarUrl };
  }

  getBotInfo(): { username?: string; firstName?: string } | null {
    // Try live sock.user first, fall back to configured my_phone
    const phone = this.sock?.user?.id
      ? this.phoneFromJid(this.sock.user.id)
      : this.status === 'connected'
        ? null
        : this.config.my_phone || null;
    if (!phone) return null;
    return {
      username: phone,
      firstName: this.sock?.user?.name ?? undefined,
    };
  }

  // ==========================================================================
  // QR Code — used by channels route for QR display
  // ==========================================================================

  /** Get the current QR code string (null if not in QR state). */
  getQrCode(): string | null {
    return this.qrCode;
  }

  // ==========================================================================
  // Group/Chat Listing — Extended API (duck-type guard accessed)
  // ==========================================================================

  /**
   * List all WhatsApp groups the account participates in.
   * Uses groupFetchAllParticipating() — ONE safe Baileys call.
   * Results cached for 5 minutes to prevent excessive WhatsApp API calls.
   * Profile pictures deliberately omitted (Evolution API bottleneck: 69 sequential calls).
   */
  async listGroups(
    includeParticipants = false
  ): Promise<WhatsAppGroupSummary[] | WhatsAppGroupDetail[]> {
    const sock = this.sock;
    if (!sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }

    // Return cache if valid and participants not requested
    const cacheAge = Date.now() - this.groupsCacheTime;
    if (
      !includeParticipants &&
      this.groupsCache &&
      cacheAge < WhatsAppChannelAPI.GROUPS_CACHE_TTL
    ) {
      return this.groupsCache;
    }

    // Deduplicate concurrent requests — reuse in-flight promise (anti-ban: prevents double API call)
    if (!this.groupsFetchInFlight) {
      this.groupsFetchInFlight = (async () => {
        try {
          const raw = await sock.groupFetchAllParticipating();
          const groups = Object.values(raw);

          const summaries: WhatsAppGroupSummary[] = groups.map((g) => {
            const ext = metadataRecord(g);
            return {
              id: g.id,
              subject: g.subject ?? '',
              description: g.desc ?? null,
              participantCount: g.participants?.length ?? 0,
              createdAt: g.creation ?? null,
              owner: g.owner ? this.normalizeJid(g.owner) : null,
              isAnnounceGroup: g.announce ?? false,
              isLocked: g.restrict ?? false,
              isCommunity: ext.isCommunity === true,
              isCommunityAnnounce: ext.isCommunityAnnounce === true,
              linkedParent: optionalString(ext, 'linkedParent'),
            };
          });

          // Only update cache if socket is still the same (guards against stale write after disconnect)
          if (this.sock === sock) {
            this.groupsCache = summaries;
            this.groupsCacheTime = Date.now();
            // Cache raw participants for includeParticipants=true requests within same TTL window
            this.groupsRawParticipants = new Map(
              groups.map((g) => [
                g.id,
                (g.participants ?? []).map((p) => ({ id: p.id, admin: p.admin })),
              ])
            );
          }

          return summaries;
        } finally {
          if (this.sock === sock) this.groupsFetchInFlight = null;
        }
      })();
    }

    const summaries = await this.groupsFetchInFlight;

    if (!includeParticipants) return summaries;

    // Build detail from cached summaries + cached raw participants (single fetch, no double API call)
    return summaries.map((s) => {
      const rawParticipants = this.groupsRawParticipants?.get(s.id) ?? [];
      return {
        ...s,
        participants: rawParticipants.map((p) => ({
          jid: this.normalizeJid(p.id),
          phone: this.phoneFromJid(p.id),
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          isSuperAdmin: p.admin === 'superadmin',
        })),
      };
    });
  }

  /**
   * Fetch message history for a specific group on-demand.
   * Uses Baileys fetchMessageHistory() — sends request to phone (must be online).
   * Result arrives async via messaging-history.set event (syncType = ON_DEMAND).
   */
  async fetchGroupHistory(groupJid: string, count = 50): Promise<string> {
    if (!groupJid.endsWith('@g.us')) {
      throw new Error('Invalid group JID: expected @g.us suffix');
    }

    const sock = this.sock;
    if (!sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }

    // Rate limit: max 1 call per 30 seconds (atomic check+set to prevent TOCTOU race)
    const now = Date.now();
    const lastFetch = this.lastHistoryFetchTime;
    this.lastHistoryFetchTime = now; // Set FIRST to block concurrent requests
    if (lastFetch && now - lastFetch < 30_000) {
      throw new Error('Rate limited — wait 30 seconds between history fetch requests');
    }

    // Use a minimal key to request from the beginning
    const sessionId = await sock.fetchMessageHistory(
      Math.min(count, 50), // Baileys max 50 per request
      { remoteJid: groupJid, fromMe: false, id: '' },
      0 // oldest timestamp = 0 means "from the beginning"
    );

    log.info(
      `[WhatsApp] On-demand history fetch requested — group: ${groupJid}, count: ${count}, sessionId: ${sessionId}`
    );
    return sessionId;
  }

  /**
   * Fetch full metadata for a single group by JID.
   * Uses groupMetadata() — one targeted Baileys call per invocation.
   */
  async getGroup(groupJid: string): Promise<WhatsAppGroupDetail> {
    if (!groupJid.endsWith('@g.us')) {
      throw new Error(`Invalid group JID: expected @g.us suffix`);
    }

    const sock = this.sock;
    if (!sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }

    const g = await sock.groupMetadata(groupJid);

    const ext = metadataRecord(g);
    return {
      id: g.id,
      subject: g.subject ?? '',
      description: g.desc ?? null,
      participantCount: g.participants?.length ?? 0,
      createdAt: g.creation ?? null,
      owner: g.owner ? this.normalizeJid(g.owner) : null,
      isAnnounceGroup: g.announce ?? false,
      isLocked: g.restrict ?? false,
      isCommunity: ext.isCommunity === true,
      isCommunityAnnounce: ext.isCommunityAnnounce === true,
      linkedParent: optionalString(ext, 'linkedParent'),
      participants: (g.participants ?? []).map((p) => ({
        jid: this.normalizeJid(p.id),
        phone: this.phoneFromJid(p.id),
        isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
        isSuperAdmin: p.admin === 'superadmin',
      })),
    };
  }

  // ==========================================================================
  // Message Tracking
  // ==========================================================================

  trackMessage(platformMessageId: string, chatId: string): void {
    if (this.messageChatMap.size >= MAX_MESSAGE_CHAT_MAP_SIZE) {
      const first = this.messageChatMap.keys().next().value;
      if (first !== undefined) this.messageChatMap.delete(first);
    }
    this.messageChatMap.set(platformMessageId, chatId);
  }

  // ==========================================================================
  // Private — Connection Handling
  // ==========================================================================

  /** Reset retry/conflict budgets only after a sustained healthy connection. */
  private scheduleStableConnectionReset(): void {
    this.clearStableConnectionTimer();
    const generation = this.connectionGeneration;
    this.stableConnectionTimer = setTimeout(() => {
      if (generation !== this.connectionGeneration || this.status !== 'connected') return;
      this.consecutive440Count = 0;
      this.reconnectAttempt = 0;
      this.stableConnectionTimer = null;
    }, STABLE_CONNECTION_MS);
    this.stableConnectionTimer.unref?.();
  }

  private clearStableConnectionTimer(): void {
    if (this.stableConnectionTimer) {
      clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = null;
    }
  }

  /** Safely close and clean up the current socket, removing all event listeners. */
  private cleanupSocket(): void {
    // Stable-reset timer is bound to the previous socket's lifetime.
    this.clearStableConnectionTimer();
    const sock = this.sock;
    // Invalidate callbacks before end(), which can itself emit a close event.
    this.sock = null;
    this.groupsCache = null;
    this.groupsRawParticipants = null;
    this.groupsCacheTime = 0;
    this.groupsFetchInFlight = null;
    this.historySyncQueue = Promise.resolve();
    if (sock) {
      try {
        // Remove all listeners first to prevent ghost events
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messaging-history.set');
      } catch {
        /* listeners may already be gone */
      }
      try {
        sock.end(undefined);
      } catch {
        /* already closed */
      }
    }
  }

  private queueSessionCleanup(): Promise<void> {
    this.sessionCleanup = this.sessionCleanup
      .catch(() => undefined)
      .then(() => this.authWriteQueue)
      .then(() => clearSession(this.pluginId));
    return this.sessionCleanup;
  }

  private queueAuthWrite(write: () => Promise<void> | void): Promise<void> {
    const operation = this.authWriteQueue.then(write);
    this.authWriteQueue = operation.catch((err) => {
      log.error('Failed to persist WhatsApp authentication state:', err);
    });
    return operation;
  }

  /** In-memory protocol data belongs to the connected account, not the plugin. */
  private clearAccountCaches(): void {
    this.messageChatMap.clear();
    this.sentMessageIds.clear();
    this.messageCache.clear();
    this.processedMsgIds.clear();
    this.globalSendTimes = [];
    this.perJidLastSend.clear();
    this.msgRetryCounterCache.flushAll();
    this.userDevicesCache.flushAll();
    this.lastHistoryFetchTime = null;
  }

  private handleConnectionUpdate(update: {
    connection?: string;
    lastDisconnect?: { error?: Error | undefined; date?: Date };
    qr?: string;
    isOnline?: boolean;
    isNewLogin?: boolean;
  }): void {
    const { connection, lastDisconnect, qr } = update;

    // QR code received — broadcast to UI
    if (qr) {
      this.qrCode = qr;
      this.internalState = 'connecting';
      this.status = 'connecting';
      log.info('WhatsApp QR code generated, waiting for scan...');

      // Broadcast QR to WebSocket clients
      try {
        wsGateway.broadcast('channel:qr', { channelId: this.pluginId, qr });
      } catch {
        // WS gateway may not be ready
      }
    }

    // Connected
    if (connection === 'open') {
      this.clearReconnectTimer();
      this.internalState = 'connected';
      this.status = 'connected';
      this.qrCode = null;
      this.preventAutoReconnect = false; // Reset on successful connection
      // Defer the consecutive-440 reset until the connection has been stable
      // long enough to trust it. Resetting immediately on `open` lets a
      // displace-storm bypass MAX_CONSECUTIVE_440 by reconnecting briefly
      // between each conflict:replaced event.
      this.scheduleStableConnectionReset();
      this.emitConnectionEvent('connected');

      // Anti-ban: immediately go offline — only appear online when typing/sending
      // (Evolution API + WAHA both do this). Presence-update failure is non-fatal
      // and Baileys will retry on the next presence cycle.
      this.sock
        ?.sendPresenceUpdate('unavailable')
        .catch(silentCatch('whatsapp.presenceUnavailable'));

      const sockPhone = this.sock?.user?.id ? this.phoneFromJid(this.sock.user.id) : '';
      // The authenticated account is authoritative, even after scanning a QR
      // with a different number. A stale configured number is not self-chat.
      if (sockPhone) {
        if (this.connectedAccountPhone && this.connectedAccountPhone !== sockPhone) {
          this.clearAccountCaches();
        }
        this.connectedAccountPhone = sockPhone;
        this.config.my_phone = sockPhone;
      }
      const info = this.getBotInfo();
      log.info('WhatsApp connected — authenticated account updated');

      // Broadcast status update
      try {
        wsGateway.broadcast('channel:status', {
          channelId: this.pluginId,
          status: 'connected',
          botInfo: info,
        });
      } catch {
        // WS gateway may not be ready
      }
    }

    // Disconnected
    if (connection === 'close') {
      this.connectionGeneration++;
      // Cancel any pending stable-connection reset — the connection didn't
      // last long enough to clear the consecutive440Count.
      this.clearReconnectTimer();
      this.cleanupSocket();
      const error = lastDisconnect?.error;
      const statusCode = (error as Boom)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      // Anti-ban: 403 (forbidden), 402, 406 are PERMANENT — reconnecting makes it worse
      const isPermanentDisconnect =
        isLoggedOut || statusCode === 403 || statusCode === 402 || statusCode === 406;

      // CRITICAL: Check if auto-reconnect is prevented (e.g., after logout())
      if (this.preventAutoReconnect) {
        log.info('WhatsApp connection closed but auto-reconnect is prevented (logout was called)');
        this.internalState = 'disconnected';
        this.status = 'disconnected';
        this.emitConnectionEvent('disconnected');
        return;
      }

      if (isPermanentDisconnect) {
        // Permanent disconnect — stop reconnect, need new QR or account action
        this.internalState = 'disconnected';
        this.status = 'disconnected';
        this.qrCode = null;
        this.preventAutoReconnect = true;
        this.emitConnectionEvent('disconnected');
        log.error(
          `WhatsApp permanently disconnected (code: ${statusCode}) — reconnect DISABLED to prevent ban escalation`
        );
        // Only a confirmed logout invalidates credentials. Forbidden/account
        // restrictions do not authorize destroying a possibly valid session.
        if (isLoggedOut) {
          this.clearAccountCaches();
          this.connectedAccountPhone = null;
          this.config.my_phone = '';
          this.queueSessionCleanup().catch((err) => {
            log.warn('Failed to clear stale WhatsApp session', { error: String(err) });
          });
        }
      } else {
        // Temporary disconnect — auto-reconnect with backoff
        this.internalState = 'reconnecting';
        this.status = 'reconnecting';
        this.emitConnectionEvent('reconnecting');
        const delay = this.scheduleReconnect(statusCode);
        if (delay !== null) {
          log.warn(
            `WhatsApp disconnected (code: ${statusCode}), reconnecting in ${Math.round(delay)}ms...`
          );
        }
      }
    }
  }

  private scheduleReconnect(statusCode?: number): number | null {
    this.clearReconnectTimer();

    // CRITICAL: Don't reconnect if prevented (e.g., after logout)
    if (this.preventAutoReconnect) {
      log.info('Auto-reconnect skipped — preventAutoReconnect flag is set');
      return null;
    }

    // Count replacements until the socket is stable. Interleaved transport
    // errors (e.g. 408) must not give a competing connection a fresh budget.
    if (statusCode === 440) {
      this.consecutive440Count++;
      if (this.consecutive440Count >= MAX_CONSECUTIVE_440) {
        log.error(
          `WhatsApp: ${MAX_CONSECUTIVE_440} repeated 440 errors — stopping reconnect until manual recovery`
        );
        this.preventAutoReconnect = true;
        this.internalState = 'error';
        this.status = 'error';
        this.emitConnectionEvent('error');
        return null;
      }
    }

    // Anti-ban: max reconnect attempts
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      log.error(`WhatsApp: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up`);
      this.preventAutoReconnect = true;
      this.internalState = 'error';
      this.status = 'error';
      this.emitConnectionEvent('error');
      return null;
    }

    // For 440 (connectionReplaced): use longer base delay to avoid reconnect storm
    const baseDelay =
      statusCode === DisconnectReason.restartRequired ? 500 : statusCode === 440 ? 10000 : 3000;
    const exponentialDelay = baseDelay * Math.pow(2, this.reconnectAttempt);
    // Anti-ban: add jitter (0.5x to 1.5x) to prevent synchronized reconnects
    const jitter = 0.5 + randomUnit();
    const delay = Math.min(exponentialDelay * jitter, 120_000);
    this.reconnectAttempt++;

    const generation = this.connectionGeneration;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Double-check flag before reconnecting
      if (
        this.preventAutoReconnect ||
        generation !== this.connectionGeneration ||
        this.internalState !== 'reconnecting'
      ) {
        log.info('Reconnect timer fired but auto-reconnect is prevented');
        return;
      }
      log.info(`WhatsApp reconnect attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}...`);
      // Clean up socket properly before reconnecting
      this.cleanupSocket();
      this.internalState = 'reconnecting';
      this.status = 'reconnecting';
      this.connectInternal(true).catch((err) => {
        log.error('WhatsApp reconnect failed:', err);
        if (this.preventAutoReconnect) return;
        this.internalState = 'reconnecting';
        this.status = 'reconnecting';
        this.emitConnectionEvent('reconnecting');
        this.scheduleReconnect();
      });
    }, delay);
    // unref so a pending reconnect timer doesn't hold the process open
    // during graceful shutdown — clearReconnectTimer() still runs.
    this.reconnectTimer.unref?.();
    return delay;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async waitForConnectedAccount(accountPhone: string, deadline: number): Promise<WASocket> {
    while (
      !this.preventAutoReconnect &&
      (this.status === 'reconnecting' || this.status === 'connecting') &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }

    const sock = this.sock;
    if (!sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected after waiting for recovery');
    }
    const currentPhone = sock.user?.id ? this.phoneFromJid(sock.user.id) : null;
    if (currentPhone !== accountPhone) {
      throw new Error('WhatsApp connected account changed while preparing to send');
    }
    return sock;
  }

  // ==========================================================================
  // Private — Outbound Rate Limiting
  // ==========================================================================

  /** Cache a message for getMessage retry/decryption. */
  private cacheMessage(id: string, message: proto.IMessage): void {
    if (this.messageCache.size >= MESSAGE_CACHE_SIZE) {
      const first = this.messageCache.keys().next().value;
      if (first !== undefined) this.messageCache.delete(first);
    }
    this.messageCache.set(id, message);
  }

  private rememberSentMessage(id: string): void {
    this.sentMessageIds.add(id);
    if (this.sentMessageIds.size > 500) {
      const first = this.sentMessageIds.values().next().value;
      if (first !== undefined) this.sentMessageIds.delete(first);
    }
  }

  private async downloadAttachmentData(msg: WAMessage): Promise<Uint8Array | undefined> {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      if (buffer instanceof Buffer) {
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      }
    } catch {
      // Download failed — metadata-only fallback
    }
    return undefined;
  }

  /** Enforce rate limits: global 20/min + per-JID 3s gap. Waits if needed. */
  private async enforceRateLimit(jid: string): Promise<void> {
    const now = Date.now();

    // Per-JID rate limit: min 3s between messages to same recipient
    const lastSend = this.perJidLastSend.get(jid);
    if (lastSend !== undefined) {
      const elapsed = now - lastSend;
      if (elapsed < RATE_LIMIT_PER_JID_MS) {
        const waitMs = RATE_LIMIT_PER_JID_MS - elapsed;
        log.debug('[RateLimit] Recipient throttle', { waitMs });
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    // Global rate limit: max 20 messages per minute
    // Clean old entries
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    this.globalSendTimes = this.globalSendTimes.filter((t) => t > cutoff);

    if (this.globalSendTimes.length >= RATE_LIMIT_MAX_MESSAGES) {
      const oldestInWindow = this.globalSendTimes[0]!;
      const waitMs = oldestInWindow + RATE_LIMIT_WINDOW_MS - Date.now();
      if (waitMs > 0) {
        log.info(
          `[RateLimit] Global throttle: waiting ${waitMs}ms (${this.globalSendTimes.length}/${RATE_LIMIT_MAX_MESSAGES} in window)`
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  private acquireSendSlot(
    jid: string,
    accountPhone: string,
    recoveryDeadline: number,
    sendBefore: Date | undefined
  ): Promise<WASocket> {
    const operation = this.sendRateLimitQueue.then(async () => {
      assertSendDeadline(sendBefore);
      await this.enforceRateLimit(jid);
      const sock = await this.waitForConnectedAccount(accountPhone, recoveryDeadline);
      assertSendDeadline(sendBefore);
      // Reserve before invoking transport: errors may still mean delivery, and
      // the next concurrent caller must see this attempt in the rate window.
      this.recordSend(jid);
      return sock;
    });
    this.sendRateLimitQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  /** Record a message send for rate limiting. */
  private recordSend(jid: string): void {
    const now = Date.now();
    this.globalSendTimes.push(now);
    this.perJidLastSend.set(jid, now);

    // Clean up old per-JID entries (keep max 100)
    if (this.perJidLastSend.size > 100) {
      const first = this.perJidLastSend.keys().next().value;
      if (first !== undefined) this.perJidLastSend.delete(first);
    }
  }

  // ==========================================================================
  // Private — Message Processing
  // ==========================================================================

  private async handleIncomingMessage(
    msg: WAMessage,
    sourceSocket = this.sock,
    generation = this.connectionGeneration
  ): Promise<void> {
    const isCurrentSocket = () =>
      this.sock === sourceSocket && generation === this.connectionGeneration;
    if (!isCurrentSocket()) return;
    log.debug('[WhatsApp] Handling incoming message');
    const remoteJid = this.resolveIncomingJid(msg.key);
    if (!remoteJid) return;

    // SAFETY: Only process DMs (@s.whatsapp.net) and groups (@g.us).
    // Skip: broadcasts (@broadcast), LID (@lid), newsletter (@newsletter), status (@s.whatsapp.net status)
    // NOTE: If LID resolution above is activated, @lid messages will be
    //   resolved to @s.whatsapp.net BEFORE this check, so they will pass through.
    const isGroup = remoteJid.endsWith('@g.us');
    const isDM = remoteJid.endsWith('@s.whatsapp.net');
    if (!isDM && !isGroup) {
      log.debug('[WhatsApp] Skipping non-chat message');
      return;
    }

    // Skip group messages where participant cannot be determined (guard BEFORE phone extraction)
    if (isGroup && !msg.key.participant) {
      log.debug('[WhatsApp] Skipping group message without a participant');
      return;
    }

    // For group messages, extract participant (individual sender) from msg.key.participant
    // For DMs, sender is derived from remoteJid
    const participantJid = isGroup ? msg.key.participant! : remoteJid;
    const phone = this.phoneFromJid(participantJid);

    if (!isGroup && !this.isSelfChat(remoteJid)) {
      // Only real inbound WhatsApp DMs can create a customer conversation.
      // A manual outgoing message from the connected number must not trigger the AI.
      if (process.env.ASTRA_WHATSAPP_MULTIUSER !== 'true' || msg.key.fromMe) {
        log.debug('[WhatsApp] Skipping non-self or outgoing DM');
        return;
      }
      // A phone number must be resolvable; never treat a temporary LID as an account.
      if (!/^[1-9][0-9]{9,14}$/.test(phone)) {
        log.warn('[WhatsApp] Ignoring DM with unresolved phone identity');
        return;
      }
    }

    // Extract message content
    const m = msg.message;
    if (!m) return;

    let text = '';
    const attachments: ChannelAttachment[] = [];

    // Text messages
    if (m.conversation) {
      text = m.conversation;
    } else if (m.extendedTextMessage?.text) {
      text = m.extendedTextMessage.text;
    }
    // Image messages
    else if (m.imageMessage) {
      text = m.imageMessage.caption ?? '';
      const data = await this.downloadAttachmentData(msg);
      attachments.push({
        type: 'image',
        mimeType: m.imageMessage.mimetype ?? 'image/jpeg',
        data,
      });
    }
    // Document messages
    else if (m.documentMessage) {
      text = m.documentMessage.caption ?? '';
      const data = await this.downloadAttachmentData(msg);
      attachments.push({
        type: 'file',
        mimeType: m.documentMessage.mimetype ?? 'application/octet-stream',
        filename: m.documentMessage.fileName ?? undefined,
        data,
      });
    }
    // Audio messages — download binary for auto-transcription
    else if (m.audioMessage) {
      const audioData = await this.downloadAttachmentData(msg);
      attachments.push({
        type: 'audio',
        mimeType: m.audioMessage.mimetype ?? 'audio/ogg',
        data: audioData,
      });
    }
    // Video messages
    else if (m.videoMessage) {
      text = m.videoMessage.caption ?? '';
      const data = await this.downloadAttachmentData(msg);
      attachments.push({
        type: 'video',
        mimeType: m.videoMessage.mimetype ?? 'video/mp4',
        data,
      });
    }

    // Skip empty messages
    if (!text && attachments.length === 0) return;

    const messageId = msg.key.id ?? '';

    if (!isCurrentSocket()) return;

    if (attachments.length > 0) {
      const platformChatId = isGroup ? remoteJid : phone;
      attachments.splice(
        0,
        attachments.length,
        ...(await channelAssetStore.persistIncomingAttachments({
          messageId: `${this.pluginId}:${messageId}`,
          channelPluginId: this.pluginId,
          platform: 'whatsapp',
          platformChatId,
          attachments,
        }))
      );
    }

    const sender: ChannelUser = {
      platformUserId: phone,
      platform: 'whatsapp',
      displayName: msg.pushName || phone,
      username: phone,
    };

    if (!isCurrentSocket()) return;

    const rawTs = msg.messageTimestamp;
    const timestamp =
      typeof rawTs === 'number'
        ? new Date(rawTs * 1000)
        : typeof rawTs === 'object' && rawTs !== null && 'toNumber' in rawTs
          ? new Date((rawTs as { toNumber(): number }).toNumber() * 1000)
          : new Date();

    const channelMessage: ChannelIncomingMessage = {
      id: `${this.pluginId}:${messageId}`,
      channelPluginId: this.pluginId,
      platform: 'whatsapp',
      // For groups: platformChatId = group JID; for DMs: phone number
      platformChatId: isGroup ? remoteJid : phone,
      sender,
      text: text || (attachments.length > 0 ? '[Attachment]' : ''),
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp,
      metadata: {
        platformMessageId: messageId,
        jid: remoteJid,
        isGroup,
        // Origin is trusted Baileys metadata, not the content of the message.
        isSelfChat: !isGroup && this.isSelfChat(remoteJid),
        fromMe: msg.key.fromMe === true,
        pushName: msg.pushName || undefined,
        // For groups: store participant JID so we know who sent it
        ...(isGroup && { participant: participantJid }),
      },
    };

    this.trackMessage(messageId, phone);

    try {
      const eventBus = getEventBus();
      eventBus.emit(
        createEvent<ChannelMessageReceivedData>(
          ChannelEvents.MESSAGE_RECEIVED,
          'channel',
          this.pluginId,
          { message: channelMessage }
        )
      );
      log.info('[msg] Dispatched to pipeline', {
        textLength: text.length,
        attachmentCount: attachments.length,
      });
    } catch (err) {
      log.error('Failed to emit WhatsApp message event:', err);
    }
  }

  // ==========================================================================
  // Private — Helpers
  // ==========================================================================

  /** Convert a phone number or chat ID to a WhatsApp JID. */
  private toJid(chatId: string): string {
    if (chatId.includes('@')) return chatId;
    // Strip any non-digit characters for phone numbers
    const cleaned = chatId.replace(/[^0-9]/g, '');
    return `${cleaned}@s.whatsapp.net`;
  }

  /** Extract phone number from a WhatsApp JID. */
  private phoneFromJid(jid: string): string {
    return jid.split('@')[0]?.split(':')[0] ?? jid;
  }

  /**
   * Resolve incoming Baileys JIDs.
   * Prefer remoteJidAlt when WhatsApp sends a temporary @lid identifier.
   */
  private resolveIncomingJid(key: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
  }): string | null {
    const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : null;
    if (!remoteJid) return null;
    if (!remoteJid.endsWith('@lid')) return remoteJid;

    const altJid = typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : null;
    if (altJid && altJid.endsWith('@s.whatsapp.net')) {
      log.debug('[WhatsApp] Resolved temporary contact identity');
      return altJid;
    }

    return remoteJid;
  }

  /**
   * Normalize a WhatsApp JID by stripping device suffix.
   * "15551234567:3@s.whatsapp.net" -> "15551234567@s.whatsapp.net"
   */
  private normalizeJid(jid: string): string {
    if (!jid || !jid.includes(':')) return jid;
    const [userPart, domain] = jid.split('@');
    if (!domain) return jid;
    const phone = userPart!.split(':')[0]!;
    return `${phone}@${domain}`;
  }

  /** Check if a message is sent to the user's own chat (self-chat). */
  private isSelfChat(remoteJid: string | null | undefined): boolean {
    if (!remoteJid?.endsWith('@s.whatsapp.net')) return false;
    const chatPhone = this.phoneFromJid(remoteJid);

    // Primary: compare against live sock.user.id
    // sock.user.id format: "905551234567:0@s.whatsapp.net" or "905551234567@s.whatsapp.net"
    // Use phoneFromJid to safely strip both "@..." and ":..." suffixes
    if (this.sock) {
      if (!this.sock.user?.id) return false;
      const ownPhone = this.phoneFromJid(this.sock.user.id);
      return ownPhone === chatPhone;
    }

    // Fallback: compare against configured my_phone
    if (this.config.my_phone) {
      return this.config.my_phone === chatPhone;
    }

    return false;
  }

  private emitConnectionEvent(status: ChannelConnectionStatus): void {
    try {
      const eventBus = getEventBus();
      const eventName =
        status === 'connecting'
          ? ChannelEvents.CONNECTING
          : status === 'connected'
            ? ChannelEvents.CONNECTED
            : status === 'reconnecting'
              ? ChannelEvents.RECONNECTING
              : status === 'error'
                ? ChannelEvents.ERROR
                : ChannelEvents.DISCONNECTED;

      eventBus.emit(
        createEvent<ChannelConnectionEventData>(eventName, 'channel', this.pluginId, {
          channelPluginId: this.pluginId,
          platform: 'whatsapp',
          status,
        })
      );
    } catch {
      // EventBus may not be ready during early boot
    }
  }
}
