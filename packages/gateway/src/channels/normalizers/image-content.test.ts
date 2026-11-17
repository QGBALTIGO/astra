import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '@ownpilot/core/agent';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { telegramNormalizer } from './telegram.js';
import { attachmentImageContent } from './image-content.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('normalized channel images reach the provider with one data URI prefix', () => {
  it('connects the actual Telegram normalizer and provider JSON transport', async () => {
    const bytes = Buffer.from('synthetic image bytes');
    const normalized = await telegramNormalizer.normalizeIncoming({
      id: 'synthetic-media',
      platform: 'telegram',
      channelPluginId: 'telegram-test',
      platformChatId: 'synthetic-chat',
      sender: { platformUserId: 'synthetic-user' },
      text: 'Descreva a imagem fictícia',
      attachments: [{ type: 'image', data: bytes, mimeType: 'image/png' }],
    } as ChannelIncomingMessage);
    const image = attachmentImageContent(normalized.attachments![0]!);
    expect(image?.data).toBe(bytes.toString('base64'));
    vi.stubEnv('OWNPILOT_ALLOW_LOCAL_LLM_URL', 'true');
    let captured: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body));
        return Response.json({
          choices: [{ message: { content: 'Imagem de teste' }, finish_reason: 'stop' }],
        });
      })
    );
    const provider = new OpenAICompatibleProvider({
      id: 'synthetic-vision',
      name: 'Synthetic',
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic-key',
      features: {
        streaming: true,
        vision: true,
        toolUse: false,
        jsonMode: false,
        systemMessage: true,
      },
      models: [],
      timeout: 1000,
    });
    expect(
      (
        await provider.complete({
          messages: [
            {
              id: 'message',
              role: 'user',
              content: [{ type: 'text', text: normalized.text }, image!],
            },
          ],
          model: { model: 'synthetic-model', maxTokens: 64 },
        })
      ).ok
    ).toBe(true);
    const wire = JSON.stringify(captured);
    expect(wire).toContain('data:image/png;base64,' + bytes.toString('base64'));
    expect(wire.match(/data:image\/png;base64,/g)).toHaveLength(1);
    expect(wire).not.toContain('synthetic-key');
  });
  it('preserves already raw base64 and rejects mismatched or non-image data URIs', () => {
    expect(
      attachmentImageContent({ type: 'image', data: 'YQ==', mimeType: 'image/png' })?.data
    ).toBe('YQ==');
    expect(
      attachmentImageContent({
        type: 'image',
        data: 'data:image/jpeg;base64,YQ==',
        mimeType: 'image/png',
      })
    ).toBeNull();
    expect(
      attachmentImageContent({
        type: 'image',
        data: 'data:text/html;base64,YQ==',
        mimeType: 'image/png',
      })
    ).toBeNull();
    expect(
      attachmentImageContent({ type: 'file', data: 'YQ==', mimeType: 'image/png' })
    ).toBeNull();
  });
});
