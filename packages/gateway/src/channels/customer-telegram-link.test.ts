import { describe, it, expect, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { customerTelegramLinkReply } from './customer-telegram-link.js';
const message = {
  id: 'test',
  platform: 'telegram',
  platformChatId: '123',
  sender: { platformUserId: '123', displayName: 'Cliente fictício' },
  text: '/connect ASTRA_ABCDEFGH',
  metadata: { chatType: 'private' },
} as ChannelIncomingMessage;
describe('customer Telegram linking', () => {
  it('verifies a customer token without claiming ownership of the bot', async () => {
    const verify = vi.fn(async () => ({ success: true, ownpilotUserId: 'whatsapp:synthetic' }));
    expect(await customerTelegramLinkReply(message, 'ASTRA_ABCDEFGH', verify)).toContain(
      'Conta vinculada'
    );
    expect(verify).toHaveBeenCalledExactlyOnceWith('ABCDEFGH');
  });
  it('preserves the existing operator pairing flow', async () => {
    const verify = vi.fn();
    expect(await customerTelegramLinkReply(message, 'operator-pairing-key', verify)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });
  it('refuses pairing in a group', async () => {
    const verify = vi.fn();
    expect(
      await customerTelegramLinkReply(
        { ...message, platformChatId: '-group' },
        'ASTRA_ABCDEFGH',
        verify
      )
    ).toContain('particular');
    expect(verify).not.toHaveBeenCalled();
  });
  it('does not accept file content as a linking command', async () => {
    const verify = vi.fn();
    expect(
      await customerTelegramLinkReply(
        { ...message, attachments: [{}] } as ChannelIncomingMessage,
        'ASTRA_ABCDEFGH',
        verify
      )
    ).toContain('particular');
    expect(verify).not.toHaveBeenCalled();
  });
  it('explains expiry without revealing internal errors', async () => {
    expect(
      await customerTelegramLinkReply(message, 'ASTRA_ABCDEFGH', async () => ({ success: false }))
    ).toContain('expirou');
    expect(
      await customerTelegramLinkReply(message, 'ASTRA_ABCDEFGH', async () => {
        throw new Error('token=secret');
      })
    ).not.toContain('secret');
  });
});
