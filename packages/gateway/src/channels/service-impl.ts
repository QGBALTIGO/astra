/**
 * ChannelServiceImpl
 *
 * Concrete implementation of IChannelService for the gateway.
 * Discovers channel plugins from PluginRegistry, routes messages
 * through EventBus, handles verification, and manages sessions.
 *
 * Trust boundary: Channel plugin responses are normalised via per-plugin normalizers before reaching this code; the casts below adapt the normalised shape to the canonical channel-event type. The normalizer is the trust boundary.
 */

import { timingSafeEqual } from 'node:crypto';
import { InboundFloodGuard } from './flood-guard.js';
import { GreetingBurstGuard } from './greeting-burst-guard.js';
import { dashboardActionForConfirmedReply } from './channel-dashboard-action.js';
import { maybePersonalizeConfirmedReply } from './confirmed-reply-personality.js';
import {
  type IChannelService,
  type ChannelOutgoingMessage,
  type ChannelPlatform,
  type ChannelPluginAPI,
  type ChannelPluginInfo,
  type ChannelIncomingMessage,
  type ChannelPluginManifest,
  type ChannelMessageReceivedData,
  type ChannelUserVerifiedData,
  type ChannelUserPendingData,
  type ChannelUserFirstSeenData,
} from '@ownpilot/core/channels';
import { getEventBus, createEvent } from '@ownpilot/core/events';
import { ChannelEvents } from '@ownpilot/core/channels';
import type { PluginRegistry, Plugin } from '@ownpilot/core/plugins';
import {
  hasSessionService,
  getSessionService,
  hasMessageBus,
  getMessageBus,
  getConfigCenter,
  getLLMRouter,
} from '@ownpilot/core/services';
import type { ISessionService, IMessageBus } from '@ownpilot/core/services';

import {
  channelUsersRepo,
  type ChannelUserEntity,
  type ChannelUsersRepository,
} from '../db/repositories/channels/users.js';
import {
  channelAccessInboundNoticesRepo,
  inboundAccessCycle,
  needsFirstAuthorizedWelcome,
  wasInboundAccessNoticeHandled,
} from '../db/repositories/channel-access-inbound-notices.js';
import { channelAccessNotificationsRepo } from '../db/repositories/channel-access-notifications.js';
import { buildAccessMessage } from './channel-access-messages.js';
import { getWhatsAppAccessMessageSettings } from './channel-access-message-settings.js';
import { resolveCustomerPhone } from '../services/customer-identity.js';
import {
  channelSessionsRepo,
  type ChannelSessionsRepository,
} from '../db/repositories/channels/sessions.js';
import { ChannelMessagesRepository } from '../db/repositories/channels/messages.js';
import { channelsRepo } from '../db/repositories/channels/index.js';
import {
  getChannelVerificationService,
  type ChannelVerificationService,
} from './auth/verification.js';
import {
  dmPairingRequestsRepo,
  type DmPairingRequestsRepository,
} from '../db/repositories/channels/dm-pairing.js';
import { DmPairingService } from './dm-pairing-service.js';
import { isChannelUserAccessActive } from './channel-access-service.js';
import { emitConnectionEvent } from './connection-events.js';
import { wsGateway } from '../ws/server.js';
import { recordOutboundQuality } from '../services/outbound-quality.js';
import { channelFailureKind, channelFailureReply, presentChannelReply } from './channel-failure.js';
import { getErrorMessage } from '../utils/common.js';
import { getLog } from '../services/log.js';
import { claimOwnership, getOwnerUserId, autoClaimOwnership } from '../services/pairing-service.js';
import { clearChannelSession } from '../services/conversation-service.js';
import {
  processViaBus as processViaBusImpl,
  processDirectAgent as processDirectAgentImpl,
} from './channel-ai-routing.js';
import { channelAssetStore } from '../services/channel-asset-store.js';
import { bridgeIncomingMessage } from './bridge-runtime.js';

const log = getLog('ChannelService');

/** Try to get ISessionService via the core capability accessor.  *
 * Trust boundary: Channel plugin responses are normalised via per-plugin normalizers before reaching this code; the casts below adapt the normalised shape to the canonical channel-event type. The normalizer is the trust boundary.
 */
function tryGetSessionService(): ISessionService | null {
  return hasSessionService() ? getSessionService() : null;
}

/** Try to get IMessageBus via the core capability accessor.  *
 * Trust boundary: Channel plugin responses are normalised via per-plugin normalizers before reaching this code; the casts below adapt the normalised shape to the canonical channel-event type. The normalizer is the trust boundary.
 */
function tryGetMessageBus(): IMessageBus | null {
  return hasMessageBus() ? getMessageBus() : null;
}

// ============================================================================
// Helper: Check if a plugin is a channel plugin
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isChannelPluginApi(api: unknown): api is ChannelPluginAPI {
  return (
    isRecord(api) &&
    typeof api.connect === 'function' &&
    typeof api.disconnect === 'function' &&
    typeof api.sendMessage === 'function' &&
    typeof api.getStatus === 'function' &&
    typeof api.getPlatform === 'function'
  );
}

function isChannelPlugin(plugin: Plugin): boolean {
  return plugin.manifest.category === 'channel' && isChannelPluginApi(plugin.api);
}

function getChannelApi(plugin: Plugin): ChannelPluginAPI {
  if (!isChannelPluginApi(plugin.api)) {
    throw new Error(`Plugin ${plugin.manifest.id} does not expose a channel API`);
  }
  return plugin.api;
}

function getChannelPlatform(plugin: Plugin): ChannelPlatform {
  return (plugin.manifest as ChannelPluginManifest).platform ?? 'unknown';
}

// ============================================================================
// Implementation
// ============================================================================

export class ChannelServiceImpl implements IChannelService {
  private readonly usersRepo: ChannelUsersRepository;
  private readonly sessionsRepo: ChannelSessionsRepository;
  private readonly messagesRepo: ChannelMessagesRepository;
  private readonly verificationService: ChannelVerificationService;
  private readonly dmPairing: DmPairingService;
  private readonly pluginRegistry: PluginRegistry;
  private unsubscribes: Array<() => void> = [];
  private readonly sessionLocks = new Map<string, Promise<void>>();
  /** Per-(platform,platformUserId) approval-code attempt counter — wiped on success. */
  private readonly approvalAttemptCounts = new Map<string, number>();
  private static readonly MAX_APPROVAL_ATTEMPTS = 3;

  /**
   * Inbound flood guard — drops over-limit senders BEFORE user lookup / AI
   * routing. Policy + sliding-window state live in channels/flood-guard.ts.
   */
  private readonly floodGuard = new InboundFloodGuard();
  /** Suppress repeated greeting replies while keeping accepted messages in history. */
  private readonly greetingBurstGuard = new GreetingBurstGuard();

  constructor(
    pluginRegistry: PluginRegistry,
    options?: {
      usersRepo?: ChannelUsersRepository;
      sessionsRepo?: ChannelSessionsRepository;
      verificationService?: ChannelVerificationService;
      dmPairing?: DmPairingService;
      dmPairingRequests?: DmPairingRequestsRepository;
    }
  ) {
    this.pluginRegistry = pluginRegistry;
    this.usersRepo = options?.usersRepo ?? channelUsersRepo;
    this.sessionsRepo = options?.sessionsRepo ?? channelSessionsRepo;
    this.messagesRepo = new ChannelMessagesRepository();
    this.verificationService = options?.verificationService ?? getChannelVerificationService();
    this.dmPairing =
      options?.dmPairing ??
      new DmPairingService(options?.dmPairingRequests ?? dmPairingRequestsRepo, this.usersRepo);

    // Subscribe to incoming messages from channel plugins
    this.subscribeToEvents();
  }

