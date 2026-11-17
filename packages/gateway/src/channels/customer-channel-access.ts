import { customerAccountsRepo } from '../db/repositories/customer-accounts.js';

/** Revalidate the authenticated channel grant and its account binding around async operations. */
export async function customerChannelAccess(userId: string, allowed: () => Promise<boolean>) {
  if (!(await allowed())) return null;
  const account = await customerAccountsRepo.getByDataUserId(userId);
  const bindingOf = (value: typeof account) =>
    value
      ? JSON.stringify([
          value.id,
          value.dataUserId,
          value.phoneNumber,
          value.channelUserId,
          value.authVersion,
        ])
      : 'no-account';
  const binding = bindingOf(account);
  const stillAllowed = async () => {
    if (!(await allowed())) return false;
    const current = await customerAccountsRepo.getByDataUserId(userId);
    if (bindingOf(current) !== binding) return false;
    return allowed();
  };
  return (await stillAllowed()) ? { account, stillAllowed } : null;
}
