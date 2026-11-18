import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groqAudioTranscription } from './groq-audio-transport.js';

let run = 0;
let first: string;
let backup: string;
beforeEach(() => {
  first = `synthetic-audio-primary-${++run}`;
  backup = `synthetic-audio-backup-${run}`;
  vi.stubEnv('GROQ_API_KEY', first);
  vi.stubEnv('GROQ_API_KEY_2', backup);
  vi.stubEnv('GROQ_QUOTA_GROUPS', '');
  for (let i = 3; i <= 10; i++) vi.stubEnv(`GROQ_API_KEY_${i}`, '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function audio() {
  const form = new FormData();
  form.append('model', 'whisper-large-v3-turbo');
  form.append('file', new Blob(['synthetic-audio']), 'test.ogg');
  form.append('response_format', 'json');
  return form;
}
describe('bounded Groq audio credential failover', () => {
  it.each([429, 401, 503])(
    'reuses the same audio on an independent key after HTTP %s',
    async (status) => {
      vi.stubEnv(
        'GROQ_QUOTA_GROUPS',
        JSON.stringify({
          GROQ_API_KEY: `audio-organization-${run}-primary`,
          GROQ_API_KEY_2: `audio-organization-${run}-backup`,
        })
      );
      const sent: Array<{ key: string | null; body: unknown; url: string }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, options: RequestInit) => {
          sent.push({
            key: new Headers(options.headers).get('authorization'),
            body: options.body,
            url,
          });
          return sent.length === 1
            ? Response.json(
                { error: { message: 'synthetic failure' } },
                { status, headers: { 'retry-after': '1' } }
              )
            : Response.json({ text: 'Me lembre do ensaio fictício.' });
        })
      );
      const form = audio();
      expect(await groqAudioTranscription(form, first, 'json')).toEqual({
        text: 'Me lembre do ensaio fictício.',
      });
      expect(sent.map((s) => s.key)).toEqual(['Bearer ' + first, 'Bearer ' + backup]);
      expect(
        sent.every(
          (s) => s.body === form && s.url === 'https://api.groq.com/openai/v1/audio/transcriptions'
        )
      ).toBe(true);
    }
  );
  it('does not rotate unknown operator credentials after an organization quota failure', async () => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
      Response.json(
        { error: { message: 'synthetic quota exhausted' } },
        { status: 429, headers: { 'retry-after': '30' } }
      )
    );
    vi.stubGlobal('fetch', fetch);
    await expect(groqAudioTranscription(audio(), first, 'json')).rejects.toThrow('HTTP 429');
    await expect(groqAudioTranscription(audio(), first, 'json')).rejects.toThrow('HTTP 429');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer ' + first
    );
  });
  it('does not send operator reserves when the caller supplies its own key', async () => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
      Response.json({ error: { message: 'unavailable' } }, { status: 429 })
    );
    vi.stubGlobal('fetch', fetch);
    await expect(groqAudioTranscription(audio(), 'tenant-owned-key', 'json')).rejects.toThrow(
      'HTTP 429'
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer tenant-owned-key'
    );
  });
  it('bounds a stalled request and its response body with one deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream({ start() {} })))
    );
    const result = groqAudioTranscription(audio(), first, 'json', 500);
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(501);
    await rejected;
  });
});
