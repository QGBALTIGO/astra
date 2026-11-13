import { getChannelService } from '@ownpilot/core/channels';
import {
  customerAccountsRepo,
  type CustomerAccountsRepository,
  type CustomerAccount,
  type CustomerPhoneResolution,
} from '../db/repositories/customer-accounts.js';
import { channelUsersRepo } from '../db/repositories/channels/users.js';
import {
  channelUserAccessStatus,
  normalizeWhatsAppAccessPhone,
} from '../channels/channel-access-service.js';
import { whatsappPhoneSpellings } from '../channels/whatsapp-phone.js';
import { getOwnerUserId } from './pairing-service.js';

export interface CustomerSessionContext {
  accountId: string;
  dataUserId: string;
  phoneNumber: string;
  displayName: string;
  timeZone: string;
  currency: 'BRL';
  theme: 'light' | 'dark' | 'system';
  hideAmounts: boolean;
  access: { status: 'active' | 'expired'; expiresAt: string | null; canWrite: boolean };
}

interface IdentityDependencies {
  accounts: Pick<CustomerAccountsRepository, 'resolvePhone' | 'getById' | 'provision'>;
  users: Pick<typeof channelUsersRepo, 'findByPlatform' | 'getById'>;
  owner: typeof getOwnerUserId;
  connectedPhones: () => string[];
  now: () => Date;
}

function connectedPhones(): string[] {
  const service = getChannelService();
  return service
    .listChannels()
    .filter((channel) => channel.platform === 'whatsapp')
    .flatMap((channel) => {
      const api = service.getChannel(channel.pluginId);
      const phone = api?.getStatus() === 'connected' ? api.getBotInfo?.()?.username : undefined;
      return phone && /^[1-9]\d{9,14}$/.test(phone) ? [phone] : [];
    });
}

export class CustomerIdentityService {
  private readonly dependencies: IdentityDependencies;
  constructor(dependencies: Partial<IdentityDependencies> = {}) {
    this.dependencies = {
      accounts: customerAccountsRepo,
      users: channelUsersRepo,
      owner: getOwnerUserId,
      connectedPhones,
      now: () => new Date(),
      ...dependencies,
    };
  }

  async isOwnerPhone(phone: string): Promise<boolean> {
    const owner = await this.dependencies.owner('whatsapp');
    const protectedPhones = new Set([owner, ...this.dependencies.connectedPhones()]);
    return whatsappPhoneSpellings(phone).some((candidate) => protectedPhones.has(candidate));
  }

  /** Resolve a login spelling to exactly one managed identity, preserving historical account keys. */
  async resolveLoginPhone(
    phone: string,
    verifyRecipient?: () => Promise<string | null>
  ): Promise<CustomerPhoneResolution | null> {
    const candidates = whatsappPhoneSpellings(phone);
    if (await this.isOwnerPhone(phone)) return null;
    const matches = await Promise.all(
      candidates.map(async (candidate) => {
        const [alias, user] = await Promise.all([
          this.dependencies.accounts.resolvePhone(candidate),
          this.dependencies.users.findByPlatform('whatsapp', candidate),
        ]);
        return { candidate, alias, user };
      })
    );
    if (matches.some(({ alias, user }) => alias?.retired || user?.isBlocked)) return null;
    const managed = matches.filter(
      ({ alias, user }) =>
        alias ||
        (user && (user.isVerified || user.accessSource || user.ownpilotUserId === 'default'))
    );
    // A prior admin could register both spellings. Only ignore a second
    // unused grant when its record explicitly says it has never interacted,
    // has no customer account and carries no restriction or foreign owner.
    const established = managed.filter(
      ({ alias, user, candidate }) =>
        alias ||
        !user ||
        user.metadata?.hasInteracted !== false ||
        !user.isVerified ||
        user.status !== 'active' ||
        user.ownpilotUserId !== 'whatsapp:' + candidate ||
        channelUserAccessStatus(user, this.dependencies.now()) !== 'active'
    );
    if (managed.length > 1 && established.length === 0) {
      // Neither grant has an account or interaction. Choose the earliest expiry
      // and a stable spelling on ties, rather than extending either grant.
      const [chosen] = [...managed].sort((a, b) => {
        const endA = a.user?.accessExpiresAt?.getTime() ?? Infinity;
        const endB = b.user?.accessExpiresAt?.getTime() ?? Infinity;
        return endA === endB ? a.candidate.localeCompare(b.candidate) : endA - endB;
      });
      return this.resolvePhone(chosen!.candidate, { provision: true });
    }
    const owners = managed.length === 1 ? managed : established;
    if (owners.length > 1 && verifyRecipient) {
      const verifiedRecipient = await verifyRecipient();
      if (!verifiedRecipient || !candidates.includes(verifiedRecipient)) return null;
      // Duplicate live customer accounts must never be merged. Route exclusively
      // to the account matching the number verified by WhatsApp, on both inputs.
      const owner = owners.find(({ candidate }) => candidate === verifiedRecipient);
      if (owner) return this.resolvePhone(owner.candidate, { provision: true });
    }
    if (owners.length !== 1) return null;
    return this.resolvePhone(owners[0]!.candidate, { provision: true });
  }

