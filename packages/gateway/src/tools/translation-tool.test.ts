import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTranslate = vi.hoisted(() => vi.fn());
vi.mock('../services/multimodal/translation.js', () => ({
  translateAstraText: (...args: unknown[]) => mockTranslate(...args),
}));

import { TRANSLATE_TEXT_DEFINITION, translateTextExecutor } from './translation-tool.js';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('Astra translate_text tool', () => {
  it('has a discoverable schema for natural language agents', () => {
    expect(TRANSLATE_TEXT_DEFINITION.name).toBe('translate_text');
    expect(TRANSLATE_TEXT_DEFINITION.parameters.required).toEqual(['text', 'targetLanguage']);
  });

  it('binds scope to the authenticated ToolContext instead of model arguments', async () => {
    mockTranslate.mockResolvedValue({
      text: 'Good morning',
      engine: 'groq',
      sourceLanguage: 'pt',
      targetLanguage: 'en',
    });
    const params = {
      text: 'Bom dia',
      targetLanguage: 'en',
      sourceLanguage: 'pt',
      userId: 'whatsapp:99999999991', // untrusted model argument must not control scope
    };
    const context = {
      callId: 'synthetic-1',
      conversationId: 'synthetic-conversation',
      userId: 'whatsapp:99999999992',
    };
    const result = await translateTextExecutor(params, context);
    expect(result.isError).not.toBe(true);
    expect(mockTranslate).toHaveBeenCalledWith('Bom dia', 'en', {
      sourceLanguage: 'pt',
      scope: 'whatsapp:99999999992',
      allowExternal: true,
    });
  });

  it('returns truthful errors for invalid parameters and unavailable providers', async () => {
    const context = { callId: 'a', conversationId: 'b', userId: 'wa-a' };
    const invalid = await translateTextExecutor({ text: '', targetLanguage: 42 }, context);
    expect(invalid.isError).toBe(true);
    expect(mockTranslate).not.toHaveBeenCalled();

    mockTranslate.mockResolvedValue(null);
    const failed = await translateTextExecutor({ text: 'Hola', targetLanguage: 'pt-BR' }, context);
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('Não foi possível traduzir');
  });
});