  // ==========================================================================
  // IChannelService Implementation
  // ==========================================================================

  async send(channelPluginId: string, message: ChannelOutgoingMessage): Promise<string> {
    const api = this.getChannel(channelPluginId);
    if (!api) {
      throw new Error(`Channel plugin not found: ${channelPluginId}`);
    }

    try {
      await this.assertOutgoingAccess(api, message.platformChatId);
      const messageId = await api.sendMessage(message);
      await recordOutboundQuality(channelPluginId, messageId, message.text);

      // Emit sent event
      try {
        const eventBus = getEventBus();
        eventBus.emit(
          createEvent(ChannelEvents.MESSAGE_SENT, 'channel', `channel-service`, {
            channelPluginId,
            platform: api.getPlatform(),
            platformMessageId: messageId,
            platformChatId: message.platformChatId,
          })
        );
      } catch (emitErr) {
        log.warn('EventBus not available for MESSAGE_SENT event', { error: emitErr });
      }

      return messageId;
    } catch (error) {
      // Emit error event
      try {
        const eventBus = getEventBus();
        eventBus.emit(
          createEvent(ChannelEvents.MESSAGE_SEND_ERROR, 'channel', 'channel-service', {
            channelPluginId,
            platform: api.getPlatform(),
            error: getErrorMessage(error),
            platformChatId: message.platformChatId,
          })
        );
      } catch (emitErr) {
        log.warn('EventBus not available for MESSAGE_SEND_ERROR event', { error: emitErr });
      }
      throw error;
    }
  }

  async broadcast(
    platform: ChannelPlatform,
    message: ChannelOutgoingMessage
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const channels = this.getChannelPlugins().filter((p) => getChannelPlatform(p) === platform);

    for (const plugin of channels) {
      try {
        const api = getChannelApi(plugin);
        await this.assertOutgoingAccess(api, message.platformChatId);
        const messageId = await api.sendMessage(message);
        await recordOutboundQuality(plugin.manifest.id, messageId, message.text);
        results.set(plugin.manifest.id, messageId);
      } catch (error) {
        log.error(`Failed to send to ${plugin.manifest.id}`, {
          pluginId: plugin.manifest.id,
          error,
        });
      }
    }

    return results;
  }

  async broadcastAll(message: ChannelOutgoingMessage): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const channels = this.getChannelPlugins();

    for (const plugin of channels) {
      try {
        const api = getChannelApi(plugin);
        if (api.getStatus() === 'connected') {
          await this.assertOutgoingAccess(api, message.platformChatId);
          const messageId = await api.sendMessage(message);
          await recordOutboundQuality(plugin.manifest.id, messageId, message.text);
          results.set(plugin.manifest.id, messageId);
        }
      } catch (error) {
        log.error(`Failed to send to ${plugin.manifest.id}`, {
          pluginId: plugin.manifest.id,
          error,
        });
      }
    }

