/**
 * Channel Authentication Routes
 *
 * REST API endpoints for managing channel user verification.
 * Users generate tokens here, then use /connect on channel platforms.
 */

import { LOCAL_OWNER_ID } from '../../config/defaults.js';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { getChannelVerificationService } from '../../channels/auth/verification.js';
import {
  ChannelAccessError,
  channelUserAccessStatus,
  getChannelAccessService,
} from '../../channels/channel-access-service.js';
import { channelUsersRepo, type ChannelUserEntity } from '../../db/repositories/channels/users.js';
import { getPaginationParams, apiResponse, apiError, ERROR_CODES } from '../helpers.js';
import { getOwnerUserId } from '../../services/pairing-service.js';
import { wsGateway } from '../../ws/server.js';
import { whatsappAccessMessageSettingsRoutes } from './access-message-settings.js';

export const channelAuthRoutes = new Hono();

// Use only context established by authentication middleware. A signed customer
// JWT whose subject starts with "apikey:" must not impersonate a validated key.
export const requireChannelAccessAdmin: MiddlewareHandler = async (c, next) => {
  const userId = c.get('userId');
  if (!userId) {
    return apiError(
      c,
      { code: ERROR_CODES.UNAUTHORIZED, message: 'Autenticação necessária.' },
      401
    );
  }
  if (
    userId !== LOCAL_OWNER_ID &&
    !(userId.startsWith('apikey:') && !c.get('jwtPayload') && !c.get('sessionAuthenticated'))
  ) {
    return apiError(
      c,
      { code: ERROR_CODES.ACCESS_DENIED, message: 'Apenas o proprietário pode gerenciar acessos.' },
      403
    );
  }
  return next();
};
channelAuthRoutes.use('*', requireChannelAccessAdmin);
channelAuthRoutes.route('/messages/settings', whatsappAccessMessageSettingsRoutes);

const durationSchema = z.number().int().min(1).max(366);
const grantAccessSchema = z
  .object({
    platform: z.literal('whatsapp'),
    phoneNumber: z.string().min(1).max(64),
    displayName: z.string().trim().max(120).optional(),
    durationDays: durationSchema.nullable().optional().default(30),
  })
  .strict();
const renewAccessSchema = z
  .object({ durationDays: durationSchema.optional().default(30) })
  .strict();

function accessError(c: Context, error: unknown) {
  if (error instanceof ChannelAccessError) {
    return apiError(c, { code: error.code, message: error.message }, error.status);
  }
  throw error;
}

export function serializeChannelUser(user: ChannelUserEntity, whatsAppOwner: string | null) {
  const dateOrNull = (date?: Date | null) =>
    date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  return {
    id: user.id,
    ownpilotUserId: user.ownpilotUserId,
    platform: user.platform,
    platformUserId: user.platformUserId,
    platformUsername: user.platformUsername,
    displayName: user.displayName,
    isVerified: user.isVerified,
    verificationMethod: user.verificationMethod,
    isBlocked: user.isBlocked,
    accessExpiresAt: dateOrNull(user.accessExpiresAt),
    accessGrantedAt: dateOrNull(user.accessGrantedAt),
    accessSource: user.accessSource ?? null,
    accessStatus: channelUserAccessStatus(user),
    hasInteracted: user.metadata?.hasInteracted !== false,
    isOwner:
      user.ownpilotUserId === LOCAL_OWNER_ID ||
      (user.platform === 'whatsapp' && user.platformUserId === whatsAppOwner),
    firstSeenAt: user.firstSeenAt.toISOString(),
    lastSeenAt: user.lastSeenAt.toISOString(),
  };
}

function broadcastAccessChanged() {
  wsGateway.broadcast('data:changed', { entity: 'channel', action: 'updated' });
}

function canManageChannelUser(user: ChannelUserEntity, ownerUserId: string): boolean {
  if (user.ownpilotUserId === ownerUserId) return true;
  // Customer records live in their own data scope. The authenticated owner can
  // manage them independently of the connection or inbound multi-user setting.
  return (
    ownerUserId === LOCAL_OWNER_ID &&
    user.platform === 'whatsapp' &&
    user.ownpilotUserId === `whatsapp:${user.platformUserId}`
  );
}

/**
 * Load a channel user by id and enforce that it belongs to the authenticated
 * owner. Returns null when the user does not exist OR is owned by someone else
 * — callers map both to a 404 so cross-owner ids are indistinguishable from
 * missing ones (no existence leak). Mirrors the ownership guard already on
 * GET /status.
 */
