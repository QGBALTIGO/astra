import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from 'node:crypto';
import { getChannelService, type IChannelService } from '@ownpilot/core/channels';
import {
  customerAccountsRepo,
  type CustomerAccountsRepository,
  type CustomerAccount,
  type NewCustomerSession,
} from '../db/repositories/customer-accounts.js';
import {
  customerAuthRepo,
  type CustomerAuthRepository,
  type CustomerChallenge,
  type CustomerChallengePurpose,
} from '../db/repositories/customer-auth.js';
import {
  getCustomerIdentityService,
  type CustomerIdentityService,
  type CustomerSessionContext,
} from './customer-identity.js';
import { normalizeWhatsAppAccessPhone } from '../channels/channel-access-service.js';
import { whatsappPhoneSpellings } from '../channels/whatsapp-phone.js';
import { buildCustomerOtpMessage } from './customer-auth-messages.js';
import { getLog } from './log.js';

const log = getLog('CustomerAuth');
const OTP_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 30 * 86_400_000;
export const CUSTOMER_OTP_MESSAGE =
  'Se este número tiver acesso ao Astra, você receberá um código pelo WhatsApp.';

export class CustomerAuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'CustomerAuthError';
  }
}
export interface CustomerChallengeResponse {
  challengeId: string;
  expiresIn: 300;
  retryAfter: number;
  message: string;
}
export interface CustomerLoginResult {
  customer: CustomerSessionContext;
  token: string;
  expiresAt: Date;
}

interface AuthDependencies {
  accounts: Pick<
    CustomerAccountsRepository,
    'getById' | 'isPhoneAvailable' | 'changePhone' | 'updateProfile'
  >;
  auth: CustomerAuthRepository;
  identity: Pick<CustomerIdentityService, 'resolveLoginPhone' | 'getContext' | 'isOwnerPhone'>;
  channels: () => Pick<IChannelService, 'getChannel' | 'listChannels'>;
  secret: () => string;
  now: () => Date;
  code: () => string;
}

function configuredSecret(): string {
  const value = process.env.CUSTOMER_AUTH_SECRET;
  if (!value || value.length < 32)
    throw new CustomerAuthError('Acesso por código temporariamente indisponível.', 503);
  return value;
}
function normalizePhone(value: string): string {
  try {
    return normalizeWhatsAppAccessPhone(value);
  } catch {
    throw new CustomerAuthError(
      'Informe um telefone com DDD ou um número internacional com +DDI.',
      400
    );
  }
}
export function customerSessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Navegador';
  const device = /Android/i.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/i.test(userAgent)
      ? 'iOS'
      : /Windows/i.test(userAgent)
        ? 'Windows'
        : /Macintosh/i.test(userAgent)
          ? 'macOS'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : '';
  return device ? `${browser} · ${device}` : browser;
}

export class CustomerAuthService {
  private readonly d: AuthDependencies;
  private running = false;
  constructor(dependencies: Partial<AuthDependencies> = {}) {
    this.d = {
      accounts: customerAccountsRepo,
      auth: customerAuthRepo,
      identity: getCustomerIdentityService(),
      channels: getChannelService,
      secret: configuredSecret,
      now: () => new Date(),
      code: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
      ...dependencies,
    };
  }

