/** Stop repetitive greetings without dropping their durable inbound history. */
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';

export interface GreetingBurstDecision { suppressReply: boolean; count: number }
const GREETING = /^(?:oi|ol[aá]|opa|bom dia|boa tarde|boa noite)[!?.\s]*$/iu;
export class GreetingBurstGuard {
  private readonly recent = new Map<string, { lastAt: number; count: number }>();
  constructor(private readonly windowMs = 12_000) {}

  decide(
    message: Pick<ChannelIncomingMessage, 'platform' | 'channelPluginId' | 'platformChatId' | 'sender' | 'text' | 'attachments'>,
    now = Date.now()
  ): GreetingBurstDecision {
    const key = [message.channelPluginId, message.platformChatId, message.sender.platformUserId].join('|');
    if (message.platform !== 'whatsapp' || message.attachments?.length || !GREETING.test(message.text.trim())) {
      this.recent.delete(key);
      return { suppressReply: false, count: 0 };
    }
    const previous = this.recent.get(key);
    const count = previous && now >= previous.lastAt && now - previous.lastAt < this.windowMs
      ? previous.count + 1 : 1;
    this.recent.delete(key);
    this.recent.set(key, { lastAt: now, count });
    if (this.recent.size > 10_000) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
    return { suppressReply: count > 1 && count % 5 !== 0, count };
  }
}
