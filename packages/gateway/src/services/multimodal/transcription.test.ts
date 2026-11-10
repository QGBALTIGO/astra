import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioApiUrl, transcribeAstraAudio } from './transcription.js';

vi.mock('../log.js', () => ({
  getLog: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const voice = Buffer.from('OggS-not-private-voice-data');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Astra multimodal speech-to-text', () => {
  it('builds OpenAI audio paths without duplicating /v1', () => {
    expect(audioApiUrl('https://api.groq.com/openai/v1', 'transcriptions')).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions'
    );
    expect(audioApiUrl('https://api.openai.com', 'translations')).toBe(
      'https://api.openai.com/v1/audio/translations'
    );
    expect(audioApiUrl('http://127.0.0.1:2022/v1/', 'transcriptions')).toBe(
      'http://127.0.0.1:2022/v1/audio/transcriptions'
    );
  });

  it('does not force Portuguese, leaving auto language detection enabled', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fake');
    vi.stubEnv('ASTRA_STT_LANGUAGE', 'auto');
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: 'Buenos días', language: 'spanish' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetcher);

    const result = await transcribeAstraAudio(voice, 'audio/ogg; codecs=opus');
    expect(result).toEqual(
      expect.objectContaining({
        text: 'Buenos días',
        language: 'spanish',
        engine: 'groq',
      })
    );
    const [url, opts] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((opts.body as FormData).get('language')).toBeNull();
    expect((opts.body as FormData).get('model')).toBe('whisper-large-v3-turbo');
    expect(opts.headers).toEqual({ Authorization: 'Bearer fake' });
  });

  it('preserves explicitly selected language without translation', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fake');
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: 'I am here', language: 'english' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetcher);

    const result = await transcribeAstraAudio(voice, 'audio/ogg', { language: 'en-US' });
    expect(result?.text).toBe('I am here');
    expect((fetcher.mock.calls[0][1].body as FormData).get('language')).toBe('en');
  });

  it('uses a private local engine and falls back once to Groq on failure', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fake');
    vi.stubEnv('ASTRA_STT_LOCAL_ENABLED', 'true');
    vi.stubEnv('ASTRA_STT_PROVIDER', 'auto');
    vi.stubEnv('ASTRA_STT_LOCAL_URL', 'http://astra-stt.railway.internal:8000');
    vi.stubEnv('ASTRA_STT_INTERNAL_TOKEN', 'local-only-test-key');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'Test transcript' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetcher);
    const result = await transcribeAstraAudio(voice, 'audio/ogg');
    expect(result?.engine).toBe('groq');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe(
      'http://astra-stt.railway.internal:8000/v1/audio/transcriptions'
    );
    expect(fetcher.mock.calls[1][0]).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('deduplicates concurrent requests from the same authenticated sender', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fake');
    const fetcher = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      return new Response(JSON.stringify({ text: 'Same words' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    const [a, b] = await Promise.all([
      transcribeAstraAudio(voice, 'audio/ogg', { scope: 'channel:sender-test-a' }),
      transcribeAstraAudio(voice, 'audio/ogg', { scope: 'channel:sender-test-a' }),
    ]);
    expect(a?.text).toBe('Same words');
    expect(b?.text).toBe('Same words');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not share cache entries between different authenticated senders', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fake');
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: 'Words' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await transcribeAstraAudio(voice, 'audio/ogg', { scope: 'channel:sender-test-b' });
    await transcribeAstraAudio(voice, 'audio/ogg', { scope: 'channel:sender-test-c' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown and empty audio without contacting a provider', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fake');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await transcribeAstraAudio(voice, 'application/x-executable')).toBeNull();
    expect(await transcribeAstraAudio(new Uint8Array(), 'audio/ogg')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns no fabricated transcript when both engines are unavailable', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fake');
    const fetcher = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const result = await transcribeAstraAudio(voice, 'audio/ogg');
    expect(result).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses public endpoints for the purported local engine', async () => {
    vi.stubEnv('GROQ_API_KEY', 'fake');
    vi.stubEnv('ASTRA_STT_LOCAL_ENABLED', 'true');
    vi.stubEnv('ASTRA_STT_LOCAL_URL', 'https://external.example.com');
    vi.stubEnv('ASTRA_STT_INTERNAL_TOKEN', 'local-key');
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: 'Protected' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const result = await transcribeAstraAudio(voice, 'audio/ogg');
    expect(result?.engine).toBe('groq');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