  private digest(purpose: string, value: string): string {
    return createHmac('sha256', this.d.secret()).update(`${purpose}\0${value}`).digest('hex');
  }
  private codeHash(id: string, purpose: CustomerChallengePurpose, code: string): string {
    return this.digest('customer-otp', `${id}\0${purpose}\0${code}`);
  }
  private encryptCode(code: string): string {
    const iv = randomBytes(12);
    const key = Buffer.from(this.digest('customer-otp-encryption', 'v1'), 'hex');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }
  private decryptCode(value: string): string {
    const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !encrypted)
      throw new Error('Invalid encrypted challenge');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(this.digest('customer-otp-encryption', 'v1'), 'hex'),
      iv
    );
    decipher.setAuthTag(tag);
    const code = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    if (!/^\d{6}$/.test(code)) throw new Error('Invalid challenge payload');
    return code;
  }
  private newSession(userAgent: string): { token: string; session: NewCustomerSession } {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      session: {
        id: randomUUID(),
        tokenHash: customerSessionHash(token),
        label: deviceLabel(userAgent.slice(0, 512)),
        expiresAt: new Date(this.d.now().getTime() + SESSION_TTL_MS),
      },
    };
  }

  private async issue(input: {
    purpose: CustomerChallengePurpose;
    phone: string;
    ip: string;
    account: CustomerAccount | null;
    sourcePhone?: string;
    targetPhone?: string;
    sessionId?: string;
    oldProofId?: string;
  }): Promise<CustomerChallengeResponse> {
    const id = randomUUID();
    const code = this.d.code();
    const now = this.d.now();
    const reservation = await this.d.auth.reserveChallenge({
      id,
      purpose: input.purpose,
      phoneNumber: input.phone,
      accountId: input.account?.id ?? null,
      accountVersion: input.account?.authVersion ?? null,
      sourcePhone: input.sourcePhone ?? null,
      targetPhone: input.targetPhone ?? null,
      boundSessionId: input.sessionId ?? null,
      oldProofId: input.oldProofId ?? null,
      codeHash: this.codeHash(id, input.purpose, code),
      codeCiphertext: input.account ? this.encryptCode(code) : null,
      ipHash: this.digest('customer-otp-ip', input.ip.slice(0, 256)),
      createdAt: now,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    });
    if (!reservation.accepted)
      throw new CustomerAuthError(
        'Aguarde para solicitar outro código.',
        429,
        reservation.retryAfter
      );
    // The HTTP path never sends WhatsApp or reveals delivery/account status.
    return { challengeId: id, expiresIn: 300, retryAfter: 60, message: CUSTOMER_OTP_MESSAGE };
  }

  /** External verification is needed only when local grants do not identify one account. */
  private async loginIdentity(phone: string) {
    return this.d.identity.resolveLoginPhone(phone, async () => {
      const selected = this.connectedChannel();
      return (await selected?.api.resolveWhatsAppRecipient?.(phone).catch(() => null)) ?? null;
    });
  }

  async requestCode(phoneInput: string, ip: string): Promise<CustomerChallengeResponse> {
    const phone = normalizePhone(phoneInput);
    this.d.secret();
    const resolved = await this.loginIdentity(phone);
    const context =
      resolved?.isCurrent && !resolved.retired
        ? await this.d.identity.getContext(resolved.accountId)
        : null;
    if (!resolved || !context)
      log.info('Customer login did not match an eligible account', {
        stage: resolved ? 'access' : 'identity',
      });
    return this.issue({
      purpose: 'login',
      phone: context?.account.phoneNumber ?? whatsappPhoneSpellings(phone).sort()[0]!,
      ip,
      account: context?.account ?? null,
    });
  }

  private async consume(
    id: string,
    code: string,
    purpose: CustomerChallengePurpose,
    accountId?: string,
    sessionId?: string
  ): Promise<CustomerChallenge> {
    if (!/^\d{6}$/.test(code) || id.length > 80)
      throw new CustomerAuthError('Código inválido, vencido ou já utilizado.', 401);
    const challenge = await this.d.auth.consumeChallenge({
      id,
      purpose,
      codeHash: this.codeHash(id, purpose, code),
      now: this.d.now(),
      accountId,
      sessionId,
    });
    if (!challenge?.accountId)
      throw new CustomerAuthError('Código inválido, vencido ou já utilizado.', 401);
    return challenge;
  }

  async verifyCode(
    challengeId: string,
    code: string,
    userAgent: string
  ): Promise<CustomerLoginResult> {
    const challenge = await this.consume(challengeId, code, 'login');
    const context = await this.d.identity.getContext(challenge.accountId!);
    if (
      !context ||
      context.account.phoneNumber !== challenge.phoneNumber ||
      context.account.authVersion !== challenge.accountVersion ||
      (await this.loginIdentity(challenge.phoneNumber))?.accountId !== context.account.id
    )
      throw new CustomerAuthError('Código inválido, vencido ou já utilizado.', 401);
    const { token, session } = this.newSession(userAgent);
    if (
      !(await this.d.auth.createSession(
        context.account.id,
        context.account.phoneNumber,
        context.account.authVersion,
        session,
        this.d.now()
      ))
    )
      throw new CustomerAuthError('Acesso indisponível.', 401);
    return { customer: context.customer, token, expiresAt: session.expiresAt };
  }

  async authenticate(
    token: string
  ): Promise<{ customer: CustomerSessionContext; sessionId: string } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = await this.d.auth.findSession(customerSessionHash(token), this.d.now());
    if (!session) return null;
    const context = await this.d.identity.getContext(session.accountId);
    if (!context || context.account.authVersion !== session.accountVersion) return null;
    await this.d.auth.touchSession(session.id, this.d.now());
    return { customer: context.customer, sessionId: session.id };
  }

  async logout(token: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const session = await this.d.auth.findSession(customerSessionHash(token), this.d.now());
    if (session) await this.d.auth.revokeSession(session.accountId, session.id, this.d.now());
  }

  async listSessions(accountId: string, currentId: string) {
    return (await this.d.auth.listSessions(accountId, this.d.now())).map((session) => ({
      id: session.id,
      label: session.label,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.id === currentId,
    }));
  }
  async revokeSession(accountId: string, sessionId: string): Promise<boolean> {
    return this.d.auth.revokeSession(accountId, sessionId, this.d.now());
  }
  async revokeOthers(accountId: string, currentId: string): Promise<number> {
    return this.d.auth.revokeOthers(accountId, currentId, this.d.now());
  }
  async updateProfile(
    accountId: string,
    patch: Partial<Pick<CustomerAccount, 'displayName' | 'timeZone' | 'theme' | 'hideAmounts'>>
  ): Promise<CustomerSessionContext> {
    const before = await this.d.identity.getContext(accountId);
    if (!before) throw new CustomerAuthError('Acesso indisponível.', 401);
    await this.d.accounts.updateProfile(accountId, patch);
    const after = await this.d.identity.getContext(accountId);
    if (!after) throw new CustomerAuthError('Acesso indisponível.', 401);
    return after.customer;
  }

  private async writableContext(accountId: string, sessionId: string) {
    const context = await this.d.identity.getContext(accountId);
    if (
      !context?.customer.access.canWrite ||
      !(await this.d.auth.isSessionActive(sessionId, accountId, this.d.now()))
    ) {
      throw new CustomerAuthError('Seu acesso precisa estar ativo para trocar o telefone.', 403);
    }
    return context;
  }

  async requestPhoneChange(
    accountId: string,
    sessionId: string,
    phoneInput: string,
    ip: string
  ): Promise<CustomerChallengeResponse> {
    const context = await this.writableContext(accountId, sessionId);
    const phone = normalizePhone(phoneInput);
    if (
      whatsappPhoneSpellings(phone).includes(context.account.phoneNumber) ||
      (await this.d.identity.isOwnerPhone(phone)) ||
      !(await this.d.accounts.isPhoneAvailable(phone))
    )
      throw new CustomerAuthError(
        'Este número não está disponível para a troca. Fale com o administrador.',
        409
      );
    return this.issue({
      purpose: 'phone_change_old',
      phone: context.account.phoneNumber,
      ip,
      account: context.account,
      sourcePhone: context.account.phoneNumber,
      targetPhone: phone,
      sessionId,
    });
  }

  async confirmOldPhone(
    accountId: string,
    sessionId: string,
    id: string,
    code: string,
    ip: string
  ): Promise<CustomerChallengeResponse> {
    const context = await this.writableContext(accountId, sessionId);
    const challenge = await this.consume(id, code, 'phone_change_old', accountId, sessionId);
    if (
      challenge.sourcePhone !== context.account.phoneNumber ||
      challenge.accountVersion !== context.account.authVersion ||
      !challenge.targetPhone ||
      (await this.d.identity.isOwnerPhone(challenge.targetPhone)) ||
      !(await this.d.accounts.isPhoneAvailable(challenge.targetPhone))
    )
      throw new CustomerAuthError('Reinicie a troca de telefone.', 409);
    return this.issue({
      purpose: 'phone_change_new',
      phone: challenge.targetPhone,
      ip,
      account: context.account,
      sourcePhone: context.account.phoneNumber,
      targetPhone: challenge.targetPhone,
      sessionId,
      oldProofId: challenge.id,
    });
  }

  async confirmNewPhone(
    accountId: string,
    sessionId: string,
    id: string,
    code: string,
    userAgent: string
  ): Promise<CustomerLoginResult> {
    const context = await this.writableContext(accountId, sessionId);
    const challenge = await this.consume(id, code, 'phone_change_new', accountId, sessionId);
    if (
      !challenge.oldProofId ||
      !challenge.targetPhone ||
      challenge.phoneNumber !== challenge.targetPhone ||
      challenge.sourcePhone !== context.account.phoneNumber ||
      challenge.accountVersion !== context.account.authVersion ||
      (await this.d.identity.isOwnerPhone(challenge.targetPhone))
    )
      throw new CustomerAuthError('Reinicie a troca de telefone.', 409);
    const { token, session } = this.newSession(userAgent);
    const whatsAppPluginIds = this.d
      .channels()
      .listChannels()
      .filter((channel) => channel.platform === 'whatsapp')
      .map((channel) => channel.pluginId);
    const account = await this.d.accounts.changePhone({
      accountId,
      expectedPhone: context.account.phoneNumber,
      expectedVersion: context.account.authVersion,
      boundSessionId: sessionId,
      newPhone: challenge.targetPhone,
      session,
      now: this.d.now(),
      whatsAppPluginIds: [...new Set(['channel.whatsapp', ...whatsAppPluginIds])],
    });
    if (!account)
      throw new CustomerAuthError(
        'Este número não está disponível para a troca. Reinicie o processo.',
        409
      );
    const changed = await this.d.identity.getContext(accountId);
    if (!changed) throw new CustomerAuthError('Entre novamente com o novo número.', 401);
    return { customer: changed.customer, token, expiresAt: session.expiresAt };
  }

  private connectedChannel() {
    const channels = this.d.channels();
    const candidates = channels
      .listChannels()
      .filter((channel) => channel.platform === 'whatsapp' && channel.status === 'connected');
    const selected =
      candidates.find((channel) => channel.pluginId === 'channel.whatsapp') ??
      (candidates.length === 1 ? candidates[0] : undefined);
    const api = selected && channels.getChannel(selected.pluginId);
    const phone = api?.getStatus() === 'connected' ? api.getBotInfo?.()?.username : undefined;
    return api?.getPlatform() === 'whatsapp' && phone && /^[1-9]\d{9,14}$/.test(phone)
      ? { api, phone }
      : null;
  }

  private async canDeliver(challenge: CustomerChallenge): Promise<boolean> {
    if (!challenge.accountId || challenge.expiresAt.getTime() <= this.d.now().getTime())
      return false;
    const context = await this.d.identity.getContext(challenge.accountId);
    if (!context || context.account.authVersion !== challenge.accountVersion) return false;
    if (challenge.purpose === 'login') {
      if (context.account.phoneNumber !== challenge.phoneNumber) return false;
      const current = await this.loginIdentity(challenge.phoneNumber);
      return !!current?.isCurrent && current.accountId === context.account.id;
    }
    if (
      !context.customer.access.canWrite ||
      challenge.sourcePhone !== context.account.phoneNumber ||
      !challenge.boundSessionId ||
      !(await this.d.auth.isSessionActive(
        challenge.boundSessionId,
        challenge.accountId,
        this.d.now()
      ))
    )
      return false;
    if (challenge.purpose === 'phone_change_old')
      return challenge.phoneNumber === context.account.phoneNumber;
    return Boolean(
      challenge.oldProofId &&
      challenge.targetPhone === challenge.phoneNumber &&
      !(await this.d.identity.isOwnerPhone(challenge.phoneNumber)) &&
      (await this.d.accounts.isPhoneAvailable(challenge.phoneNumber))
    );
  }

  /** No network work is done by request-code; retries stop at the durable sending boundary. */
  async dispatchOtps(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.d.secret();
      if (!this.connectedChannel()) return;
      for (const challenge of await this.d.auth.claimDeliveries(this.d.now())) {
        const lease = challenge.leaseToken;
        if (!lease) continue;
        let invoked = false;
        try {
          const selected = this.connectedChannel();
          if (!selected) {
            await this.d.auth.deferDelivery(challenge.id, lease);
            continue;
          }
          if (!challenge.codeCiphertext || !(await this.canDeliver(challenge))) {
            log.info('Customer code withheld after account recheck');
            await this.d.auth.finishDelivery(challenge.id, lease, 'cancelled');
            continue;
          }
          // Resolve both spellings before the sending boundary. WhatsApp may return
          // the same destination for both; a code must never reach two accounts.
          let recipient = challenge.phoneNumber;
          if (whatsappPhoneSpellings(recipient).length > 1) {
            const identified = await selected.api.resolveWhatsAppRecipient?.(recipient);
            if (!identified) {
              log.info('Customer code withheld: WhatsApp recipient unresolved');
              await this.d.auth.finishDelivery(challenge.id, lease, 'cancelled');
              continue;
            }
            recipient = identified;
          }
          const code = this.decryptCode(challenge.codeCiphertext);
          const message = buildCustomerOtpMessage(code, challenge.purpose);
          if (!(await this.d.auth.beginDelivery(challenge.id, lease, this.d.now()))) continue;
          if (!(await this.canDeliver(challenge))) {
            await this.d.auth.finishDelivery(challenge.id, lease, 'cancelled');
            continue;
          }
          const fresh = this.connectedChannel();
          if (!fresh || fresh.api !== selected.api || fresh.phone !== selected.phone) {
            await this.d.auth.deferDelivery(challenge.id, lease);
            continue;
          }
          invoked = true;
          // A native-flow copy button can be acknowledged without appearing in the
          // recipient's WhatsApp chat. Deliver the OTP as ordinary text by
          // default; preserve the known-good formatting and at-most-once send.
          // Explicit opt-in is reserved for controlled native-copy testing.
          const nativeCopyEnabled = process.env.ASTRA_CUSTOMER_OTP_NATIVE_COPY === 'true';
          await fresh.api.sendMessage({
            platformChatId: recipient,
            text: message.text,
            ...(nativeCopyEnabled ? { copyCode: message.copyCode } : {}),
            sendBefore: challenge.expiresAt,
          });
          await this.d.auth.finishDelivery(challenge.id, lease, 'sent');
          log.info('Customer code accepted by WhatsApp transport');
        } catch {
          try {
            if (invoked) await this.d.auth.finishDelivery(challenge.id, lease, 'failed');
            else await this.d.auth.deferDelivery(challenge.id, lease);
          } catch {
            /* A sending row is never retried after an uncertain receipt. */
          }
          log.warn('Customer code delivery was not confirmed', { transportInvoked: invoked });
        }
      }
    } catch (error) {
      // No tokens, phone numbers, codes, ciphertext or provider error bodies enter logs.
      if (!(error instanceof CustomerAuthError)) log.warn('Customer code dispatcher unavailable');
    } finally {
      this.running = false;
    }
  }
}

let service: CustomerAuthService | undefined;
export function getCustomerAuthService(): CustomerAuthService {
  return (service ??= new CustomerAuthService());
}
let otpTimer: ReturnType<typeof setInterval> | null = null;
export function dispatchDueCustomerOtps(): Promise<void> {
  return getCustomerAuthService().dispatchOtps();
}
export function startCustomerOtpWorker(): void {
  if (otpTimer) return;
  void dispatchDueCustomerOtps();
  otpTimer = setInterval(() => {
    void dispatchDueCustomerOtps();
  }, 2_000);
  otpTimer.unref?.();
}
export function stopCustomerOtpWorker(): void {
  if (otpTimer) clearInterval(otpTimer);
  otpTimer = null;
}
