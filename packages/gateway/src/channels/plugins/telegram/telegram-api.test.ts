import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramChannelAPI } from './telegram-api.js';
import type { ChannelAttachment } from '@ownpilot/core/channels';

const { mockExecFile, mockWarn } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

vi.mock('../../../services/log.js', () => ({
  getLog: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
  }),
}));

function attachBot(api: TelegramChannelAPI) {
  const bot = {
    api: {
      sendAudio: vi.fn().mockResolvedValue({ message_id: 101 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 102 }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 103 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 104 }),
      sendVoice: vi.fn().mockResolvedValue({ message_id: 105 }),
    },
  };

  (api as unknown as { bot: typeof bot }).bot = bot;
  return bot;
}

function wavAttachment(): ChannelAttachment {
  return {
    type: 'audio',
    mimeType: 'audio/wav',
    filename: 'reply.wav',
    data: Buffer.from('wav-bytes'),
    size: 9,
  };
}

describe('TelegramChannelAPI voice attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      const outputPath = Array.isArray(args) ? args.at(-1) : undefined;
      import('node:fs/promises')
        .then((fs) => fs.writeFile(String(outputPath), Buffer.from('ogg-bytes')))
        .then(() => callback(null, '', ''))
        .catch((error) => callback(error));
    });
  });

  it('renders text and a structured dashboard URL with the new origins when an agent used historical links', async () => {
    const api = new TelegramChannelAPI({ bot_token: 'token' }, 'telegram');
    const bot = attachBot(api);
    await api.sendMessage({
      platformChatId: '123',
      text: 'Veja https://astraacessor.vercel.app/privacidade. Checkout https://pay.cakto.com.br/CubL455',
      urlButton: {
        label: 'Painel',
        url: 'https://astra-gateway-production.up.railway.app/cliente/entrar?utm=aviso#hoje',
      },
    });
    const sent = bot.api.sendMessage.mock.calls[0]![1];
    expect(sent).toContain('https://astraacessor.pro/privacidade.');
    expect(bot.api.sendMessage.mock.calls[0]![2]).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Painel', url: 'https://app.astraacessor.pro/cliente/entrar?utm=aviso#hoje' }],
        ],
      },
    });
    expect(sent).toContain('https://pay.cakto.com.br/CubL455');
    expect(sent).not.toMatch(/railway\.app|vercel\.app/);
  });
  it('converts forced voice audio to OGG/Opus before sending it as a Telegram voice message', async () => {
    const api = new TelegramChannelAPI({ bot_token: 'token' }, 'telegram');
    const bot = attachBot(api);

    const result = await api.sendMessage({
      platformChatId: 'chat-1',
      text: '',
      attachments: [wavAttachment()],
      options: { telegram: { asVoice: true } },
    });

    expect(result).toBe('105');
    expect(mockExecFile).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-acodec', 'libopus']),
      { timeout: 30000 },
      expect.any(Function)
    );
    expect(bot.api.sendVoice).toHaveBeenCalledOnce();
    expect(bot.api.sendAudio).not.toHaveBeenCalled();
  });

  it('falls back to a regular audio file when OGG/Opus conversion fails', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('ffmpeg missing'));
    });

    const api = new TelegramChannelAPI({ bot_token: 'token' }, 'telegram');
    const bot = attachBot(api);

    const result = await api.sendMessage({
      platformChatId: 'chat-1',
      text: '',
      attachments: [wavAttachment()],
      options: { telegram: { asVoice: true } },
    });

    expect(result).toBe('101');
    expect(mockWarn).toHaveBeenCalledWith(
      '[Telegram] Failed to convert audio to OGG/Opus voice format',
      { error: 'ffmpeg missing' }
    );
    expect(bot.api.sendVoice).not.toHaveBeenCalled();
    expect(bot.api.sendAudio).toHaveBeenCalledOnce();
  });
});
