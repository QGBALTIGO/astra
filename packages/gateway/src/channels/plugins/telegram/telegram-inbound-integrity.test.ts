import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from 'grammy/types';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { TelegramChannelAPI } from './telegram-api.js';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  persist: vi.fn(),
  download: vi.fn(),
  mediaAllowed: vi.fn(),
}));
vi.mock('@ownpilot/core/events', () => ({
  getEventBus: () => ({ emit: mocks.emit }),
  createEvent: (_type: string, _category: string, _source: string, data: unknown) => ({ data }),
}));
vi.mock('../../../services/channel-asset-store.js', () => ({
  channelAssetStore: { persistIncomingAttachments: mocks.persist },
}));
vi.mock('./file-handler.js', () => ({ downloadTelegramAttachments: mocks.download }));
vi.mock('./media-access.js', () => ({ canDownloadTelegramMedia: mocks.mediaAllowed }));

function incoming(chatId: number, messageId = 7, type: 'private' | 'supergroup' = 'private') {
  return {
    message_id: messageId,
    date: 1_795_344_000,
    chat: { id: chatId, type },
    from: { id: type === 'private' ? chatId : 101, is_bot: false, first_name: 'Synthetic' },
    text: 'Meu resumo financeiro',
    reply_to_message: { message_id: 6 },
  } as Message;
}
function receive(api: TelegramChannelAPI, message: Message) {
  return (
    api as unknown as { handleIncomingMessage(message: Message): Promise<void> }
  ).handleIncomingMessage(message);
}
const messages = () =>
  mocks.emit.mock.calls.map(([event]) => event.data.message as ChannelIncomingMessage);

describe('Telegram conversation boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persist.mockImplementation(async ({ attachments }) => attachments);
    mocks.download.mockResolvedValue([]);
    mocks.mediaAllowed.mockResolvedValue(true);
  });

  it('admits equal provider message numbers from different chats while deduplicating a replay', async () => {
    const api = new TelegramChannelAPI({ bot_token: 'synthetic-token' }, 'channel.telegram');
    await receive(api, incoming(101));
    await receive(api, incoming(202));
    await receive(api, incoming(101));
    const rows = messages();
    const durableIds = new Set(rows.map((row) => row.id));
    expect(durableIds.size).toBe(2);
    expect(rows[0]!.id).toBe(rows[2]!.id);
    expect(rows[0]!.replyToId).not.toBe(rows[1]!.replyToId);
    expect(rows.map((row) => row.metadata?.platformMessageId)).toEqual([7, 7, 7]);
  });

  it('checks each sender before downloading concurrent media or persisting the content', async () => {
    const api = new TelegramChannelAPI({ bot_token: 'synthetic-token' }, 'channel.telegram');
    (api as unknown as { bot: object }).bot = {};
    mocks.mediaAllowed.mockImplementation(async (userId) => userId === '202');
    const denied = incoming(101);
    denied.photo = [
      { file_id: 'denied', file_unique_id: 'denied', width: 1, height: 1, file_size: 30_000_000 },
    ];
    const allowed = incoming(202);
    allowed.photo = [{ file_id: 'allowed', file_unique_id: 'allowed', width: 1, height: 1 }];
    mocks.download.mockResolvedValue([
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('fixture') },
    ]);
    await Promise.all([receive(api, denied), receive(api, allowed)]);
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.download.mock.calls[0]![1]).toBe(allowed);
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ platformChatId: '202' }));
    expect(
      messages().find((row) => row.platformChatId === '101')?.attachments?.[0]?.data
    ).toBeUndefined();
  });

  it('retains safe metadata when an authorized download fails without saving private bytes', async () => {
    const api = new TelegramChannelAPI({ bot_token: 'synthetic-token' }, 'channel.telegram');
    (api as unknown as { bot: object }).bot = {};
    mocks.download.mockRejectedValueOnce(new Error('synthetic provider outage'));
    const message = incoming(202);
    message.photo = [{ file_id: 'photo', file_unique_id: 'photo', width: 1, height: 1 }];
    await receive(api, message);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(messages()[0]!.attachments?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg',
    });
  });

  it('uses the same chat-scoped identity for a stored attachment and its inbound message', async () => {
    const api = new TelegramChannelAPI({ bot_token: 'synthetic-token' }, 'channel.telegram');
    (api as unknown as { bot: object }).bot = {};
    mocks.download.mockResolvedValueOnce([
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('fixture') },
    ]);
    const message = incoming(101);
    message.photo = [{ file_id: 'synthetic-photo', file_unique_id: 'photo', width: 1, height: 1 }];
    await receive(api, message);
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: messages()[0]!.id, platformChatId: '101' })
    );
    expect(messages()[0]!.id).toBe('channel.telegram:101:7');
  });

  it('does not persist or forward bytes if the authorized sender loses access during download', async () => {
    const api = new TelegramChannelAPI({ bot_token: 'synthetic-token' }, 'channel.telegram');
    (api as unknown as { bot: object }).bot = {};
    mocks.mediaAllowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.download.mockResolvedValueOnce([
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('fixture') },
    ]);
    const message = incoming(101);
    message.photo = [{ file_id: 'photo', file_unique_id: 'photo', width: 1, height: 1 }];
    await receive(api, message);
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(messages()[0]!.attachments?.[0]?.data).toBeUndefined();
  });

  it('edits and deletes the right chat when two sent messages have the same provider number', async () => {
    const api = new TelegramChannelAPI({ bot_token: 'synthetic-token' }, 'channel.telegram');
    const bot = {
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 9 }),
        editMessageText: vi.fn(),
        deleteMessage: vi.fn(),
      },
    };
    (api as unknown as { bot: object }).bot = bot;
    const first = await api.sendMessage({ platformChatId: '101', text: 'Primeira resposta' });
    const second = await api.sendMessage({ platformChatId: '202', text: 'Segunda resposta' });
    expect(first).not.toBe(second);
    await api.editMessage(first, 'Atualização privada');
    await api.deleteMessage(second);
    expect(bot.api.editMessageText).toHaveBeenCalledWith('101', 9, 'Atualização privada', {
      parse_mode: 'HTML',
    });
    expect(bot.api.deleteMessage).toHaveBeenCalledWith('202', 9);
  });
});
