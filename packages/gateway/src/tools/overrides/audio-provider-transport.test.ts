import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWhisperTranscribe } from './audio.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('channel Whisper provider endpoint compatibility', () => {
  it('sends the Groq audio model and correct endpoint through the shared real pool', async () => {
    vi.stubEnv('GROQ_API_KEY', 'synthetic-telegram-audio');
    for (let i = 2; i <= 10; i++) vi.stubEnv(`GROQ_API_KEY_${i}`, '');
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) =>
      Response.json({
        text: 'Áudio fictício',
        duration: 2,
        segments: [{ start: 0, end: 2, text: 'Áudio fictício' }],
      })
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await callWhisperTranscribe(
      'synthetic-telegram-audio',
      'https://api.groq.com/openai/v1',
      Buffer.from('synthetic'),
      'voice.ogg',
      {}
    );
    expect(result.text).toBe('Áudio fictício');
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((fetcher.mock.calls[0]![1].body as FormData).get('model')).toBe(
      'whisper-large-v3-turbo'
    );
  });
  it.each(['https://api.openai.com', 'https://api.openai.com/v1/'])(
    'does not duplicate the OpenAI v1 path: %s',
    async (base) => {
      const fetcher = vi.fn(async (_url: string, _options: RequestInit) =>
        Response.json({ text: 'Fictício' })
      );
      vi.stubGlobal('fetch', fetcher);
      await callWhisperTranscribe('synthetic', base, Buffer.from('synthetic'), 'voice.wav', {});
      expect(fetcher.mock.calls[0]![0]).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect((fetcher.mock.calls[0]![1].body as FormData).get('model')).toBe('whisper-1');
      expect(fetcher.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    }
  );
});
