import type { ChannelOutgoingMessage } from '@ownpilot/core/channels';
import {
  containsCustomerLoginLink,
  currentAstraLinksInText,
  currentAstraPublicUrl,
} from '../../config/astra-public-urls.js';

/** Only absolute web links without credentials or invisible/control characters are usable CTAs. */
export function normalizeChannelUrl(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return new URL(currentAstraPublicUrl(trimmed)).href;
  } catch {
    return undefined;
  }
}

export function publishChannelMessage(message: ChannelOutgoingMessage): ChannelOutgoingMessage {
  const text = currentAstraLinksInText(message.text);
  const action = message.urlButton;
  const url = action && currentAstraPublicUrl(action.url);
  if (action && url && url !== action.url)
    return { ...message, text, urlButton: { ...action, url } };
  return text === message.text ? message : { ...message, text };
}

/**
 * Deterministic capability fallback, applied before any network send. In particular,
 * Baileys 7.0.0-rc13's AnyMessageContent supports text links, not native URL CTAs.
 * Never try an interactive payload and then retry as text after an ambiguous error.
 */
export function renderUrlButtonAsText(
  message: Pick<ChannelOutgoingMessage, 'text' | 'urlButton'>
): string {
  const url = normalizeChannelUrl(message.urlButton?.url);
  if (!url) return message.text;
  if (containsCustomerLoginLink(url) && containsCustomerLoginLink(message.text))
    return message.text;
  if (message.text.split(/\s+/u).some((token) => normalizeChannelUrl(token) === url)) {
    return message.text;
  }
  const label = message
    .urlButton!.label.replace(/[\p{Cc}\p{Cf}*_~`<>[\]]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  return [message.text.trimEnd(), label ? `*${label}*\n${url}` : url].filter(Boolean).join('\n\n');
}
