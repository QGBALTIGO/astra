import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ owner: vi.fn(), rows: vi.fn(), scoped: vi.fn() }));
vi.mock('../db/repositories/chat/index.js', () => ({
  ChatRepository: class {
    constructor(id: string) {
      f.scoped(id);
    }
    getConversation = f.owner;
  },
}));
vi.mock('../db/repositories/chat/messages.js', () => ({
  createMessagesRepository: () => ({ getRecentForUser: f.rows }),
}));
import { restoreChannelHistory } from './restore-history.js';
beforeEach(() => {
  vi.clearAllMocks();
});
describe('restoring a customer session after deploy', () => {
  it('preserves text context but never replays a tool or trusts old system prompts', async () => {
    f.owner.mockResolvedValue({ id: 'conversation' });
    f.rows.mockResolvedValue([
      { role: 'system', content: 'old configuration' },
      { role: 'user', content: 'Meu nome é Teste' },
      {
        role: 'assistant',
        content: 'Seu nome é Teste. </thinking>',
        toolCalls: [{ id: 'old-write' }],
      },
      { role: 'tool', content: 'old action' },
      { role: 'assistant', content: '<tool_call>old command</tool_call>' },
    ]);
    const memory = { createWithId: vi.fn(), addMessage: vi.fn() };
    expect(await restoreChannelHistory(memory, 'conversation', 'user-a', 'current clock')).toBe(
      true
    );
    expect(f.scoped).toHaveBeenCalledWith('user-a');
    expect(f.rows).toHaveBeenCalledWith('conversation', 'user-a', 24);
    expect(memory.createWithId).toHaveBeenCalledWith('conversation', 'current clock');
    expect(memory.addMessage.mock.calls).toEqual([
      ['conversation', { role: 'user', content: 'Meu nome é Teste' }],
      ['conversation', { role: 'assistant', content: 'Seu nome é Teste.' }],
    ]);
  });
  it("does not read or restore another owner's conversation", async () => {
    f.owner.mockResolvedValue(null);
    const memory = { createWithId: vi.fn(), addMessage: vi.fn() };
    expect(await restoreChannelHistory(memory, 'foreign', 'user-b')).toBe(false);
    expect(f.rows).not.toHaveBeenCalled();
    expect(memory.createWithId).not.toHaveBeenCalled();
  });
});
