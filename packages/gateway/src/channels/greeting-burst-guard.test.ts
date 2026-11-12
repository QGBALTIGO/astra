import { describe, expect, it } from 'vitest';
import { GreetingBurstGuard } from './greeting-burst-guard.js';
const inbound = (text: string, user = 'customer-a') => ({
  platform: 'whatsapp', channelPluginId: 'channel.whatsapp', platformChatId: user,
  sender: { platformUserId: user, platform: 'whatsapp', displayName: 'Cliente' },
  text, attachments: [],
});
describe('Astra greeting burst anti-spam', () => {
  it('answers only the first and fifth of a greeting burst', () => {
    const guard = new GreetingBurstGuard();
    const decisions = Array.from({ length: 10 }, (_, i) => guard.decide(inbound('Oi'), 1000 + 100 * i));
    expect(decisions.map((d) => !d.suppressReply)).toEqual([
      true, false, false, false, true, false, false, false, false, true,
    ]);
    expect(decisions[4]?.count).toBe(5);
  });
  it('never suppresses real requests, expense records, or another user', () => {
    const guard = new GreetingBurstGuard();
    guard.decide(inbound('Oi'), 1000);
    expect(guard.decide(inbound('Gastei 1 real no dinheiro'), 1100).suppressReply).toBe(false);
    expect(guard.decide(inbound('Oi'), 1200).suppressReply).toBe(false);
    expect(guard.decide(inbound('Oi', 'other'), 1300).suppressReply).toBe(false);
  });
  it('expires after inactivity and ignores other platforms or media', () => {
    const guard = new GreetingBurstGuard();
    guard.decide(inbound('Oi'), 0);
    expect(guard.decide(inbound('Oi'), 100).suppressReply).toBe(true);
    expect(guard.decide(inbound('Oi'), 13_000).suppressReply).toBe(false);
    expect(guard.decide({ ...inbound('Oi'), platform: 'telegram' }, 13_100).suppressReply).toBe(false);
    expect(guard.decide({ ...inbound('Oi'), attachments: [{ type: 'audio', mimeType: 'audio/ogg' }] } as never, 13_200).suppressReply).toBe(false);
  });
});
