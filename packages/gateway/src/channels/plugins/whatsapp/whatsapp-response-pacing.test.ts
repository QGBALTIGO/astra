import { describe, expect, it } from 'vitest';
import { whatsappReplyDelayMs } from './whatsapp-response-pacing.js';

describe('WhatsApp response pacing', () => {
  it('uses a bounded proportional pause instead of a per-character unbounded sleep', () => {
    expect(whatsappReplyDelayMs('Pronto.', {})).toBe(1_500);
    expect(whatsappReplyDelayMs('a'.repeat(420), {})).toBe(5_000);
    expect(whatsappReplyDelayMs('a'.repeat(40_000), {})).toBe(6_000);
    expect(whatsappReplyDelayMs('😀'.repeat(420), {})).toBe(5_000);
  });

  it('accepts operator configuration without negative, infinite or inverted delays', () => {
    expect(whatsappReplyDelayMs('a'.repeat(420), { ASTRA_WHATSAPP_REPLY_PACING: 'false' })).toBe(0);
    expect(
      whatsappReplyDelayMs('a'.repeat(420), { ASTRA_WHATSAPP_REPLY_CHARS_PER_SECOND: '200' })
    ).toBe(2_900);
    expect(
      whatsappReplyDelayMs('a', {
        ASTRA_WHATSAPP_REPLY_DELAY_MIN_MS: '3000',
        ASTRA_WHATSAPP_REPLY_DELAY_MAX_MS: '1000',
      })
    ).toBe(3_000);
    expect(
      whatsappReplyDelayMs('a', {
        ASTRA_WHATSAPP_REPLY_DELAY_MIN_MS: 'NaN',
        ASTRA_WHATSAPP_REPLY_DELAY_MAX_MS: 'Infinity',
      })
    ).toBe(1_500);
    expect(
      whatsappReplyDelayMs('a'.repeat(400_000), { ASTRA_WHATSAPP_REPLY_DELAY_MAX_MS: '999999999' })
    ).toBe(15_000);
  });
});
