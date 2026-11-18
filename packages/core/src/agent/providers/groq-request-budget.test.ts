import { describe, expect, it } from 'vitest';
import {
  applyGroqRequestBudget,
  getGroqRequestTokenLimit,
  getGroqEffectiveRequestTokenLimit,
} from './groq-request-budget.js';

describe('operator Groq chat token budget', () => {
  it.each(['', '0', '-1', '8e3', '8000.5', ' 8000', 'NaN', '9007199254740992'])(
    'does not activate a malformed/disabled budget: %j',
    (value) => expect(getGroqRequestTokenLimit(value)).toBeUndefined()
  );
  it('accepts a safe positive integer without guessing a provider quota', () => {
    expect(getGroqRequestTokenLimit('8000')).toBe(8000);
    expect(getGroqRequestTokenLimit('0008000')).toBe(8000);
  });
  it('uses the stricter request or quota ceiling with the exact admission margin', () => {
    expect(getGroqEffectiveRequestTokenLimit({})).toBe(5000);
    expect(getGroqEffectiveRequestTokenLimit({ GROQ_MAX_REQUEST_TOKENS: '8000' })).toBe(5000);
    expect(getGroqEffectiveRequestTokenLimit({ GROQ_MAX_REQUEST_TOKENS: '3000' })).toBe(3000);
    expect(
      getGroqEffectiveRequestTokenLimit({
        GROQ_MAX_REQUEST_TOKENS: '8000',
        GROQ_TOKENS_PER_MINUTE: '10000',
        GROQ_TOKEN_MARGIN_PERCENT: '25',
      })
    ).toBe(8000);
    expect(
      getGroqEffectiveRequestTokenLimit({
        GROQ_MAX_REQUEST_TOKENS: 'garbage',
        GROQ_TOKENS_PER_MINUTE: '0',
        GROQ_TOKEN_MARGIN_PERCENT: '-1',
      })
    ).toBe(5000);
  });
  it.each(['max_tokens', 'max_completion_tokens'])(
    'fits a normal answer and full tool context using %s',
    (field) => {
      const payload = {
        model: 'openai/gpt-oss-20b',
        messages: [
          { role: 'system', content: 'Use apenas dados confirmados. '.repeat(180) },
          { role: 'user', content: 'Resuma minha manhã com agenda e tarefas.' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'read-1', type: 'function', function: { name: 'list_tasks', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'read-1', content: '[]' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'list_tasks', parameters: { type: 'object', properties: {} } },
          },
        ],
        [field]: 8192,
        stream: false,
      };
      const original = JSON.stringify(payload);
      const result = applyGroqRequestBudget(original, 8000);
      const body = JSON.parse(String(result.body));
      expect(body[field]).toBeGreaterThanOrEqual(1024);
      expect(body[field]).toBeLessThan(8192);
      expect(
        Math.ceil(Buffer.byteLength(String(result.body)) / 4) + body[field]
      ).toBeLessThanOrEqual(8000);
      expect(body.messages).toEqual(payload.messages);
      expect(body.tools).toEqual(payload.tools);
      expect(JSON.stringify(payload)).toBe(original);
      expect(body).not.toHaveProperty(
        field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
      );
    }
  );
  it('keeps the required output allowance when context would leave only a fragment', () => {
    const original = JSON.stringify({
      messages: [{ role: 'user', content: 'x'.repeat(30_800) }],
      max_tokens: 8192,
    });
    const result = applyGroqRequestBudget(original, 8000);
    expect(JSON.parse(String(result.body)).max_tokens).toBe(8192);
    expect(result.request.requestTokensApprox + result.request.maxOutputTokens).toBeGreaterThan(
      8000
    );
    expect(JSON.parse(String(result.body)).messages).toEqual(JSON.parse(original).messages);
  });
  it('preserves an explicitly short answer limit and does not inflate it to the default floor', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'sim ou não' }],
      max_tokens: 20,
    });
    const result = applyGroqRequestBudget(body, 100);
    expect(JSON.parse(String(result.body)).max_tokens).toBe(20);
    expect(result.request.requestTokensApprox + result.request.maxOutputTokens).toBeLessThanOrEqual(
      100
    );
  });
  it('reserves useful output when omitted rather than treating it as zero tokens', () => {
    const small = applyGroqRequestBudget(
      JSON.stringify({ messages: [{ role: 'user', content: 'oi' }] }),
      8000
    );
    expect(JSON.parse(String(small.body)).max_tokens).toBe(1024);
    const large = applyGroqRequestBudget(
      JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(30_800) }] }),
      8000
    );
    expect(large.request.requestTokensApprox + large.request.maxOutputTokens).toBeGreaterThan(8000);
  });
  it('uses one output parameter when both supported aliases were supplied', () => {
    const result = applyGroqRequestBudget(
      JSON.stringify({ messages: [], max_tokens: 8192, max_completion_tokens: 2048 }),
      8000
    );
    const body = JSON.parse(String(result.body));
    expect(body.max_completion_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_tokens');
  });
  it('preserves audio/form data and unrelated bodies used by the shared transport', () => {
    const form = new FormData();
    form.set('model', 'whisper-large-v3-turbo');
    form.set('file', new Blob(['synthetic audio']), 'audio.ogg');
    expect(applyGroqRequestBudget(form, 8000).body).toBe(form);
    const json = JSON.stringify({ input: 'unrelated', max_tokens: 8192 });
    expect(applyGroqRequestBudget(json, 8000).body).toBe(json);
    expect(applyGroqRequestBudget('invalid json', 8000).body).toBe('invalid json');
  });
  it('does not modify payloads when the operator budget is absent or parameters are invalid', () => {
    const body = JSON.stringify({ messages: [], max_tokens: 8192 });
    expect(applyGroqRequestBudget(body, undefined).body).toBe(body);
    const invalid = JSON.stringify({ messages: [], max_tokens: -2 });
    expect(applyGroqRequestBudget(invalid, 8000).body).toBe(invalid);
  });
});
