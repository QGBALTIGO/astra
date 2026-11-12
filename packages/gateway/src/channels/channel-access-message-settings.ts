import { z } from 'zod';
import { LOCAL_OWNER_ID } from '../config/defaults.js';
import { getSystemSettingsRepository } from '../db/repositories/settings/system.js';
import { ASTRA_SITE_URL, currentAstraPublicUrl } from '../config/astra-public-urls.js';

export interface WhatsAppAccessMessageSettings {
  siteUrl: string;
  renewalUrl: string | null;
  timeZone: string;
}

export const DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS: Readonly<WhatsAppAccessMessageSettings> =
  Object.freeze({
    siteUrl: ASTRA_SITE_URL,
    renewalUrl: null,
    timeZone: 'America/Campo_Grande',
  });

// The local owner manages this gateway's WhatsApp connection. Customers and
// API-key identities must never create their own copy of its message settings.
const SETTINGS_KEY = `channel_access_messages:whatsapp:${LOCAL_OWNER_ID}`;

function isSafeHttpsUrl(value: string): boolean {
  // WHATWG URL parsing silently strips some controls and accepts backslashes.
  // Reject them before parsing so messages cannot gain hidden lines or targets.
  if (/[\p{Cc}\p{Cf}\\]/u.test(value) || /%(?:0[\da-f]|1[\da-f]|7f)/i.test(value)) {
    return false;
  }
  const trimmed = value.trim();
  if (/\s/.test(trimmed) || !/^https:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isValidTimeZone(value: string): boolean {
  // Use named zones, not fixed offsets, so dates respect the zone's rules.
  if (!/^[A-Za-z_][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const messageUrlSchema = z
  .string()
  .max(2048)
  .refine(
    isSafeHttpsUrl,
    'Use um endereço HTTPS válido, sem credenciais ou caracteres de controle.'
  )
  .transform((value) => currentAstraPublicUrl(value.trim()));

export const whatsAppAccessMessageSettingsSchema = z
  .object({
    siteUrl: messageUrlSchema,
    renewalUrl: messageUrlSchema.nullable(),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidTimeZone, 'Informe um fuso horário válido, como America/Campo_Grande.'),
  })
  .strict();

export async function getWhatsAppAccessMessageSettings(): Promise<WhatsAppAccessMessageSettings> {
  const stored = await getSystemSettingsRepository().get(SETTINGS_KEY);
  if (stored) {
    try {
      const parsed = whatsAppAccessMessageSettingsSchema.safeParse(JSON.parse(stored));
      if (parsed.success) return parsed.data;
    } catch {
      // Missing or malformed legacy configuration falls back to safe defaults.
    }
  }
  return { ...DEFAULT_WHATSAPP_ACCESS_MESSAGE_SETTINGS };
}

export async function setWhatsAppAccessMessageSettings(
  settings: WhatsAppAccessMessageSettings
): Promise<WhatsAppAccessMessageSettings> {
  const validated = whatsAppAccessMessageSettingsSchema.parse(settings);
  await getSystemSettingsRepository().set(SETTINGS_KEY, JSON.stringify(validated));
  return validated;
}
