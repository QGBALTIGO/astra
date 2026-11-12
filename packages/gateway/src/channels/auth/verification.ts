/**
 * Channel Verification Service
 *
 * Handles PIN/token-based verification, whitelist checking,
 * and user identity resolution for channel users.
 */

import { type ChannelUserVerifiedData, type ChannelUserBlockedData } from '@ownpilot/core/channels';
import { getEventBus, createEvent } from '@ownpilot/core/events';
import { ChannelEvents } from '@ownpilot/core/channels';

import type { ChannelVerificationRepository } from '../../db/repositories/channels/verification.js';
import { channelVerificationRepo } from '../../db/repositories/channels/verification.js';
import type { ChannelUsersRepository } from '../../db/repositories/channels/users.js';
import {
  channelUsersRepo,
  ChannelVerificationConflict,
  type ChannelUserEntity,
} from '../../db/repositories/channels/users.js';
import { getOwnerUserId } from '../../services/pairing-service.js';
import { isChannelUserAccessActive } from '../channel-access-service.js';

const WHATSAPP_MANUAL_ACCESS_MESSAGE =
  'Autorize ou renove este número na gestão de acessos do WhatsApp. Códigos e listas de confiança não concedem acesso.';

// ============================================================================
// Service
// ============================================================================

export class ChannelVerificationService {
  constructor(
    private readonly verificationRepo: ChannelVerificationRepository = channelVerificationRepo,
    private readonly usersRepo: ChannelUsersRepository = channelUsersRepo
  ) {}

  /**
   * Generate a new verification token for a user.
   * The user sends this token via /connect on a channel platform.
   */
  async generateToken(
    ownpilotUserId: string,
    options?: {
      platform?: string;
      ttlMinutes?: number;
      type?: 'pin' | 'token';
    }
  ): Promise<{ token: string; expiresAt: Date }> {
    return this.verificationRepo.generateToken(ownpilotUserId, options);
  }

  /**
   * Attempt to verify a token from a channel message (/connect TOKEN).
   * On success, links the channel user to the OwnPilot user.
   */
  async verifyToken(
    token: string,
    platform: string,
    platformUserId: string,
    displayName: string,
    platformUsername?: string
  ): Promise<{
    success: boolean;
    ownpilotUserId?: string;
    error?: string;
  }> {
    if (platform === 'whatsapp') {
      const owner = await getOwnerUserId(platform);
      if (owner !== platformUserId) {
        return { success: false, error: WHATSAPP_MANUAL_ACCESS_MESSAGE };
      }
      const existing = await this.usersRepo.findByPlatform(platform, platformUserId);
      if (existing?.accessSource || existing?.isBlocked) {
        return { success: false, error: WHATSAPP_MANUAL_ACCESS_MESSAGE };
      }
    }
    let ownpilotUserId: string | null;
    try {
      ownpilotUserId = await this.verificationRepo.transaction(async () => {
        const claimed = await this.verificationRepo.claimValidToken(token, platform);
        if (!claimed) return null;

        const user = await this.usersRepo.findOrCreate({
          platform,
          platformUserId,
          displayName,
          platformUsername,
          ownpilotUserId: claimed.ownpilotUserId,
        });
        if (
          platform === 'whatsapp' &&
          (user.accessSource || user.isBlocked || user.ownpilotUserId !== claimed.ownpilotUserId)
        ) {
          throw new ChannelVerificationConflict(WHATSAPP_MANUAL_ACCESS_MESSAGE);
        }
        await this.usersRepo.markVerified(user.id, claimed.ownpilotUserId, 'pin');
        await this.verificationRepo.assignClaimedTokenToUser(claimed.id, user.id);
        return claimed.ownpilotUserId;
      });
    } catch (error) {
      if (error instanceof ChannelVerificationConflict)
        return { success: false, error: error.message };
      throw error;
    }
    if (ownpilotUserId === null) return { success: false, error: 'Invalid or expired token.' };

    // Emit verification event
    try {
      const eventBus = getEventBus();
      eventBus.emit(
        createEvent<ChannelUserVerifiedData>(
          'channel.user.verified',
          'channel',
          'channel-verification-service',
          {
            platform,
            platformUserId,
            ownpilotUserId,
            verificationMethod: 'pin',
          }
        )
      );
    } catch {
      // EventBus not initialized yet - ignore
    }

    return {
      success: true,
      ownpilotUserId,
    };
  }

  /**
   * Check if a platform user is verified.
   */
  async isVerified(platform: string, platformUserId: string): Promise<boolean> {
    const user = await this.usersRepo.findByPlatform(platform, platformUserId);
    if (platform === 'whatsapp') return this.isWhatsAppAccessAllowed(user, platformUserId);
    return user?.isVerified === true && !user.isBlocked;
  }

  /**
   * Check if a user is in the whitelist for a channel plugin.
   * Whitelist is stored in the channel plugin's config.
   */
  async checkWhitelist(allowedList: string[], platformUserId: string): Promise<boolean> {
    if (allowedList.length === 0) return true; // No whitelist = allow all
    return allowedList.includes(platformUserId);
  }

