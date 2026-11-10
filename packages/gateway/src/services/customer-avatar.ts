import { getChannelService, type ChannelPluginAPI, type IChannelService } from '@ownpilot/core/channels';
import {
  getCustomerIdentityService,
  type CustomerIdentityService,
  type CustomerSessionContext,
} from './customer-identity.js';
import { safeFetch } from '../utils/safe-fetch.js';
import { TTLCache } from '../utils/ttl-cache.js';

export const CUSTOMER_AVATAR_MAX_BYTES = 256 * 1024;
const CACHE_ENTRIES = 64;
const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_IN_FLIGHT = 4;

type AvatarContentType = 'image/jpeg' | 'image/png' | 'image/webp';
export interface CustomerAvatar {
  bytes: Uint8Array;
  contentType: AvatarContentType;
}
interface AvatarDependencies {
  channels: () => Pick<IChannelService, 'listChannels' | 'getChannel'>;
  identity: Pick<CustomerIdentityService, 'getContext'>;
  fetch: typeof safeFetch;
}
interface SelectedChannel {
  api: ChannelPluginAPI;
  pluginId: string;
  phoneNumber: string;
}

function pictureUrl(value: string | undefined): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\s\p{Cc}\p{Cf}]/u.test(value)
  ) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    // Restrict this proxy to WhatsApp's dedicated profile-picture host.
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443') ||
      host !== 'pps.whatsapp.net'
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function rasterType(value: string | null): AvatarContentType | null {
  const type = value?.split(';')[0]?.trim().toLowerCase();
  return type === 'image/jpeg' || type === 'image/png' || type === 'image/webp' ? type : null;
}

function hasRasterSignature(bytes: Uint8Array, type: AvatarContentType): boolean {
  if (type === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((value, index) => bytes[index] === value);
  }
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

/** Own-account avatar proxy. Signed provider URLs never leave the server. */
export class CustomerAvatarService {
  private readonly d: AvatarDependencies;
  private readonly cache = new TTLCache<string, { avatar: CustomerAvatar | null }>({
    defaultTtlMs: POSITIVE_TTL_MS,
    maxEntries: CACHE_ENTRIES,
  });
  private readonly inFlight = new Map<string, Promise<CustomerAvatar | null>>();

  constructor(dependencies: Partial<AvatarDependencies> = {}) {
    this.d = {
      channels: getChannelService,
      identity: getCustomerIdentityService(),
      fetch: safeFetch,
      ...dependencies,
    };
  }

  private connectedChannel(): SelectedChannel | null {
    const channels = this.d.channels();
    const candidates = channels.listChannels().filter(
      (channel) => channel.platform === 'whatsapp' && channel.status === 'connected'
    );
    const selected = candidates.find((channel) => channel.pluginId === 'channel.whatsapp') ??
      (candidates.length === 1 ? candidates[0] : undefined);
    const api = selected && channels.getChannel(selected.pluginId);
    const phone = api?.getStatus() === 'connected' ? api.getBotInfo?.()?.username : undefined;
    return selected && api?.getPlatform() === 'whatsapp' && api.resolveUser &&
      phone && /^[1-9]\d{9,14}$/.test(phone)
      ? { api, pluginId: selected.pluginId, phoneNumber: phone }
      : null;
  }

  private sameChannel(selected: SelectedChannel): boolean {
    const current = this.connectedChannel();
    return Boolean(
      current &&
      current.api === selected.api &&
      current.pluginId === selected.pluginId &&
      current.phoneNumber === selected.phoneNumber
    );
  }

  private async stillAllowed(
    customer: CustomerSessionContext,
    selected: SelectedChannel
  ): Promise<boolean> {
    if (!this.sameChannel(selected)) return false;
    const context = await this.d.identity.getContext(customer.accountId);
    const current = context?.customer;
    return Boolean(
      current &&
      current.accountId === customer.accountId &&
      current.dataUserId === customer.dataUserId &&
      current.phoneNumber === customer.phoneNumber &&
      (current.access.status === 'active' || current.access.status === 'expired') &&
      this.sameChannel(selected)
    );
  }

  async getAvatar(customer: CustomerSessionContext): Promise<CustomerAvatar | null> {
    try {
      if (
        !customer.accountId ||
        !customer.dataUserId.startsWith('whatsapp:') ||
        !/^[1-9]\d{9,14}$/.test(customer.phoneNumber) ||
        !['active', 'expired'].includes(customer.access.status)
      ) return null;
      const selected = this.connectedChannel();
      if (!selected || selected.phoneNumber === customer.phoneNumber) return null;
      const key = JSON.stringify([
        customer.accountId,
        customer.dataUserId,
        customer.phoneNumber,
        selected.pluginId,
        selected.phoneNumber,
      ]);
      const cached = this.cache.get(key);
      if (cached) return await this.stillAllowed(customer, selected) ? cached.avatar : null;
      const pending = this.inFlight.get(key);
      if (pending) return await pending;
      if (this.inFlight.size >= MAX_IN_FLIGHT) return null;

      const loading = this.loadAndCache(customer, selected, key).finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, loading);
      return await loading;
    } catch {
      // Provider errors can contain phone numbers and signed URLs. Never log them.
      return null;
    }
  }

  private async loadAndCache(
    customer: CustomerSessionContext,
    selected: SelectedChannel,
    key: string
  ): Promise<CustomerAvatar | null> {
    const avatar = await this.loadAvatar(customer.phoneNumber, selected);
    if (!(await this.stillAllowed(customer, selected))) return null;
    this.cache.set(key, { avatar }, avatar ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS);
    return avatar;
  }

  private async loadAvatar(
    phone: string,
    selected: SelectedChannel
  ): Promise<CustomerAvatar | null> {
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const user = await selected.api.resolveUser!(phone);
      if (
        !this.sameChannel(selected) ||
        user?.platform !== 'whatsapp' ||
        user.platformUserId !== phone
      ) return null;
      const url = pictureUrl(user.avatarUrl);
      if (!url) return null;
      controller = new AbortController();
      // Keep the deadline alive through streaming, not just response headers.
      timeout = setTimeout(() => controller!.abort(), FETCH_TIMEOUT_MS);
      timeout.unref?.();
      response = await this.d.fetch(url, {
        signal: controller.signal,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxRedirects: 0,
        redactUrl: true,
        credentials: 'omit',
        headers: { Accept: 'image/jpeg,image/png,image/webp' },
      });
      const contentType = rasterType(response.headers.get('content-type'));
      if (response.status !== 200 || !contentType || !response.body) return null;
      const declaredLength = response.headers.get('content-length');
      if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > CUSTOMER_AVATAR_MAX_BYTES)
      ) return null;

      reader = response.body.getReader();
      const buffer = new Uint8Array(CUSTOMER_AVATAR_MAX_BYTES);
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total + value.byteLength > CUSTOMER_AVATAR_MAX_BYTES) return null;
        buffer.set(value, total);
        total += value.byteLength;
      }
      if (!total || controller.signal.aborted) return null;
      const bytes = buffer.slice(0, total);
      return hasRasterSignature(bytes, contentType) ? { bytes, contentType } : null;
    } catch {
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
      controller?.abort();
      if (reader) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      } else {
        void response?.body?.cancel().catch(() => undefined);
      }
    }
  }
}

let avatarService: CustomerAvatarService | undefined;
export function getCustomerAvatarService(): CustomerAvatarService {
  return (avatarService ??= new CustomerAvatarService());
}
