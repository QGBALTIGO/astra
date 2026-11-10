/** Persistent access grants for WhatsApp customers, independent of a bot connection. */
import {
  channelUsersRepo,
  type ChannelAccessSource,
  type ChannelUserEntity,
  type ChannelUsersRepository,
} from '../db/repositories/channels/users.js';
import { LOCAL_OWNER_ID } from '../config/defaults.js';
import { getOwnerUserId } from '../services/pairing-service.js';

export type ChannelUserAccessStatus = 'active' | 'expired' | 'revoked' | 'blocked' | 'pending';

/** Null fields grandfather verified legacy accounts; malformed expiry fails closed. */
export function channelUserAccessStatus(
  user: ChannelUserEntity,
  now: Date = new Date()
): ChannelUserAccessStatus {
  if (user.isBlocked) return 'blocked';
  if (user.accessSource != null && !user.isVerified) return 'revoked';
  if (user.accessExpiresAt != null) {
    const expires = user.accessExpiresAt.getTime();
    if (!Number.isFinite(expires) || expires <= now.getTime()) return 'expired';
  }
  if (!user.isVerified || user.status !== 'active') return 'pending';
  return 'active';
}

export function isChannelUserAccessActive(user: ChannelUserEntity, now = new Date()): boolean {
  return channelUserAccessStatus(user, now) === 'active';
}

export class ChannelAccessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' = 'INVALID_INPUT'
  ) {
    super(message);
    this.name = 'ChannelAccessError';
  }
}

const BRAZIL_AREA_CODES = new Set([
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '21',
  '22',
  '24',
  '27',
  '28',
  '31',
  '32',
  '33',
  '34',
  '35',
  '37',
  '38',
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '53',
  '54',
  '55',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '68',
  '69',
  '71',
  '73',
  '74',
  '75',
  '77',
  '79',
  '81',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '91',
  '92',
  '93',
  '94',
  '95',
  '96',
  '97',
  '98',
  '99',
]);

/**
 * Store the transport's digits-only identity. Only Brazilian national numbers
 * infer a country code; other countries require an explicit +DDI. Never add or
 * remove a subscriber digit or accept JIDs, extensions, groups or @lid IDs.
 */
export function normalizeWhatsAppAccessPhone(input: string): string {
  const invalid = () =>
    new ChannelAccessError('Informe um número com DDD ou um número internacional com +DDI.', 400);
  if (typeof input !== 'string' || input.length > 64) throw invalid();
  const value = input.trim();
  if (!/^\+?[0-9 ().-]+$/.test(value)) throw invalid();
  const digits = value.replace(/[^0-9]/g, '');
  const international = value.startsWith('+');
  let canonical: string;
  if (international) {
    if (!/^[1-9]\d{9,14}$/.test(digits)) throw invalid();
    canonical = digits;
  } else if (digits.length === 10 || digits.length === 11) {
    canonical = `55${digits}`;
  } else if (/^55\d{10,11}$/.test(digits)) {
    canonical = digits;
  } else {
    throw invalid();
  }

  if (canonical.startsWith('55')) {
    const national = canonical.slice(2);
    if (
      !BRAZIL_AREA_CODES.has(national.slice(0, 2)) ||
      !/^(?:\d{2}[2-9]\d{7}|\d{2}9\d{8})$/.test(national)
    ) {
      throw invalid();
    }
  }
  return canonical;
}

function validateDuration(durationDays: number | undefined): number {
  const days = durationDays === undefined ? 30 : durationDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 366) {
    throw new ChannelAccessError('A validade deve ser um número inteiro entre 1 e 366 dias.', 400);
  }
  return days;
}

function validateSource(source: ChannelAccessSource): void {
  if (source !== 'manual' && source !== 'cakto') {
    throw new ChannelAccessError('Origem da autorização inválida.', 400);
  }
}

type AccessUsersRepository = Pick<
  ChannelUsersRepository,
  | 'findByPlatform'
  | 'getById'
  | 'grantWhatsAppAccess'
  | 'renewWhatsAppAccess'
  | 'revokeWhatsAppAccess'
>;

export interface GrantWhatsAppAccessInput {
  phoneNumber: string;
  displayName?: string;
  /** Omitted: 30 days. Explicit null: no expiration. */
  durationDays?: number | null;
}

/**
 * Shared entry point for trusted server-side callers. HTTP always fixes source
 * to manual. Future Cakto integration must independently verify payment events
 * and prevent replays; an access source is audit metadata, not authentication.
 */
