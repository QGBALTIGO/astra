/**
 * Telegram Approval Handler Tests
 *
 * Focus: the callback decision path and the defense-in-depth chat-identity
 * guard (only the chat the prompt was sent to may resolve the approval).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../services/log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { TelegramApprovalHandler } from './approval-handler.js';

type CallbackHandler = (ctx: unknown, next: () => unknown) => Promise<void>;

function makeBot() {
  let callbackHandler: CallbackHandler | undefined;
  const bot = {
    on: vi.fn((_event: string, handler: CallbackHandler) => {
      callbackHandler = handler;
    }),
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    },
  };
  return { bot, getCallbackHandler: () => callbackHandler };
}

/** Pull the `approve:<id>` callback_data out of the keyboard the handler sent. */
function approveData(bot: ReturnType<typeof makeBot>['bot']): string {
  const opts = bot.api.sendMessage.mock.calls[0][2] as {
    reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
  };
  return opts.reply_markup.inline_keyboard[0][0].callback_data;
}

function makeCtx(callbackData: string, chatId: number | string) {
  return {
    callbackQuery: { data: callbackData },
    chat: { id: chatId },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  };
}

describe('TelegramApprovalHandler', () => {
  let handler: TelegramApprovalHandler;

  beforeEach(() => {
    handler = new TelegramApprovalHandler();
  });

  it('resolves true when the owner approves from the same chat', async () => {
    const { bot, getCallbackHandler } = makeBot();
    handler.register(bot as never);

    const pending = handler.request(bot as never, '12345', {
      toolName: 'shell',
      description: 'rm -rf tmp',
    });
    await Promise.resolve(); // let request() send the prompt

    const ctx = makeCtx(approveData(bot), 12345);
    await getCallbackHandler()!(ctx, vi.fn());

    await expect(pending).resolves.toBe(true);
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it('rejects a click from a different chat and leaves the approval pending', async () => {
    const { bot, getCallbackHandler } = makeBot();
    handler.register(bot as never);

    const pending = handler.request(bot as never, '12345', {
      toolName: 'shell',
      description: 'rm -rf tmp',
    });
    await Promise.resolve();

    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // Same approval id, but the callback comes from a DIFFERENT chat.
    const intruder = makeCtx(approveData(bot), 99999);
    await getCallbackHandler()!(intruder, vi.fn());
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(intruder.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'This approval has expired.',
    });
    expect(intruder.editMessageText).not.toHaveBeenCalled();

    // Clean up the still-pending approval (denies it).
    handler.clearAll();
    await expect(pending).resolves.toBe(false);
  });

  it('denies on timeout/clearAll', async () => {
    const { bot } = makeBot();
    handler.register(bot as never);
    const pending = handler.request(bot as never, '12345', { toolName: 't', description: 'd' });
    await Promise.resolve();
    handler.clearAll();
    await expect(pending).resolves.toBe(false);
  });
});