async function getOwnedChannelUserById(id: string, ownerUserId: string) {
  const user = await channelUsersRepo.getById(id);
  if (!user || !canManageChannelUser(user, ownerUserId)) return null;
  return user;
}

/**
 * POST /channels/auth/generate-token
 * Generate a verification PIN/token for linking a channel account.
 * Uses the authenticated user's ID from context (security: prevents generating tokens for other users).
 */
channelAuthRoutes.post('/generate-token', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const body = await c.req.json<{
    platform?: string;
    ttlMinutes?: number;
    type?: 'pin' | 'token';
  }>();

  const service = getChannelVerificationService();
  const result = await service.generateToken(userId, {
    platform: body.platform,
    ttlMinutes: body.ttlMinutes,
    type: body.type,
  });

  return apiResponse(c, {
    token: result.token,
    expiresAt: result.expiresAt.toISOString(),
    instructions: `Send "/connect ${result.token}" to the bot on your messaging platform to verify your identity.`,
  });
});

/**
 * GET /channels/auth/status/:platform/:platformUserId
 * Check verification status for a platform user.
 */
channelAuthRoutes.get('/status/:platform/:platformUserId', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const { platform, platformUserId } = c.req.param();
  const service = getChannelVerificationService();

  const user = await channelUsersRepo.findByPlatform(platform, platformUserId);

  // Only return data for the authenticated user's own linked accounts
  if (user && !canManageChannelUser(user, userId)) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'Not found' }, 404);
  }

  const verified = await service.isVerified(platform, platformUserId);

  return apiResponse(c, {
    platform,
    platformUserId,
    isVerified: verified,
    user: user
      ? {
          id: user.id,
          displayName: user.displayName,
          platformUsername: user.platformUsername,
          verificationMethod: user.verificationMethod,
          verifiedAt: user.verifiedAt?.toISOString(),
          firstSeenAt: user.firstSeenAt.toISOString(),
          lastSeenAt: user.lastSeenAt.toISOString(),
        }
      : null,
  });
});

/**
 * POST /channels/auth/block/:platform/:platformUserId
 * Block a channel user.
 */
channelAuthRoutes.post('/block/:platform/:platformUserId', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const { platform, platformUserId } = c.req.param();
  const target = await channelUsersRepo.findByPlatform(platform, platformUserId);
  if (!target || !canManageChannelUser(target, userId)) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }
  const service = getChannelVerificationService();
  const blocked = await service.blockUser(platform, platformUserId);

  return apiResponse(c, { blocked });
});

/**
 * POST /channels/auth/unblock/:platform/:platformUserId
 * Unblock a channel user.
 */
channelAuthRoutes.post('/unblock/:platform/:platformUserId', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const { platform, platformUserId } = c.req.param();
  const target = await channelUsersRepo.findByPlatform(platform, platformUserId);
  if (!target || !canManageChannelUser(target, userId)) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }
  const service = getChannelVerificationService();
  const unblocked = await service.unblockUser(platform, platformUserId);

  return apiResponse(c, { unblocked });
});

/** Register and authorize a customer before their first WhatsApp message. */
channelAuthRoutes.post('/users', async (c) => {
  const parsed = grantAccessSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      c,
      {
        code: ERROR_CODES.INVALID_INPUT,
        message:
          'Informe WhatsApp, número, nome opcional e validade de 1 a 366 dias (ou sem vencimento).',
      },
      400
    );
  }
  try {
    const { phoneNumber, displayName, durationDays } = parsed.data;
    const user = await getChannelAccessService().grantWhatsAppAccess(
      { phoneNumber, displayName, durationDays },
      'manual'
    );
    broadcastAccessChanged();
    return apiResponse(c, { user: serializeChannelUser(user, null) });
  } catch (error) {
    return accessError(c, error);
  }
});

/**
 * GET /channels/auth/users
 * List all channel users with optional filters.
 */
channelAuthRoutes.get('/users', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const platform = c.req.query('platform');
  const verified = c.req.query('verified');
  const { limit, offset } = getPaginationParams(c, 100);

  const users = await channelUsersRepo.list({
    // Scope to the authenticated owner — never expose other users' linked accounts.
    ownpilotUserId: userId,
    includeWhatsAppCustomers: true,
    platform: platform ?? undefined,
    isVerified: verified !== undefined ? verified === 'true' : undefined,
    limit,
    offset,
  });
  const whatsAppOwner = users.some((user) => user.platform === 'whatsapp')
    ? await getOwnerUserId('whatsapp')
    : null;

  return apiResponse(c, {
    users: users.map((user) => serializeChannelUser(user, whatsAppOwner)),
    count: users.length,
    limit,
    offset,
  });
});