    return results;
  }

  getChannel(channelPluginId: string): ChannelPluginAPI | undefined {
    const plugin = this.pluginRegistry.get(channelPluginId);
    if (plugin && isChannelPlugin(plugin)) {
      return getChannelApi(plugin);
    }
    return undefined;
  }

  listChannels(): ChannelPluginInfo[] {
    return this.getChannelPlugins().map((plugin) => {
      const api = getChannelApi(plugin);
      return {
        pluginId: plugin.manifest.id,
        platform: getChannelPlatform(plugin),
        name: plugin.manifest.name,
        status: api.getStatus(),
        icon: plugin.manifest.icon,
      };
    });
  }

  getByPlatform(platform: ChannelPlatform): ChannelPluginAPI[] {
    return this.getChannelPlugins()
      .filter((p) => getChannelPlatform(p) === platform)
      .map(getChannelApi);
  }

  async connect(channelPluginId: string): Promise<void> {
    const api = this.getChannel(channelPluginId);
    if (!api) {
      throw new Error(`Channel plugin not found: ${channelPluginId}`);
    }

    emitConnectionEvent(channelPluginId, api.getPlatform(), 'connecting');

    await api.connect();

    // Upsert channels row so channel_messages FK constraint is satisfied
    const plugin = this.pluginRegistry.get(channelPluginId);
    try {
      await channelsRepo.upsert({
        id: channelPluginId,
        type: api.getPlatform(),
        name: plugin?.manifest.name ?? channelPluginId,
        status: 'connected',
      });
    } catch (err) {
      log.warn('Failed to upsert channel row', { channelPluginId, error: err });
    }

    emitConnectionEvent(channelPluginId, api.getPlatform(), 'connected');
  }

  async disconnect(channelPluginId: string): Promise<void> {
    const api = this.getChannel(channelPluginId);
    if (!api) {
      throw new Error(`Channel plugin not found: ${channelPluginId}`);
    }

    await api.disconnect();

    // Update channel status in DB
    try {
      await channelsRepo.updateStatus(channelPluginId, 'disconnected');
    } catch (err) {
      log.warn('Failed to update channel status', { channelPluginId, error: err });
    }

    emitConnectionEvent(channelPluginId, api.getPlatform(), 'disconnected');
  }

  async logout(channelPluginId: string): Promise<void> {
    const api = this.getChannel(channelPluginId);
    if (!api) {
      throw new Error(`Channel plugin not found: ${channelPluginId}`);
    }

    // Use logout() if available (clears session), otherwise fall back to disconnect()
    if (typeof api.logout === 'function') {
      await api.logout();
    } else {
      await api.disconnect();
    }

    // Update channel status in DB
    try {
      await channelsRepo.updateStatus(channelPluginId, 'disconnected');
    } catch (err) {
      log.warn('Failed to update channel status', { channelPluginId, error: err });
    }

    emitConnectionEvent(channelPluginId, api.getPlatform(), 'disconnected');
  }

  async resolveUser(platform: ChannelPlatform, platformUserId: string): Promise<string | null> {
    return this.verificationService.resolveUser(platform, platformUserId);
  }

  /**
   * Auto-connect all channel plugins that have valid configuration.
   * Fire-and-forget — errors are logged but don't block boot.
   */
  async autoConnectChannels(): Promise<void> {
    const channels = this.getChannelPlugins();

    for (const plugin of channels) {
      const api = getChannelApi(plugin);
      const manifest = plugin.manifest;

      // Skip already-connected channels
      if (api.getStatus() === 'connected') continue;

      // Check if the required service has a configured API key
      const requiredServices = manifest.requiredServices as Array<{ name: string }> | undefined;
      if (!requiredServices || requiredServices.length === 0) continue;

      const serviceName = requiredServices[0]!.name;

      if (!getConfigCenter().isServiceAvailable(serviceName)) {
        log.debug('Skipping auto-connect (service not configured)', {
          pluginId: manifest.id,
          service: serviceName,
        });
        continue;
      }

      try {
        log.info('Auto-connecting channel...', { pluginId: manifest.id });
        await this.connect(manifest.id);
        log.info('Channel auto-connected', { pluginId: manifest.id });
      } catch (error) {
        log.warn('Channel auto-connect failed', {
          pluginId: manifest.id,
          error: getErrorMessage(error),
        });

        // Broadcast error status so UI can display the failure
        wsGateway.broadcast('channel:status', {
          channelId: manifest.id,
          status: 'error',
          error: getErrorMessage(error),
        });
      }
    }
  }

  // ==========================================================================
  // Message Processing Pipeline
  // ==========================================================================

  /**
   * Process an incoming channel message.
   * This is the main pipeline: auth check -> session lookup -> AI routing.
   */
  async processIncomingMessage(message: ChannelIncomingMessage): Promise<void> {
    type ChannelProgressManager = {
      start(text?: string): Promise<string>;
      update(text: string): void;
      finish(text: string): Promise<string>;
      cancel(): Promise<void>;
      getMessageId(): number | null;
    };
    // Hoisted out of the try so the catch can replace a dangling "Thinking..."
    // progress placeholder with the error message instead of orphaning it.
    let progress: ChannelProgressManager | null = null;
    let whatsappUserId: string | undefined;
    try {
      // 0. Drop floods before any DB/LLM work. A single sender cannot exhaust
      //    resources by spamming — see InboundFloodGuard for the sliding window.
      if (this.floodGuard.shouldDrop(message.channelPluginId, message.sender.platformUserId)) {
        return;
      }

      // Resolve channel ownership before choosing a data scope. The connected WhatsApp
      // account is the administrator; each external phone gets a separate identity.
      const ownerUserId = await getOwnerUserId(message.platform);
      const whatsappMultiUser =
        message.platform === 'whatsapp' && process.env.ASTRA_WHATSAPP_MULTIUSER === 'true';
      let authenticatedWhatsAppSelfChat = false;
      let returningWhatsAppGuest = false;
      if (
        message.platform === 'whatsapp' &&
        ownerUserId === null &&
        message.metadata?.isGroup !== true
      ) {
        const api = this.getChannel(message.channelPluginId);
        const botPhone =
          api?.getStatus() === 'connected' ? api.getBotInfo?.()?.username : undefined;
        authenticatedWhatsAppSelfChat =
          message.metadata?.isSelfChat === true &&
          message.metadata?.fromMe === true &&
          Boolean(botPhone) &&
          message.sender.platformUserId === botPhone;

        // Ownership setup must not interrupt already approved customers. Only
        // an existing, independently scoped customer can use this exception;
        // never create a default user or auto-enroll an unknown sender here.
        if (
          !authenticatedWhatsAppSelfChat &&
          whatsappMultiUser &&
          message.metadata?.fromMe === false &&
          message.metadata?.isSelfChat !== true &&
          /^[1-9][0-9]{9,14}$/.test(message.sender.platformUserId)
        ) {
          const existing = await this.usersRepo.findByPlatform(
            message.platform,
            message.sender.platformUserId
          );
          returningWhatsAppGuest = Boolean(
            existing &&
            isChannelUserAccessActive(existing) &&
            existing.ownpilotUserId === `whatsapp:${message.sender.platformUserId}`
          );
        }

        if (!authenticatedWhatsAppSelfChat && !returningWhatsAppGuest) {
          log.debug('Dropping unapproved WhatsApp sender while ownership is unclaimed');
          return;
        }
      }
      const isWhatsAppGuest =
        whatsappMultiUser &&
        (returningWhatsAppGuest ||
          (ownerUserId !== null && ownerUserId !== message.sender.platformUserId)) &&
        message.metadata?.isGroup !== true;
      const customerUserId = isWhatsAppGuest
        ? `whatsapp:${message.sender.platformUserId}`
        : undefined;
      if (isWhatsAppGuest && !/^[1-9][0-9]{9,14}$/.test(message.sender.platformUserId)) {
        log.warn('Ignoring unresolvable WhatsApp customer identity');
        return;
      }
      if (isWhatsAppGuest) {
        const alias = await resolveCustomerPhone(message.sender.platformUserId);
        // Retired phones stay reserved. A later holder must never recreate the
        // old customer's identity or read its historical data.
        if (alias && (!alias.isCurrent || alias.retired)) return;
      }

      // 1. Find or create channel user
      const channelUser = await this.usersRepo.findOrCreate({
        platform: message.platform,
        platformUserId: message.sender.platformUserId,
        displayName: message.sender.displayName,
        platformUsername: message.sender.username,
        avatarUrl: message.sender.avatarUrl,
        ...(customerUserId ? { ownpilotUserId: customerUserId } : {}),
      });
      if (message.platform === 'whatsapp') whatsappUserId = channelUser.ownpilotUserId;

      // Recheck the refreshed record: an approval revoked between the lookup
      // above and findOrCreate must not fall through to auto-enrollment.
      if (
        returningWhatsAppGuest &&
        (!isChannelUserAccessActive(channelUser) || channelUser.ownpilotUserId !== customerUserId)
      ) {
        return;
      }

      // 1b. Emit first_seen event for new users
      if (channelUser.created) {
        try {
          const eventBus = getEventBus();
          eventBus.emit(
            createEvent<ChannelUserFirstSeenData>(
              ChannelEvents.USER_FIRST_SEEN,
              'channel',
              'channel-service',
              {
                platform: message.platform,
                user: message.sender,
                channelPluginId: message.channelPluginId,
              }
            )
          );
        } catch {
          // EventBus not initialized yet
        }
      }

      // 2. Check if blocked
      if (channelUser.isBlocked) {
        log.info('Blocked user message ignored', {
          displayName: message.sender.displayName,
          platform: message.platform,
        });
        return;
      }

      // WhatsApp customer access is an administrator-managed allowlist. Check
      // it before commands/session changes, not only before an AI response.
      if (
        message.platform === 'whatsapp' &&
        message.metadata?.isGroup !== true &&
        ownerUserId !== null &&
        message.sender.platformUserId !== ownerUserId &&
        !isWhatsAppGuest
      ) {
        return;
      }
      if (
        isWhatsAppGuest &&
        (!isChannelUserAccessActive(channelUser) || channelUser.ownpilotUserId !== customerUserId)
      ) {
        // Keep unsolicited new contacts pending. Expired/revoked managed
        // records retain their grant history and can only be renewed explicitly.
        if (!channelUser.accessSource && !channelUser.isVerified) {
          if (channelUser.status !== 'pending') {
            await this.usersRepo.updateStatus(channelUser.id, 'pending');
          }
        }
        await this.sendInboundAccessNotice(message, channelUser, 'inactive');
        return;
      }

      let dataUserId = channelUser.ownpilotUserId;
      if (isWhatsAppGuest) {
        const identity = await resolveCustomerPhone(message.sender.platformUserId, {
          provision: true,
        });
        if (!identity?.isCurrent || identity.retired) return;
        dataUserId = identity.dataUserId;
        whatsappUserId = dataUserId;
        // A message previously answered by the access gate must not become a
        // new AI request when WhatsApp replays it after approval or reconnect.
        if (wasInboundAccessNoticeHandled(channelUser, message.id)) return;
        if (channelUser.firstInteraction || needsFirstAuthorizedWelcome(channelUser)) {
          await this.sendInboundAccessNotice(message, channelUser, 'first_authorized');
          // Real requests on the first interaction still run normally. A plain
          // greeting needs only the personalized welcome, without a second reply.
          if (
            !message.attachments?.length &&
            /^(?:oi|ol[aá]|opa|e\s*a[ií]|bom\s+dia|boa\s+(?:tarde|noite)|hello|hi|\/start)[\s!?.]*$/iu.test(
              message.text.trim()
            )
          )
            return;
        }
      }

      // 2b. Group messages: save to DB + broadcast but skip AI routing (anti-ban: no auto-reply to groups)
      if (message.metadata?.isGroup === true) {
        try {
          await this.messagesRepo.create({
            id: message.id,
            channelId: message.channelPluginId,
            externalId: message.metadata?.platformMessageId?.toString(),
            direction: 'inbound',
            senderId: message.sender.platformUserId,
            senderName: message.sender.displayName,
            content: message.text,
            contentType:
              message.attachments && message.attachments.length > 0 ? 'attachment' : 'text',
            attachments: message.attachments?.map((a) => ({
              type: a.type,
              url: a.url,
              assetId: a.assetId,
              path: a.path,
              mimeType: a.mimeType,
              size: a.size,
              name: a.filename,
              expiresAt: a.expiresAt,
            })),
            replyToId: message.replyToId,
            metadata: message.metadata,
          });
        } catch (error) {
          log.warn('Failed to save group message', { error });
        }

        wsGateway.broadcast('channel:message', {
          id: message.id,
          channelId: message.channelPluginId,
          channelType: message.platform,
          sender: message.sender.displayName,
          content: message.text,
          timestamp: message.timestamp.toISOString(),
          direction: 'incoming',
        });

        log.info('Group message saved to DB (AI routing skipped)', {
          platform: message.platform,
          chatId: message.platformChatId,
        });
        return;
      }

      // 3. Handle /connect — pairing key claim takes priority over everything
      if (message.text.startsWith('/connect ')) {
        // A customer must never claim channel ownership or link to an admin identity.
        // Only self-chat messages originated by the connected account may pair.
        if (
          whatsappMultiUser &&
          (message.metadata?.isSelfChat !== true || message.metadata?.fromMe !== true)
        ) {
          return;
        }
        const submittedKey = message.text.slice('/connect '.length).trim();
        await this.handleConnectCommand(message, channelUser.id, submittedKey);
        return;
      }

      // 3a. Handle /clear — deactivate session so next message starts fresh
      if (message.text.trim() === '/clear') {
        await this.handleClearCommand(message, channelUser.id);
        return;
      }

      // 3b. Owner check — only the claimed owner gets AI responses.
      //     Non-owners get the DM pairing flow: generate code, notify owner.
      if (ownerUserId !== null) {
        // Owner IS claimed — check if sender is the owner
        if (message.sender.platformUserId !== ownerUserId && !isWhatsAppGuest) {
          // Non-owner: check if pending approval
          const pendingSenders = await this.dmPairing.getPendingSenders(message.platform);
          if (pendingSenders.has(message.sender.platformUserId)) {
            // Pending — generate code, notify owner, store as pending
            const code = await this.dmPairing.generateDmPairingCode(
              message.channelPluginId,
              message.platform,
              message.sender.platformUserId,
              ownerUserId
            );
            log.info('DM pairing code sent to owner for pending sender', {
              platform: message.platform,
              sender: message.sender.platformUserId,
              code,
            });
          } else {
            // Not pending — drop silently
            log.debug('Dropping message from non-owner, non-pending sender', {
              platform: message.platform,
              sender: message.sender.platformUserId,
            });
          }
          return;
        }
      } else {
        // No owner claimed yet.
        // Only a live authenticated self-chat can claim ownership. Previously
        // approved, isolated customers may continue without claiming anything.
        if (message.platform === 'whatsapp') {
          if (authenticatedWhatsAppSelfChat) {
            await autoClaimOwnership(
              message.channelPluginId,
              message.platform,
              message.sender.platformUserId,
              message.platformChatId
            );
            if ((await getOwnerUserId(message.platform)) !== message.sender.platformUserId) return;
            log.info('Auto-claimed WhatsApp owner from self-chat', {
              userId: message.sender.platformUserId,
            });
            // Fall through — process this message normally
          } else if (!returningWhatsAppGuest) {
            return;
          }
        } else {
          // Telegram/other: the channel is unclaimed. SECURITY: never disclose the
          // pairing key in-band — anyone who messages an unclaimed bot would receive
          // it and could claim ownership of the assistant. The key is shown only on
          // the server console (startup banner) and the authenticated web UI; the
          // owner claims with `/connect <key>` from there.
          log.info('No owner claimed yet — prompting owner to claim from console', {
            platform: message.platform,
            sender: message.sender.platformUserId,
          });
          const api = this.getChannel(message.channelPluginId);
          if (api) {
            try {
              await api.sendMessage({
                platformChatId: message.platformChatId,
                text:
                  `👋 This OwnPilot assistant has not been activated yet.\n\n` +
                  `If you are the owner, open the OwnPilot console or web UI (Channels) ` +
                  `to get your pairing key, then send:\n/connect YOUR-KEY`,
              });
            } catch (err) {
              log.warn('Failed to send activation notice', { error: getErrorMessage(err) });
            }
          }
          return;
        }
      }

      // 4. Check verification — whitelist, approval code, or admin approval
      if (!channelUser.isVerified) {
        if (message.platform === 'whatsapp') {
          // Only the authenticated owner can reach this path. Customer grants
          // come from number management; environment variables cannot renew them.
          const verificationSvc = getChannelVerificationService();
          await verificationSvc.verifyViaWhitelist(
            message.platform,
            message.sender.platformUserId,
            message.sender.displayName,
            channelUser.ownpilotUserId
          );
          channelUser.isVerified = true;
          log.info('Auto-verified WhatsApp sender', {
            scope: isWhatsAppGuest ? 'customer' : 'owner',
          });
        } else {
          const plugin = this.pluginRegistry.get(message.channelPluginId);
          const allowedUsers = plugin ? this.getPluginAllowedUsers(plugin) : [];
          const approvalCode = plugin ? this.getPluginApprovalCode(plugin) : null;

          // (a) Explicitly whitelisted in Config Center → auto-verify
          const isWhitelisted = allowedUsers.includes(message.sender.platformUserId);

          if (isWhitelisted) {
            const verificationSvc = getChannelVerificationService();
            await verificationSvc.verifyViaWhitelist(
              message.platform,
              message.sender.platformUserId,
              message.sender.displayName
            );
            channelUser.isVerified = true;
            log.info('Auto-verified user', {
              platform: message.platform,
              userId: message.sender.platformUserId,
              reason: 'whitelisted',
            });
          } else if (approvalCode) {
            // (b) Approval code configured — challenge-response verification
            // AUTH-007: count failed attempts per sender; block after MAX_APPROVAL_ATTEMPTS
            const attemptKey = `${message.platform}:${message.sender.platformUserId}`;
            const attempts = this.approvalAttemptCounts.get(attemptKey) ?? 0;
            if (attempts >= ChannelServiceImpl.MAX_APPROVAL_ATTEMPTS) {
              // Block the sender after too many wrong guesses. Drop the counter
              // entry too — block() is final state (the isBlocked check at the
              // top of processIncomingMessage catches future attempts), so the
              // counter for this attacker is dead weight that would otherwise
              // grow the map unboundedly.
              await this.usersRepo.block(channelUser.id);
              this.approvalAttemptCounts.delete(attemptKey);
              const api = this.getChannel(message.channelPluginId);
              if (api) {
                await api.sendMessage({
                  platformChatId: message.platformChatId,
                  text: 'Too many failed attempts. Please contact the admin.',
                  replyToId: message.id,
                });
              }
              log.warn('Blocked channel user after max approval attempts', {
                platform: message.platform,
                userId: message.sender.platformUserId,
              });
              return;
            }
            const submittedCode = Buffer.from(message.text.trim());
            const expectedCode = Buffer.from(approvalCode);
            const codeMatches =
              submittedCode.length === expectedCode.length &&
              timingSafeEqual(submittedCode, expectedCode);
            if (codeMatches) {
              // Correct code → approve
              const verificationSvc = getChannelVerificationService();
              await verificationSvc.verifyViaWhitelist(
                message.platform,
                message.sender.platformUserId,
                message.sender.displayName
              );
              channelUser.isVerified = true;
              // Clear failed-attempt counter on success
              this.approvalAttemptCounts.delete(attemptKey);
              log.info('Auto-verified user via approval code', {
                platform: message.platform,
                userId: message.sender.platformUserId,
              });

              const api = this.getChannel(message.channelPluginId);
              if (api) {
                await api.sendMessage({
                  platformChatId: message.platformChatId,
                  text: 'Access granted! You can now chat with the AI assistant.',
                  replyToId: message.id,
                });
              }
            } else {
              // Wrong code → reject and count the failed attempt
              this.approvalAttemptCounts.set(attemptKey, attempts + 1);
              const api = this.getChannel(message.channelPluginId);
              if (api) {
                await api.sendMessage({
                  platformChatId: message.platformChatId,
                  text: 'Please send the approval code to get access to this bot.',
                  replyToId: message.id,
                });
              }
              return;
            }
          } else {
            // (c) No code configured — require admin approval via UI
            const api = this.getChannel(message.channelPluginId);
            if (api) {
              await api.sendMessage({
                platformChatId: message.platformChatId,
                text: 'Your message has been received. An admin needs to approve your access.',
                replyToId: message.id,
              });
            }

            // Emit pending user event via EventBus
            try {
              const eventBus = getEventBus();
              eventBus.emit(
                createEvent<ChannelUserPendingData>(
                  ChannelEvents.USER_PENDING,
                  'channel',
                  'channel-service',
                  {
                    platform: message.platform,
                    platformUserId: message.sender.platformUserId,
                    displayName: message.sender.displayName,
                    channelPluginId: message.channelPluginId,
                  }
                )
              );
            } catch {
              // EventBus not initialized yet
            }

            return;
          }
        } // end else (non-whatsapp verification)
      }

      // 5. Save incoming message (conversationId wired after session creation
      //    below). This is also the idempotency gate: message.id is derived
      //    deterministically from the provider's message id (e.g. `slack:<ts>`,
      //    `channel.sms:<sid>`), so a redelivered webhook produces the same id.
      //    createIfNew inserts ON CONFLICT (id) DO NOTHING and reports whether
      //    the row was new; a duplicate delivery returns early BEFORE the LLM
      //    routing below, preventing a second (paid) AI reply to the same
      //    message. Race-safe against concurrent redeliveries.
      let savedInboundId: string | undefined;
      try {
        const isNew = await this.messagesRepo.createIfNew({
          id: message.id,
          channelId: message.channelPluginId,
          externalId: message.metadata?.platformMessageId?.toString(),
          direction: 'inbound',
          senderId: message.sender.platformUserId,
          senderName: message.sender.displayName,
          content: message.text,
          contentType:
            message.attachments && message.attachments.length > 0 ? 'attachment' : 'text',
          attachments: message.attachments?.map((a) => ({
            type: a.type,
            url: a.url,
            assetId: a.assetId,
            path: a.path,
            mimeType: a.mimeType,
            size: a.size,
            name: a.filename,
            expiresAt: a.expiresAt,
          })),
          replyToId: message.replyToId,
          metadata: message.metadata,
        });
        if (!isNew) {
          log.info('Duplicate inbound message ignored (idempotency)', {
            id: message.id,
            platform: message.platform,
          });
          return;
        }
        savedInboundId = message.id;
      } catch (error) {
        // A save failure here must NOT silently fall through to a second AI
        // reply on the next retry. But unlike a clean duplicate, we can't tell
        // whether this delivery was already answered, so we continue (best
        // effort) — the dedup above handles the common redelivery case.
        log.warn('Failed to save incoming message', { error });
      }

      // This runs AFTER the idempotent inbound save. Even suppressed greetings
      // remain in history; only their repetitive reply/notification is skipped.
      const greetingBurst = this.greetingBurstGuard.decide(message);
      if (greetingBurst.count >= 5 && !greetingBurst.suppressReply) {
        message = {
          ...message,
          metadata: { ...message.metadata, astraRepeatGreetingCount: greetingBurst.count },
        };
      }

      // 5b. Broadcast incoming message to WebSocket clients
      // Flat shape — matches what RealtimeBridge expects ({ sender, content })
      wsGateway.broadcast('channel:message', {
        id: message.id,
        channelId: message.channelPluginId,
        channelType: message.platform,
        sender: message.sender.displayName,
        content: message.text,
        timestamp: message.timestamp.toISOString(),
        direction: 'incoming',
      });

      // 5c. Do not flood the dashboard with notifications for repeated greetings.
      if (!greetingBurst.suppressReply) {
        wsGateway.broadcast('system:notification', {
          type: 'info',
          message: `New message from ${message.sender.displayName} on ${message.platform}`,
          action: 'channel:message',
        });
      }

      // 5d. Forward to any configured cross-channel bridges (best-effort,
      //     fire-and-forget — never blocks or fails the AI reply path).
      void bridgeIncomingMessage(message).catch((err) => {
        log.debug('Bridge forwarding error', { error: err });
      });

      if (greetingBurst.suppressReply) return;

      // 6. Find or create session -> conversation (serialized per chat to prevent duplicates)
      const sessionLockKey = `${channelUser.id}:${message.channelPluginId}:${message.platformChatId}`;
      const session = await this.withSessionLock(sessionLockKey, async () => {
        const existing = await this.sessionsRepo.findActive(
          channelUser.id,
          message.channelPluginId,
          message.platformChatId
        );
        if (existing) return existing;

        // Create a new conversation in the agent's in-memory ConversationMemory
        // so that loadConversation() can find it later for context continuity
        const { getOrCreateChatAgent } = await import('../services/agent/service.js');
        const routing = await getLLMRouter().pick({ process: 'channel' });
        const fallback =
          routing.fallbackProvider && routing.fallbackModel
            ? { provider: routing.fallbackProvider, model: routing.fallbackModel }
            : undefined;
        const agent = await getOrCreateChatAgent(
          routing.provider ?? 'openai',
          routing.model ?? 'gpt-4o',
          fallback,
          null,
          `channel:${message.channelPluginId}:${channelUser.id}`,
          undefined,
          true,
          dataUserId
        );
        const systemPrompt = agent.getConversation().systemPrompt;
        const conv = agent.getMemory().create(systemPrompt);
        const conversationId = conv.id;

        // Also persist to DB for audit/history
        const { createConversationsRepository } =
          await import('../db/repositories/chat/conversations.js');
        const conversationsRepo = createConversationsRepository();
        await conversationsRepo.create({
          id: conversationId,
          agentName: 'default',
          userId: dataUserId,
          metadata: {
            source: 'channel',
            platform: message.platform,
            channelUserId: channelUser.id,
            ownpilotUserId: dataUserId,
            displayName: message.sender.displayName,
          },
        });

        return this.sessionsRepo.create({
          channelUserId: channelUser.id,
          channelPluginId: message.channelPluginId,
          platformChatId: message.platformChatId,
          conversationId,
        });
      });

      // Touch last message
      await this.sessionsRepo.touchLastMessage(session.id);

      // Back-fill conversation_id on the inbound channel_message saved above
      if (savedInboundId && session.conversationId) {
        this.messagesRepo
          .linkConversation(savedInboundId, session.conversationId)
          .catch((err) => log.warn('Failed to backfill inbound conversation_id', { error: err }));
      }

      const assetIds =
        message.attachments
          ?.map((attachment) => attachment.assetId)
          .filter(
            (assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0
          ) ?? [];
      if (session.conversationId && assetIds.length > 0) {
        channelAssetStore
          .linkConversation(assetIds, session.conversationId)
          .catch((err) =>
            log.warn('Failed to link channel assets to conversation', { error: err })
          );
      }

      // Register/touch in unified ISessionService
      const sessionSvc = tryGetSessionService();
      if (sessionSvc) {
        const unified = sessionSvc.getOrCreate({
          userId: dataUserId,
          source: 'channel',
          channelPluginId: message.channelPluginId,
          platformChatId: message.platformChatId,
        });
        if (session.conversationId) {
          sessionSvc.linkConversation(unified.id, session.conversationId);
        }
      }

      // 7. Route to AI agent
      const api = this.getChannel(message.channelPluginId);
      if (!api) return;

      // Create progress manager if channel supports it
      type ProgressCapableAPI = typeof api & {
        createProgressManager?(chatId: string): {
          start(text?: string): Promise<string>;
          update(text: string): void;
          finish(text: string): Promise<string>;
          cancel(): Promise<void>;
          getMessageId(): number | null;
        } | null;
        trackMessage?(platformMessageId: string, chatId: string): void;
        shouldReplyWithVoice?(message: ChannelIncomingMessage): Promise<boolean> | boolean;
      };
      const progressApi = api as ProgressCapableAPI;
      progress =
        typeof progressApi.createProgressManager === 'function'
          ? progressApi.createProgressManager(message.platformChatId)
          : null;
      const replyWithVoice =
        typeof progressApi.shouldReplyWithVoice === 'function'
          ? await progressApi.shouldReplyWithVoice(message)
          : false;

      if (progress && !replyWithVoice) {
        // Send "Thinking..." progress message instead of typing indicator
        await progress.start();
      } else if (api.sendTyping) {
        // Fallback: plain typing indicator
        await api.sendTyping(message.platformChatId).catch((err) => {
          log.debug('Typing indicator failed', { plugin: message.channelPluginId, error: err });
        });
      }

      let responseText: string;

      // Try MessageBus pipeline first
      const bus = tryGetMessageBus();
      if (bus) {
        responseText = await this.processViaBus(
          bus,
          message,
          {
            sessionId: session.id,
            conversationId: session.conversationId,
            context: session.context,
          },
          { ownpilotUserId: dataUserId },
          progress ?? undefined
        );
      } else {
        // Legacy fallback: direct agent.chat()
        responseText = await this.processDirectAgent(message, dataUserId);
      }

      // A grant may expire or be revoked while the model is running. Do not
      // disclose its response after access or the persisted identity changes.
      if (
        message.platform === 'whatsapp' &&
        !(await this.isWhatsAppAccessAllowed(message.sender.platformUserId, dataUserId))
      ) {
        await progress?.cancel().catch((err) => {
          log.debug('Progress cancellation failed after access changed', { error: err });
        });
        return;
      }

      // 8. Send response (guard against empty text — Telegram rejects it)
      responseText = presentChannelReply(responseText || '', message.text);

      // Public navigation only; the customer portal still requires its own login.
      const dashboardAction = dashboardActionForConfirmedReply(
        responseText,
        dataUserId,
        message.platform
      );
      if (dashboardAction && message.platform === 'whatsapp') {
        // The verified, structured receipt is immutable. The AI may only add a
        // short, safe sentence and never delays delivery beyond 1.8 seconds.
        responseText = await maybePersonalizeConfirmedReply({
          responseText,
          channelPluginId: message.channelPluginId,
          dataUserId,
          displayName: message.sender.displayName,
        });
      }
      let sentMessageId: string;
      if (progress && !replyWithVoice) {
        // Replace progress message with final response
        sentMessageId = await progress.finish(responseText);
        // Track message ID for edit/delete support
        if (typeof progressApi.trackMessage === 'function') {
          progressApi.trackMessage(sentMessageId, message.platformChatId);
        }
      } else {
        if (progress && replyWithVoice) {
          await progress.cancel().catch((err) => {
            log.debug('Progress cancellation failed before voice reply', { error: err });
          });
        }
        sentMessageId = await api.sendMessage({
          platformChatId: message.platformChatId,
          text: responseText,
          ...(dashboardAction ? { urlButton: dashboardAction } : {}),
          replyToId: message.id,
          options: replyWithVoice ? { telegram: { asVoice: true } } : undefined,
        });
      }

      // Quality events contain no message text and dedupe against transport logs.
      await recordOutboundQuality(message.channelPluginId, sentMessageId, responseText);

      // Save outgoing message to channel_messages table
      // (bus persistence middleware handles the main messages table separately)
      try {
        await this.messagesRepo.create({
          id: `${message.channelPluginId}:${sentMessageId}`,
          channelId: message.channelPluginId,
          externalId: sentMessageId,
          direction: 'outbound',
          senderId: 'assistant',
          senderName: 'Assistant',
          content: responseText,
          contentType: 'text',
          replyToId: message.id,
          conversationId: session.conversationId ?? undefined,
          metadata: { ...message.metadata, platformChatId: message.platformChatId },
        });
      } catch (error) {
        log.warn('Failed to save outgoing message', { error });
      }

      // 8a. Broadcast outgoing message to WebSocket clients
      wsGateway.broadcast('channel:message', {
        id: `${message.channelPluginId}:${sentMessageId}`,
        channelId: message.channelPluginId,
        channelType: message.platform,
        sender: 'Assistant',
        content: responseText,
        timestamp: new Date().toISOString(),
        direction: 'outgoing',
      });

      log.info('Responded to user', {
        displayName: message.sender.displayName,
        platform: message.platform,
      });
    } catch (error) {
      const reason = channelFailureKind(getErrorMessage(error));
      log.error('Error processing message', { reason, platform: message.platform });
      const userMessage = channelFailureReply(message.text, reason);

      // Surface the error to the user. If a progress ("Thinking...") placeholder
      // is pending, replace it in place — otherwise it is orphaned in the chat
      // while a second error message is appended. finish() edits the placeholder
      // when one was sent and falls back to a fresh message when it wasn't.
      // Nothing after a successful reply throws to this catch (the post-send save
      // is self-contained and wsGateway.broadcast never throws), so finishing
      // here cannot overwrite a reply that was already delivered.
      try {
        if (
          message.platform === 'whatsapp' &&
          (!whatsappUserId ||
            !(await this.isWhatsAppAccessAllowed(
              message.sender.platformUserId,
              whatsappUserId
            ).catch(() => false)))
        ) {
          await progress?.cancel();
          return;
        }
        if (progress) {
          await progress.finish(userMessage);
        } else {
          const api = this.getChannel(message.channelPluginId);
          if (api) {
            await api.sendMessage({
              platformChatId: message.platformChatId,
              text: userMessage,
              replyToId: message.id,
            });
          }
        }
      } catch {
        // Best-effort error reply — original error already logged above
      }
    }
  }

  // ==========================================================================
  // Private Methods — AI Routing (delegated to channel-ai-routing.ts)
  // ==========================================================================

  private async processViaBus(
    bus: IMessageBus,
    message: ChannelIncomingMessage,
    session: {
      sessionId: string;
      conversationId: string | null;
      context?: Record<string, unknown>;
    },
    channelUser: { ownpilotUserId: string },
    progress?: { update(text: string): void }
  ): Promise<string> {
    return processViaBusImpl(
      bus,
      message,
      session,
      channelUser,
      {
        sessionsRepo: this.sessionsRepo,
        getChannel: (id) => this.getChannel(id),
        ...(message.platform === 'whatsapp'
          ? {
              isAccessAllowed: () =>
                this.isWhatsAppAccessAllowed(
                  message.sender.platformUserId,
                  channelUser.ownpilotUserId
                ),
            }
          : {}),
      },
      progress
    );
  }

  private async processDirectAgent(
    message: ChannelIncomingMessage,
    userId: string
  ): Promise<string> {
    return processDirectAgentImpl(
      message,
      userId,
      message.platform === 'whatsapp'
        ? () => this.isWhatsAppAccessAllowed(message.sender.platformUserId, userId)
        : undefined
    );
  }

  private async isWhatsAppAccessAllowed(platformUserId: string, userId: string): Promise<boolean> {
    const owner = await getOwnerUserId('whatsapp');
    const user = await this.usersRepo.findByPlatform('whatsapp', platformUserId);
    if (!user || !user.isVerified || user.isBlocked || user.status === 'pending') {
      return false;
    }
    if (owner === platformUserId) return user.ownpilotUserId === userId;
    if (user.ownpilotUserId !== `whatsapp:${platformUserId}` || !isChannelUserAccessActive(user))
      return false;
    const identity = await resolveCustomerPhone(platformUserId);
    return identity
      ? identity.isCurrent && !identity.retired && identity.dataUserId === userId
      : userId === `whatsapp:${platformUserId}`;
  }

  private async assertOutgoingAccess(api: ChannelPluginAPI, platformChatId: string): Promise<void> {
    if (api.getPlatform() !== 'whatsapp') return;
    // Match the transport's phone conversion, including a direct phone JID.
    // Groups and other non-phone chat addresses are outside customer grants.
    const jidPhone = platformChatId.match(
      /^([1-9][0-9]{9,14})(?::[0-9]+)?@(?:s\.whatsapp\.net|c\.us)$/
    )?.[1];
    const phone = platformChatId.includes('@') ? jidPhone : platformChatId.replace(/[^0-9]/g, '');
    if (!phone) return;
    const alias = await resolveCustomerPhone(phone);
    if (alias && (!alias.isCurrent || alias.retired)) {
      throw new Error('Este telefone foi substituído. Use o número atual do cliente.');
    }
    const owner = await getOwnerUserId('whatsapp');
    const user = await this.usersRepo.findByPlatform('whatsapp', phone);
    // Administrative messages to contacts without a customer grant still work.
    if (!user) return;
    if (owner === phone && user.isVerified && !user.isBlocked && user.status !== 'pending') return;
    if (
      user.isBlocked ||
      ((user.accessSource != null || user.accessExpiresAt != null) &&
        !isChannelUserAccessActive(user))
    ) {
      throw new Error(
        'O acesso deste número está inativo. Peça ao administrador para autorizar ou renovar seu acesso.'
      );
    }
  }

  /** Only server-owned access templates can be sent to an inactive customer. */
  private async sendInboundAccessNotice(
    incoming: ChannelIncomingMessage,
    user: ChannelUserEntity,
    mode: 'inactive' | 'first_authorized'
  ): Promise<void> {
    await this.withSessionLock(`access-notice:${user.id}`, async () => {
      const api = this.getChannel(incoming.channelPluginId);
      if (
        !api ||
        api.getPlatform() !== 'whatsapp' ||
        api.getStatus() !== 'connected' ||
        !/^[1-9][0-9]{9,14}$/.test(api.getBotInfo?.()?.username ?? '') ||
        incoming.metadata?.isGroup === true ||
        incoming.metadata?.fromMe === true
      )
        return;
      try {
        // Load configuration before consuming the durable attempt. Configuration
        // failures and known disconnections should not lose the first welcome.
        const settings = await getWhatsAppAccessMessageSettings();
        if (
          api.getStatus() !== 'connected' ||
          !/^[1-9][0-9]{9,14}$/.test(api.getBotInfo?.()?.username ?? '')
        )
          return;
        const notice = await channelAccessInboundNoticesRepo.claim(user.id, incoming.id, mode);
        if (!notice) return;
        const fresh = await this.usersRepo.getById(user.id);
        const owner = await getOwnerUserId('whatsapp');
        const currentApi = this.getChannel(incoming.channelPluginId);
        if (
          !fresh ||
          !currentApi ||
          currentApi !== api ||
          !/^[1-9][0-9]{9,14}$/.test(currentApi.getBotInfo?.()?.username ?? '') ||
          fresh.isBlocked ||
          fresh.platform !== 'whatsapp' ||
          owner === fresh.platformUserId ||
          currentApi.getBotInfo?.()?.username === fresh.platformUserId ||
          fresh.platformUserId !== incoming.sender.platformUserId ||
          fresh.ownpilotUserId !== `whatsapp:${fresh.platformUserId}` ||
          fresh.ownpilotUserId !== notice.user.ownpilotUserId ||
          inboundAccessCycle(fresh) !== notice.cycle ||
          api.getStatus() !== 'connected'
        )
          return;
        const message = {
          platformChatId: fresh.platformUserId,
          ...buildAccessMessage(notice.kind, fresh, settings),
        };
        // The private inactive branch never accepts caller-supplied text, target,
        // options or links. The normal public send guard remains unchanged.
        const messageId =
          mode === 'first_authorized'
            ? await this.send(incoming.channelPluginId, message)
            : await api.sendMessage(message);
        if (mode === 'inactive') {
          try {
            getEventBus().emit(
              createEvent(ChannelEvents.MESSAGE_SENT, 'channel', 'channel-service', {
                channelPluginId: incoming.channelPluginId,
                platform: 'whatsapp',
                platformMessageId: messageId,
                platformChatId: fresh.platformUserId,
              })
            );
          } catch {
            // A successfully sent notice must never retry because an event failed.
          }
        }
      } catch (error) {
        log.warn('WhatsApp access notice was not confirmed; no automatic replay', {
          category: error instanceof Error ? error.name : 'notice_error',
        });
      }
    });
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Serialize async operations per key to prevent race conditions.
   * Different keys run concurrently; same key waits for prior call.
   */
  private async withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(key);
    let resolve: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    this.sessionLocks.set(key, gate);
    try {
      if (prev) await prev;
      return await fn();
    } finally {
      resolve!();
      // Only delete if we're still the latest lock for this key
      if (this.sessionLocks.get(key) === gate) {
        this.sessionLocks.delete(key);
      }
    }
  }

  private getChannelPlugins(): Plugin[] {
    return this.pluginRegistry.getAll().filter((p) => p.status === 'enabled' && isChannelPlugin(p));
  }

  /**
   * Get allowed user IDs from a channel plugin's Config Center entry.
   */
  private getPluginAllowedUsers(plugin: Plugin): string[] {
    const requiredServices = plugin.manifest.requiredServices as
      Array<{ name: string }> | undefined;
    if (!requiredServices || requiredServices.length === 0) return [];

    const serviceName = requiredServices[0]!.name;
    const entry = getConfigCenter().getConfigEntry(serviceName);
    const raw = entry?.data?.allowed_users;
    if (typeof raw !== 'string' || !raw.trim()) return [];

    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Get the approval code from a channel plugin's Config Center entry.
   * Returns null if not configured.
   */
  private getPluginApprovalCode(plugin: Plugin): string | null {
    const requiredServices = plugin.manifest.requiredServices as
      Array<{ name: string }> | undefined;
    if (!requiredServices || requiredServices.length === 0) return null;

    const serviceName = requiredServices[0]!.name;
    const entry = getConfigCenter().getConfigEntry(serviceName);
    const raw = entry?.data?.approval_code;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    return raw.trim();
  }

  private async handleClearCommand(
    message: ChannelIncomingMessage,
    channelUserId: string
  ): Promise<void> {
    const api = this.getChannel(message.channelPluginId);
    const cleared = await clearChannelSession(
      channelUserId,
      message.channelPluginId,
      message.platformChatId
    );
    if (cleared) {
      log.info('Channel session cleared via /clear', { platform: message.platform });
    }
    if (api) {
      await api.sendMessage({
        platformChatId: message.platformChatId,
        text: cleared
          ? '🧹 Conversation cleared. Your next message starts a fresh session.'
          : '⚠️ No active session to clear. Send a message to start one.',
        replyToId: message.id,
      });
    }
  }

  private async handleConnectCommand(
    message: ChannelIncomingMessage,
    _channelUserId: string,
    submittedKey: string
  ): Promise<void> {
    const api = this.getChannel(message.channelPluginId);

    // Try pairing key claim first
    const claim = await claimOwnership(
      message.channelPluginId,
      message.platform,
      message.sender.platformUserId,
      message.platformChatId,
      submittedKey
    );

    if (claim.success) {
      log.info('Owner claimed via pairing key', {
        platform: message.platform,
        userId: message.sender.platformUserId,
      });
      if (api) {
        await api.sendMessage({
          platformChatId: message.platformChatId,
          text: `✅ Ownership confirmed! You are now the owner of this OwnPilot channel. You can start chatting with the AI assistant.`,
          replyToId: message.id,
        });
      }
      return;
    }

    if (claim.alreadyClaimed) {
      // Platform already has an owner — try old token-based verification
      // so users the owner shared access with can still connect
      const tokenResult = await this.verificationService.verifyToken(
        submittedKey,
        message.platform,
        message.sender.platformUserId,
        message.sender.displayName,
        message.sender.username
      );
      if (api) {
        await api.sendMessage({
          platformChatId: message.platformChatId,
          text: tokenResult.success
            ? `Verified! You are now connected as an OwnPilot user.`
            : `Verification failed. Please try again with a valid token.`,
          replyToId: message.id,
        });
      }
      return;
    }

    // Wrong pairing key — send hint
    if (api) {
      await api.sendMessage({
        platformChatId: message.platformChatId,
        text: `Invalid key. Please check the OwnPilot console for the correct pairing key and try again with /connect YOUR-KEY`,
        replyToId: message.id,
      });
    }
  }

  private subscribeToEvents(): void {
    try {
      const eventBus = getEventBus();

      // Listen for incoming messages from all channel plugins
      const unsub = eventBus.on<ChannelMessageReceivedData>(
        ChannelEvents.MESSAGE_RECEIVED,
        (event) => {
          const data = event.data;
          // Process asynchronously - don't block the event handler
          this.processIncomingMessage(data.message).catch((error) => {
            log.error('Failed to process incoming message', { error });
          });
        }
      );
      this.unsubscribes.push(unsub);

      // Listen for admin-approved users — send welcome message via their channel
      const unsubVerified = eventBus.on<ChannelUserVerifiedData>(
        'channel.user.verified',
        (event) => {
          const data = event.data;
          if (data.verificationMethod !== 'admin') return;

          this.sendApprovalNotification(data.platform, data.platformUserId).catch((err) => {
            log.warn('Failed to send approval notification', { error: err });
          });
        }
      );
      this.unsubscribes.push(unsubVerified);

      log.info('Subscribed to channel events');
    } catch {
      // EventBus not initialized yet - will be wired later
      log.info('EventBus not ready, events will be subscribed later');
    }
  }

  /**
   * Send a welcome message to a newly approved user via their channel.
   */
  private async sendApprovalNotification(platform: string, platformUserId: string): Promise<void> {
    if (platform === 'whatsapp') {
      const owner = await getOwnerUserId(platform);
      const user = await this.usersRepo.findByPlatform(platform, platformUserId);
      if (
        !user ||
        !user.isVerified ||
        user.isBlocked ||
        user.status === 'pending' ||
        user.metadata.hasInteracted === false ||
        (owner !== platformUserId &&
          (user.ownpilotUserId !== `whatsapp:${platformUserId}` ||
            !isChannelUserAccessActive(user)))
      ) {
        return;
      }
      // All WhatsApp approval paths share the durable queue. The worker sends
      // the personalized copy and rechecks the grant before any transport call.
      if (owner !== platformUserId)
        await channelAccessNotificationsRepo.queueLifecycle(user, 'approved');
      return;
    }
    const channelPlugins = this.getChannelPlugins().filter(
      (p) => getChannelPlatform(p) === platform
    );

    for (const plugin of channelPlugins) {
      const api = getChannelApi(plugin);
      if (api.getStatus() !== 'connected') continue;

      try {
        await this.send(plugin.manifest.id, {
          platformChatId: platformUserId,
          text: 'You have been approved! You can now chat with the AI assistant.',
        });
        return; // Sent successfully — no need to try other plugins
      } catch (err) {
        log.debug('Failed to send approval notification via plugin', {
          pluginId: plugin.manifest.id,
          error: err,
        });
      }
    }
  }

  /**
   * Dispose event listeners. Call during shutdown to prevent leaks.
   */
  dispose(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
    this.sessionLocks.clear();
    log.info('ChannelService disposed');
  }
  // ============================================================================
  // DM Pairing Security — delegated to DmPairingService
  // ============================================================================

  async approvePendingSender(
    platform: string,
    code: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.dmPairing.approvePendingSender(platform, code);
  }

  async denyPendingSender(
    platform: string,
    platformUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.dmPairing.denyPendingSender(platform, platformUserId);
  }

  async listPendingSenders(platform: string): Promise<
    Array<{
      platformUserId: string;
      displayName?: string;
      code: string;
      expiresAt: Date;
    }>
  > {
    return this.dmPairing.listPendingSenders(platform);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let _instance: ChannelServiceImpl | null = null;

export function createChannelServiceImpl(pluginRegistry: PluginRegistry): ChannelServiceImpl {
  _instance = new ChannelServiceImpl(pluginRegistry);
  return _instance;
}

export function getChannelServiceImpl(): ChannelServiceImpl | null {
  return _instance;
}