export class ChannelAccessService {
  constructor(
    private readonly users: AccessUsersRepository = channelUsersRepo,
    private readonly ownerLookup: (platform: string) => Promise<string | null> = getOwnerUserId,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private async assertCustomer(phoneNumber: string, existing: ChannelUserEntity | null) {
    const { resolveCustomerPhone } = await import('../services/customer-identity.js');
    const alias = await resolveCustomerPhone(phoneNumber);
    if (alias && (!alias.isCurrent || alias.retired)) {
      throw new ChannelAccessError(
        'Este número foi substituído em uma conta. Use o telefone atual do cliente.',
        409,
        'CONFLICT'
      );
    }
    if (
      (await this.ownerLookup('whatsapp')) === phoneNumber ||
      existing?.ownpilotUserId === LOCAL_OWNER_ID
    ) {
      throw new ChannelAccessError(
        'O número do proprietário não pode ser gerenciado como cliente.',
        409,
        'CONFLICT'
      );
    }
    if (
      existing &&
      (existing.platform !== 'whatsapp' || existing.ownpilotUserId !== `whatsapp:${phoneNumber}`)
    ) {
      throw new ChannelAccessError(
        'Este número já está associado a outra identidade.',
        409,
        'CONFLICT'
      );
    }
  }

  private assertGrantUnblocked(user: ChannelUserEntity | null) {
    if (user?.isBlocked) {
      throw new ChannelAccessError(
        'Este número está bloqueado. Desbloqueie-o antes de autorizar o acesso.',
        409,
        'CONFLICT'
      );
    }
  }

  async grantWhatsAppAccess(
    input: GrantWhatsAppAccessInput,
    source: ChannelAccessSource = 'manual'
  ): Promise<ChannelUserEntity> {
    validateSource(source);
    const phoneNumber = normalizeWhatsAppAccessPhone(input.phoneNumber);
    const durationDays = input.durationDays === null ? null : validateDuration(input.durationDays);
    if (
      input.displayName !== undefined &&
      (typeof input.displayName !== 'string' ||
        input.displayName.trim().length > 120 ||
        /[\u0000-\u001f]/.test(input.displayName))
    ) {
      throw new ChannelAccessError('O nome deve ter até 120 caracteres.', 400);
    }
    const existing = await this.users.findByPlatform('whatsapp', phoneNumber);
    await this.assertCustomer(phoneNumber, existing);
    this.assertGrantUnblocked(existing);
    const now = this.clock();
    const user = await this.users.grantWhatsAppAccess({
      phoneNumber,
      displayName: input.displayName?.trim() || undefined,
      grantedAt: now,
      expiresAt: durationDays === null ? null : new Date(now.getTime() + durationDays * 86_400_000),
      source,
    });
    if (!user) {
      // A concurrent block may have won the upsert's row lock after our read.
      this.assertGrantUnblocked(await this.users.findByPlatform('whatsapp', phoneNumber));
      throw new ChannelAccessError(
        'O número já está associado a outra identidade.',
        409,
        'CONFLICT'
      );
    }
    return user;
  }

  async renewWhatsAppAccess(
    id: string,
    durationDays?: number,
    source: ChannelAccessSource = 'manual'
  ): Promise<ChannelUserEntity> {
    validateSource(source);
    const days = validateDuration(durationDays);
    const existing = await this.users.getById(id);
    if (!existing) throw new ChannelAccessError('Usuário não encontrado.', 404, 'NOT_FOUND');
    await this.assertCustomer(existing.platformUserId, existing);
    this.assertGrantUnblocked(existing);
    const user = await this.users.renewWhatsAppAccess(id, days, source, this.clock());
    if (!user) {
      this.assertGrantUnblocked(await this.users.getById(id));
      throw new ChannelAccessError('Usuário não encontrado.', 404, 'NOT_FOUND');
    }
    return user;
  }

  async revokeWhatsAppAccess(id: string): Promise<ChannelUserEntity> {
    const existing = await this.users.getById(id);
    if (!existing) throw new ChannelAccessError('Usuário não encontrado.', 404, 'NOT_FOUND');
    await this.assertCustomer(existing.platformUserId, existing);
    const user = await this.users.revokeWhatsAppAccess(id);
    if (!user) throw new ChannelAccessError('Usuário não encontrado.', 404, 'NOT_FOUND');
    return user;
  }
}

let service: ChannelAccessService | undefined;
export function getChannelAccessService(): ChannelAccessService {
  return (service ??= new ChannelAccessService());
}