// ==========================================================================

/** Explicitly extend an expiry; an existing unlimited grant stays unlimited. */
channelAuthRoutes.post('/users/:id/renew', async (c) => {
  const id = c.req.param('id');
  const owned = await getOwnedChannelUserById(id, LOCAL_OWNER_ID);
  if (!owned || owned.platform !== 'whatsapp') {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }
  let body: unknown;
  try {
    body = JSON.parse((await c.req.text()) || '{}');
  } catch {
    return apiError(c, { code: ERROR_CODES.INVALID_INPUT, message: 'JSON inválido.' }, 400);
  }
  const parsed = renewAccessSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      c,
      {
        code: ERROR_CODES.INVALID_INPUT,
        message: 'A validade deve ser um número inteiro entre 1 e 366 dias.',
      },
      400
    );
  }
  try {
    const user = await getChannelAccessService().renewWhatsAppAccess(
      id,
      parsed.data.durationDays,
      'manual'
    );
    broadcastAccessChanged();
    return apiResponse(c, { user: serializeChannelUser(user, null) });
  } catch (error) {
    return accessError(c, error);
  }
});
// ID-based user management endpoints
// ==========================================================================

/**
 * POST /channels/auth/users/:id/approve
 * Approve a pending channel user.
 */
channelAuthRoutes.post('/users/:id/approve', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const id = c.req.param('id');
  const owned = await getOwnedChannelUserById(id, userId);
  if (!owned) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }

  if (owned.platform === 'whatsapp') {
    // The old snapshot-based approval flow could race a revocation. WhatsApp
    // grants must use the explicit authorization UI and its persistent service.
    return apiError(
      c,
      { code: 'CONFLICT', message: 'Use "Autorizar número" para gerenciar o acesso ao WhatsApp.' },
      409
    );
  }

  const approved = await getChannelVerificationService().approveUser(id);
  if (!approved) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }
  const user = await channelUsersRepo.getById(id);

  wsGateway.broadcast('data:changed', { entity: 'channel', action: 'updated' });
  wsGateway.broadcast('channel:user:approved', {
    channelId: '',
    platform: user?.platform ?? '',
    userId: id,
    platformUserId: user?.platformUserId ?? '',
    displayName: user?.displayName,
  });

  return apiResponse(c, { approved: true });
});

/**
 * POST /channels/auth/users/:id/block
 * Block a channel user by ID.
 */
channelAuthRoutes.post('/users/:id/block', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const id = c.req.param('id');
  const user = await getOwnedChannelUserById(id, userId);
  if (!user) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }

  await channelUsersRepo.block(id);
  wsGateway.broadcast('data:changed', { entity: 'channel', action: 'updated' });

  return apiResponse(c, { blocked: true });
});

/**
 * POST /channels/auth/users/:id/unblock
 * Unblock a channel user by ID.
 */
channelAuthRoutes.post('/users/:id/unblock', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const id = c.req.param('id');
  const user = await getOwnedChannelUserById(id, userId);
  if (!user) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }

  await channelUsersRepo.unblock(id);
  wsGateway.broadcast('data:changed', { entity: 'channel', action: 'updated' });

  return apiResponse(c, { unblocked: true });
});

/**
 * POST /channels/auth/users/:id/unverify
 * Revoke verification for a channel user by ID.
 */
channelAuthRoutes.post('/users/:id/unverify', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const id = c.req.param('id');
  const owned = await getOwnedChannelUserById(id, userId);
  if (!owned) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }

  if (owned.platform === 'whatsapp') {
    try {
      await getChannelAccessService().revokeWhatsAppAccess(id);
    } catch (error) {
      return accessError(c, error);
    }
  } else {
    const result = await getChannelVerificationService().unverifyUser(id);
    if (!result) {
      return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
    }
  }

  wsGateway.broadcast('data:changed', { entity: 'channel', action: 'updated' });

  return apiResponse(c, { unverified: true });
});

/**
 * DELETE /channels/auth/users/:id
 * Delete a channel user by ID.
 */
channelAuthRoutes.delete('/users/:id', async (c) => {
  const userId = LOCAL_OWNER_ID;
  const id = c.req.param('id');
  const owned = await getOwnedChannelUserById(id, userId);
  if (!owned) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }

  const service = getChannelVerificationService();
  const deleted = await service.deleteUser(id);

  if (!deleted) {
    return apiError(c, { code: ERROR_CODES.NOT_FOUND, message: 'User not found' }, 404);
  }

  wsGateway.broadcast('data:changed', { entity: 'channel', action: 'deleted' });

  return apiResponse(c, { deleted: true });
});
