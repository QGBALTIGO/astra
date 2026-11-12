import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalMemoryStore, PersonalMemoryStore } from '../memory/personal.js';
import { ToolRegistry } from './tools.js';
import { runInExecContext } from './exec-context.js';
import { resetEventSystem } from '../events/event-system.js';
import { groqResponseOptions } from './providers/groq-response-options.js';
let root: string;
beforeEach(async () => {
  resetEventSystem();
  root = await mkdtemp(join(tmpdir(), 'astra-test-'));
  vi.stubEnv('OWNPILOT_DATA_DIR', root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
describe('channel runtime reliability', () => {
  it('persists a safe namespace across store recreation, isolated from other users', async () => {
    const a = createPersonalMemoryStore('whatsapp:5511111111111');
    await a.initialize();
    await a.set('identity', 'name', 'Synthetic A');
    const restored = createPersonalMemoryStore('whatsapp:5511111111111');
    await restored.initialize();
    const b = createPersonalMemoryStore('whatsapp:5522222222222');
    await b.initialize();
    expect((await restored.get('identity', 'name'))?.value).toBe('Synthetic A');
    expect(await b.get('identity', 'name')).toBeNull();
  });
  it.each([
    '../escape',
    '..',
    '.',
    'whatsapp:../../escape',
    'whatsapp:a/b',
    'whatsapp:a\\b',
    '/etc/passwd',
  ])('still rejects unsafe identity %s', (id) =>
    expect(() => createPersonalMemoryStore(id)).toThrow()
  );
  it('keeps the direct filesystem constructor strictly validated', () =>
    expect(() => new PersonalMemoryStore('whatsapp:5511111111111')).toThrow());
  it('observes native and nested tool outcomes, not a model text claim', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'core.real_action',
        description: 'test',
        parameters: { type: 'object', properties: {} },
      },
      async () => ({ content: '{"id":"saved"}' })
    );
    registry.register(
      { name: 'core.failure', description: 'test', parameters: { type: 'object', properties: {} } },
      async () => ({ content: 'rejected', isError: true })
    );
    registry.register(
      { name: 'use_tool', description: 'test', parameters: { type: 'object', properties: {} } },
      async (_args, ctx) => {
        await registry.execute('core.real_action', {}, ctx);
        await registry.execute('core.failure', {}, ctx);
        return { content: 'synthetic batch result' };
      }
    );
    const receipts: { name: string; isError: boolean }[] = [];
    await runInExecContext({ onToolResult: (r) => receipts.push(r) }, () =>
      registry.execute('use_tool', {}, { conversationId: 'synthetic', callId: 'call-synthetic' })
    );
    expect(receipts.map((r) => [r.name, r.isError])).toEqual([
      ['core.real_action', false],
      ['core.failure', true],
      ['use_tool', false],
    ]);
  });
  it('an observer error cannot turn a committed action into a retry', async () => {
    const registry = new ToolRegistry();
    const write = vi.fn(async () => ({ content: 'saved' }));
    registry.register(
      { name: 'core.write', description: 'test', parameters: { type: 'object', properties: {} } },
      write
    );
    const result = await runInExecContext(
      {
        onToolResult: () => {
          throw new Error('observer failed');
        },
      },
      () =>
        registry.execute(
          'core.write',
          {},
          { conversationId: 'synthetic', callId: 'call-synthetic' }
        )
    );
    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('hides reasoning and uses bounded effort only on the intended Groq models', () => {
    expect(
      groqResponseOptions('https://api.groq.com/openai/v1', 'openai/gpt-oss-120b', 768)
    ).toEqual({ include_reasoning: false, reasoning_effort: 'low' });
    expect(groqResponseOptions('https://api.openai.com/v1', 'openai/gpt-oss-120b', 768)).toEqual(
      {}
    );
    expect(
      groqResponseOptions('https://api.groq.com.evil.test', 'openai/gpt-oss-120b', 768)
    ).toEqual({});
    expect(groqResponseOptions('https://api.groq.com/openai/v1', 'unknown', 768)).toEqual({});
  });
});