  async resolvePhone(
    phoneInput: string,
    options: { provision?: boolean } = {}
  ): Promise<CustomerPhoneResolution | null> {
    let phone: string;
    try {
      // Channel callers already pass an international digits-only identity;
      // never reinterpret its first digits as a Brazilian area code.
      phone = /^[1-9]\d{9,14}$/.test(phoneInput)
        ? phoneInput
        : normalizeWhatsAppAccessPhone(phoneInput);
    } catch {
      return null;
    }
    const d = this.dependencies;
    const existing = await d.accounts.resolvePhone(phone);
    if (existing || !options.provision) return existing;
    const user = await d.users.findByPlatform('whatsapp', phone);
    if (!user || user.ownpilotUserId !== `whatsapp:${phone}` || (await this.isOwnerPhone(phone)))
      return null;
    const status = channelUserAccessStatus(user, d.now());
    if (
      (status !== 'active' && status !== 'expired') ||
      !user.isVerified ||
      user.status !== 'active' ||
      user.isBlocked ||
      (user.accessExpiresAt != null && !Number.isFinite(user.accessExpiresAt.getTime()))
    )
      return null;
    const account = await d.accounts.provision(user.id, phone);
    return account
      ? {
          accountId: account.id,
          dataUserId: account.dataUserId,
          phoneNumber: account.phoneNumber,
          isCurrent: true,
          retired: false,
        }
      : null;
  }

  async getContext(
    accountId: string
  ): Promise<{ account: CustomerAccount; customer: CustomerSessionContext } | null> {
    const d = this.dependencies;
    const account = await d.accounts.getById(accountId);
    if (!account || account.dataUserId === 'default' || !account.dataUserId.startsWith('whatsapp:'))
      return null;
    const user = await d.users.getById(account.channelUserId);
    if (
      !user ||
      user.platform !== 'whatsapp' ||
      user.platformUserId !== account.phoneNumber ||
      user.ownpilotUserId !== `whatsapp:${account.phoneNumber}` ||
      !user.isVerified ||
      user.isBlocked ||
      user.status !== 'active' ||
      (await this.isOwnerPhone(account.phoneNumber))
    )
      return null;
    const status = channelUserAccessStatus(user, d.now());
    if (
      (status !== 'active' && status !== 'expired') ||
      (user.accessExpiresAt != null && !Number.isFinite(user.accessExpiresAt.getTime()))
    )
      return null;
    const alias = await d.accounts.resolvePhone(account.phoneNumber);
    if (!alias?.isCurrent || alias.accountId !== account.id) return null;
    return {
      account,
      customer: {
        accountId: account.id,
        dataUserId: account.dataUserId,
        phoneNumber: account.phoneNumber,
        displayName: account.displayName,
        timeZone: account.timeZone,
        currency: 'BRL',
        theme: account.theme,
        hideAmounts: account.hideAmounts,
        access: {
          status,
          expiresAt: user.accessExpiresAt?.toISOString() ?? null,
          canWrite: status === 'active',
        },
      },
    };
  }
}

let identity: CustomerIdentityService | undefined;
export function getCustomerIdentityService(): CustomerIdentityService {
  return (identity ??= new CustomerIdentityService());
}
export function resolveCustomerPhone(
  phone: string,
  options: { provision?: boolean } = {}
): Promise<CustomerPhoneResolution | null> {
  return getCustomerIdentityService().resolvePhone(phone, options);
}
