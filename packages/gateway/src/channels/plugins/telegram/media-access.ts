import { channelUsersRepo } from '../../../db/repositories/channels/users.js';
import { customerAccountsRepo } from '../../../db/repositories/customer-accounts.js';
import { getCustomerIdentityService } from '../../../services/customer-identity.js';
import { getOwnerUserId } from '../../../services/pairing-service.js';

/** Reject unauthorized uploads before downloading bytes or writing the shared volume. */
export async function canDownloadTelegramMedia(platformUserId: string): Promise<boolean> {
  try {
    const user = await channelUsersRepo.findByPlatform('telegram', platformUserId);
    if (!user || !user.isVerified || user.isBlocked || user.status !== 'active') return false;
    if ((await getOwnerUserId('telegram')) === platformUserId) return true;
    if (!user.ownpilotUserId || user.ownpilotUserId === 'default') return false;
    const account = await customerAccountsRepo.getByDataUserId(user.ownpilotUserId);
    if (!account) return false;
    const current = await getCustomerIdentityService().getContext(account.id);
    return Boolean(
      current &&
      current.account.dataUserId === user.ownpilotUserId &&
      current.customer.access.canWrite
    );
  } catch {
    // Keep the metadata for the ordinary access response; an outage grants no upload access.
    return false;
  }
}