  /**
   * Auto-verify a user via whitelist.
   */
  async verifyViaWhitelist(
    platform: string,
    platformUserId: string,
    displayName: string,
    ownpilotUserId: string = 'default'
  ): Promise<ChannelUserEntity> {
    if (platform === 'whatsapp' && (await getOwnerUserId(platform)) !== platformUserId) {
      const existing = await this.usersRepo.findByPlatform(platform, platformUserId);
      if (
        !existing ||
        existing.ownpilotUserId !== `whatsapp:${platformUserId}` ||
        !isChannelUserAccessActive(existing)
      ) {
        throw new Error(WHATSAPP_MANUAL_ACCESS_MESSAGE);
      }
      return existing;
    }
    const channelUser = await this.usersRepo.findOrCreate({
      platform,
      platformUserId,
      displayName,
      ownpilotUserId,
    });

    if (
      platform === 'whatsapp' &&
      (channelUser.isBlocked ||
        channelUser.ownpilotUserId !== ownpilotUserId ||
        (!channelUser.isVerified && Boolean(channelUser.accessSource)))
    ) {
      throw new Error(WHATSAPP_MANUAL_ACCESS_MESSAGE);
    }

    if (!channelUser.isVerified) {
      await this.usersRepo.markVerified(channelUser.id, ownpilotUserId, 'whitelist');
    }

    return { ...channelUser, isVerified: true };
  }

  /**
   * Resolve a channel user to their OwnPilot user ID.
   * Returns null if not verified.
   */
  async resolveUser(platform: string, platformUserId: string): Promise<string | null> {
    const user = await this.usersRepo.findByPlatform(platform, platformUserId);
    if (!user || !user.isVerified || user.isBlocked) return null;
    if (platform === 'whatsapp' && !(await this.isWhatsAppAccessAllowed(user, platformUserId))) {
      return null;
    }
    return user.ownpilotUserId;
  }

  private async isWhatsAppAccessAllowed(
    user: ChannelUserEntity | null,
    platformUserId: string
  ): Promise<boolean> {
    if (!user || !user.isVerified || user.isBlocked || user.status === 'pending') return false;
    if ((await getOwnerUserId('whatsapp')) === platformUserId) return true;
    return user.ownpilotUserId === `whatsapp:${platformUserId}` && isChannelUserAccessActive(user);
  }

  /**
   * Block a channel user.
   */
  async blockUser(platform: string, platformUserId: string): Promise<boolean> {
    const user = await this.usersRepo.findByPlatform(platform, platformUserId);
    if (!user) return false;
    await this.usersRepo.block(user.id);

    try {
      const eventBus = getEventBus();
      eventBus.emit(
        createEvent<ChannelUserBlockedData>(
          ChannelEvents.USER_BLOCKED,
          'channel',
          'channel-verification-service',
          { platform, platformUserId }
        )
      );
    } catch {
      // EventBus not initialized yet
    }

    return true;
  }

  /**
   * Unblock a channel user.
   */
  async unblockUser(platform: string, platformUserId: string): Promise<boolean> {
    const user = await this.usersRepo.findByPlatform(platform, platformUserId);
    if (!user) return false;
    await this.usersRepo.unblock(user.id);

    try {
      const eventBus = getEventBus();
      eventBus.emit(
        createEvent<ChannelUserBlockedData>(
          ChannelEvents.USER_UNBLOCKED,
          'channel',
          'channel-verification-service',
          { platform, platformUserId }
        )
      );
    } catch {
      // EventBus not initialized yet
    }

    return true;
  }

  /**
   * Approve a pending user by ID (admin action).
   */
  async approveUser(userId: string): Promise<boolean> {
    const user = await this.usersRepo.getById(userId);
    if (!user) return false;
    if (user.platform === 'whatsapp') {
      // Explicit grant/renew is the only way to activate WhatsApp customers.
      // Keep this legacy entry point idempotent for already authorized users.
      if ((await getOwnerUserId('whatsapp')) !== user.platformUserId || user.accessSource) {
        return this.isWhatsAppAccessAllowed(user, user.platformUserId);
      }
      if (user.isBlocked) return false;
    }
    await this.usersRepo.markVerified(user.id, user.ownpilotUserId, 'admin');

    // Emit verification event so channel service can notify the user
    try {
      const eventBus = getEventBus();
      eventBus.emit(
        createEvent<ChannelUserVerifiedData>(
          'channel.user.verified',
          'channel',
          'channel-verification-service',
          {
            platform: user.platform,
            platformUserId: user.platformUserId,
            ownpilotUserId: user.ownpilotUserId,
            verificationMethod: 'admin',
          }
        )
      );
    } catch {
      // EventBus not initialized yet - ignore
    }

    return true;
  }

  /**
   * Delete a channel user by ID.
   */
  async deleteUser(userId: string): Promise<boolean> {
    return this.usersRepo.delete(userId);
  }

  /**
   * Revoke verification for a channel user by ID.
   */
  async unverifyUser(userId: string): Promise<boolean> {
    const user = await this.usersRepo.getById(userId);
    if (!user) return false;
    await this.usersRepo.unverify(user.id);
    return true;
  }

  /**
   * Clean up expired tokens.
   */
  async cleanup(): Promise<number> {
    return this.verificationRepo.cleanupExpired();
  }
}

// Singleton
let _service: ChannelVerificationService | null = null;

export function getChannelVerificationService(): ChannelVerificationService {
  if (!_service) {
    _service = new ChannelVerificationService();
  }
  return _service;
}
