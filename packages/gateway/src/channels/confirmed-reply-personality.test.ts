import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ routing: vi.fn(), create: vi.fn(), complete: vi.fn() }));
vi.mock('../services/llm/model-routing.js', () => ({ resolveForChannel: mocks.routing }));
vi.mock('../services/auth/oauth-flow.js', () => ({ resolveAuthForRequest: async () => undefined }));
vi.mock('../services/agent/cache.js', () => ({
  NATIVE_PROVIDERS: new Set(['groq']),
  getProviderApiKey: async () => 'synthetic',
  loadProviderConfig: () => ({ baseUrl: 'https://synthetic.invalid/v1' }),
}));
vi.mock('@ownpilot/core/agent', async (original) => ({
  ...(await original<typeof import('@ownpilot/core/agent')>()),
  createProvider: mocks.create,
}));
import {
  maybePersonalizeConfirmedReply,
  safePersonalComment,
} from './confirmed-reply-personality.js';
import { formatDueReminder } from './response-presentation.js';

const record =
  '✅ *Despesa registrada*\n\n• *Valor:* R$ 42,00\n• *Descrição:* pizza de calabresa\n• *Categoria:* Alimentação\n• *Data:* 13/11/2026';
const facts = 'Despesa registrada: *R$ 42,00* · pizza de calabresa\nAlimentação · 13/11/2026';
const input = {
  responseText: record,
  channelPluginId: 'channel.whatsapp',
  dataUserId: 'whatsapp:person',
  displayName: 'Kayky Silva',
  messageId: 'c',
};
const say = (content: string) => ({ ok: true, value: { content } });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.routing.mockResolvedValue({ provider: 'groq', model: 'small' });
  mocks.create.mockReturnValue({ complete: mocks.complete });
  mocks.complete.mockResolvedValue(say('Essa calabresa dispensou apresentações, Kayky! 🍕'));
});
afterEach(() => vi.useRealTimers());

describe('personal writing for private confirmations', () => {
  it('writes a contextual opening and preserves every stored field with zero tool access', async () => {
    expect(await maybePersonalizeConfirmedReply(input)).toBe(
      'Essa calabresa dispensou apresentações, Kayky! 🍕\n\n' + facts
    );
    const [request] = mocks.complete.mock.calls[0]!;
    expect(request.tools).toBeUndefined();
    expect(JSON.parse(request.messages[1].content)).toEqual({
      assunto: 'pizza de calabresa',
      contexto: 'Despesa registrada',
      nome: 'Kayky',
    });
    expect(request.messages[1].content).not.toMatch(/42|13\/11|Silva|whatsapp|person/);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });
  it('uses the name occasionally and never shares a different contact’s subject', async () => {
    await maybePersonalizeConfirmedReply(input);
    await maybePersonalizeConfirmedReply({
      ...input,
      displayName: 'Marta',
      messageId: 'a',
      dataUserId: 'telegram:other',
      responseText:
        '✅ *Lembrete agendado*\n\n• *Assunto:* buscar o livro\n• *Data e hora:* 13/11/2026, 18:30\n\nVou avisar você por aqui.',
    });
    const prompt = mocks.complete.mock.calls[1]![0].messages[1].content;
    expect(JSON.parse(prompt)).toEqual({
      assunto: 'buscar o livro',
      contexto: 'Lembrete agendado',
    });
    expect(prompt).not.toMatch(/pizza|Kayky|Marta/);
  });
  it.each([
    'Essa tarefa não consta na sua lista.',
    'A lista de avisos não abriu agora.',
    record + '\n\nAinda falta confirmar um item.',
    'Qual é o preço?',
  ])('leaves unrelated and partial replies intact', async (text) => {
    expect(await maybePersonalizeConfirmedReply({ ...input, responseText: text })).toBe(text);
    expect(mocks.routing).not.toHaveBeenCalled();
  });
  it.each([
    'Registrei R$ 500,00 no seu saldo.',
    'Acesse https://evil.example',
    'Paguei essa por você.',
  ])('rejects unsafe model text: %s', async (text) => {
    mocks.complete.mockResolvedValue(say(text));
    expect(await maybePersonalizeConfirmedReply(input)).toBe('🍕 ' + facts);
  });
  it('keeps private details out of the writing prompt and only sends exact facts to the user', async () => {
    const result = await maybePersonalizeConfirmedReply({
      ...input,
      responseText:
        '✅ *Lembrete agendado*\n\n• *Assunto:* buscar remédio privado\n• *Data e hora:* 13/11/2026, 08:00',
    });
    expect(result).toContain('buscar remédio privado');
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('keeps short contextual emoji responses and strips internal material', () => {
    expect(safePersonalComment('Forno aceso! 🍕')).toBe('Forno aceso! 🍕');
    expect(safePersonalComment('<think>técnico</think>')).toBeNull();
    expect(formatDueReminder('<think>privado</think>pegar o livro', 'Kayky')).toBe(
      '📚 Kayky, você pediu para eu te lembrar: pegar o livro'
    );
  });
  it.each([
    'Adicionei “comprar café” à sua lista de tarefas. Ela está pendente.',
    'Assinatura adicionada ao seu controle: Spotify · R$ 22,90 · renovação em 15/11/2026.',
    '✅ *Compromisso agendado*\n\n• *Assunto:* ensaio\n• *Início:* 13/11/2026, 17:00',
  ])('keeps the saved facts for %s', async (text) => {
    expect(await maybePersonalizeConfirmedReply({ ...input, responseText: text })).toContain(text);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it('returns facts on timeout and avoids duplicate writers for a busy customer', async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof say>) => void;
    mocks.complete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = maybePersonalizeConfirmedReply(input);
    await vi.advanceTimersByTimeAsync(1);
    expect(await maybePersonalizeConfirmedReply(input)).toBe('🍕 ' + facts);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBe('🍕 ' + facts);
    finish(say('Pizza! 🍕'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
});
