import { afterEach, describe, expect, it, vi } from 'vitest';
import { translateAstraText } from './translation.js';

vi.mock('../log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function groqResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
  });
}

describe('Astra text translation', () => {
  it('translates English into Brazilian Portuguese through configured Groq', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const fetcher = vi.fn().mockResolvedValue(groqResponse('Bom dia, como você está?'));
    vi.stubGlobal('fetch', fetcher);
    const result = await translateAstraText('Good morning, how are you?', 'pt-BR', {
      sourceLanguage: 'en',
      scope: 'demo:translation-en-pt',
    });
    expect(result).toMatchObject({
      text: 'Bom dia, como você está?',
      engine: 'groq',
      sourceLanguage: 'en',
      targetLanguage: 'pt-br',
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.messages[1].content).toBe('Good morning, how are you?');
    expect(body.messages[0].content).toContain('Preserve names, numeric values');
  });

  it('uses an authenticated-scope cache only for the same sender', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const fetcher = vi.fn().mockImplementation(async () => groqResponse('Hola'));
    vi.stubGlobal('fetch', fetcher);
    const a = await translateAstraText('Olá', 'es', { scope: 'demo:person-one' });
    const b = await translateAstraText('Olá', 'es', { scope: 'demo:person-one' });
    const c = await translateAstraText('Olá', 'es', { scope: 'demo:person-two' });
    expect(a?.text).toBe('Hola');
    expect(b?.text).toBe('Hola');
    expect(c?.text).toBe('Hola');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses private offline translation without sending text to Groq', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    vi.stubEnv('ASTRA_TRANSLATE_LOCAL_ENABLED', 'true');
    vi.stubEnv('ASTRA_TRANSLATE_LOCAL_URL', 'http://astra-translate.railway.internal:8000');
    vi.stubEnv('ASTRA_TRANSLATE_INTERNAL_TOKEN', 'private-key');
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ translatedText: 'Bonjour' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetcher);
    const result = await translateAstraText('Bom dia', 'fr', {
      sourceLanguage: 'pt',
      scope: 'demo:offline',
    });
    expect(result?.engine).toBe('local');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('http://astra-translate.railway.internal:8000/translate');
  });

  it('falls back after local failure only with external consent', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    vi.stubEnv('ASTRA_TRANSLATE_LOCAL_ENABLED', 'true');
    vi.stubEnv('ASTRA_TRANSLATE_LOCAL_URL', 'http://127.0.0.1:9000');
    vi.stubEnv('ASTRA_TRANSLATE_INTERNAL_TOKEN', 'private-key');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(groqResponse('Good morning'));
    vi.stubGlobal('fetch', fetcher);
    const result = await translateAstraText('Bom dia', 'en', { sourceLanguage: 'pt' });
    expect(result?.engine).toBe('groq');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not forward sensitive documents to Groq without consent', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await translateAstraText('Comprovante bancário R$ 123,00', 'en', {
      allowExternal: false,
    });
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects missing text, invalid languages and out-of-range sizes', async () => {
    expect(await translateAstraText('', 'en')).toBeNull();
    expect(await translateAstraText('Hola', '<script>')).toBeNull();
    expect(await translateAstraText('foo'.repeat(7000), 'pt-BR')).toBeNull();
  });

  it('splits lengthy input without losing content between chunks', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const pieces: string[] = [];
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const piece = body.messages[1].content;
      pieces.push(piece);
      return groqResponse(piece);
    });
    vi.stubGlobal('fetch', fetcher);
    const source = 'Palavras e números 123. \n'.repeat(180);
    const result = await translateAstraText(source, 'es');
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(source);
    expect(result?.text).toBe(source);
  });
});
