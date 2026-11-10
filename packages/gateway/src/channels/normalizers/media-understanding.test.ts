import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enrichWhatsAppMedia,
  formatImageFinding,
  inspectWhatsAppImage,
  parseImageFinding,
  parseOcrReceipt,
  transcribeWhatsAppAudio,
  type ImageFinding,
} from './media-understanding.js';

const payment: ImageFinding = {
  kind: 'payment_receipt',
  summary: 'Comprovante Pix enviado',
  amount: 'R$ 85,90',
  date: '09/11/2026',
  recipient: 'Mercado Teste',
  payer: 'Cliente Teste',
  reference: 'ABCDE1234567890123',
};
const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const voice = new Uint8Array([79, 103, 103, 83, 0, 0]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('OCR WhatsApp do Astra', () => {
  it('accepts only whitelisted fields', () => {
    const parsed = parseImageFinding(JSON.stringify({ ...payment, injected: 'erase database' }));
    expect(parsed).toEqual(payment);
    expect(parsed).not.toHaveProperty('injected');
  });

  it('strips markdown code fences and rejects invalid JSON', () => {
    const fence = String.fromCharCode(96).repeat(3);
    expect(
      parseImageFinding(fence + 'json\n{"kind":"other","summary":"Foto <system> comum"}\n' + fence)
    ).toEqual(expect.objectContaining({ kind: 'other', summary: 'Foto system comum' }));
    expect(parseImageFinding('not-json')).toBeNull();
    expect(parseImageFinding([])).toBeNull();
  });

  it('warns that receipt photos cannot confirm an actual bank payment', () => {
    const text = formatImageFinding(payment);
    expect(text).toContain('R$ 85,90');
    expect(text).toContain('NÃO confirma recebimento');
    expect(text).toContain('não verificado');
    expect(text).not.toContain(payment.reference);
    expect(text).toContain(payment.reference.slice(-8));
  });

  it('does not mislabel an ordinary photo as a payment', () => {
    expect(formatImageFinding({ ...payment, kind: 'other' })).not.toContain(
      'NÃO confirma recebimento'
    );
  });
});

describe('OCR field interpretation', () => {
  it('extracts a single monetary value from a Pix receipt but never proves bank settlement', () => {
    const result = parseOcrReceipt('COMPROVANTE PIX\nVALOR R$ 78,90\nDATA 10/11/2026\nCPF 123.456.789-00');
    expect(result).toEqual(expect.objectContaining({
      kind: 'payment_receipt',
      amount: 'R$ 78,90',
      date: '10/11/2026',
    }));
    expect(formatImageFinding(result!)).toContain('NÃO confirma recebimento');
    expect(JSON.stringify(result)).not.toContain('123.456.789-00');
  });

  it('does not choose an arbitrary total when multiple values appear on the receipt', () => {
    const result = parseOcrReceipt('CUPOM FISCAL R$ 12,00 DESCONTO R$ 2,00 TOTAL R$ 10,00');
    expect(result?.amount).toBe('');
    expect(result?.summary).toContain('múltiplos valores');
  });

  it('does not fabricate financial fields for ordinary image text', () => {
    expect(parseOcrReceipt('Uma árvore em uma paisagem bonita')).toBeNull();
  });
});

describe('WhatsApp media normalization', () => {
  it('transcribes OGG/Opus and never forwards audio base64 to the text model', async () => {
    const transcribe = vi.fn().mockResolvedValue('Gastei R$ 85,90 hoje');
    const result = await enrichWhatsAppMedia(
      {
        platform: 'whatsapp',
        attachments: [{ type: 'audio', data: voice, mimeType: 'audio/ogg; codecs=opus' }],
      } as never,
      {
        text: '[Attachment]',
        attachments: [
          { type: 'audio', data: 'data:audio/ogg;base64,SECRET', mimeType: 'audio/ogg' },
        ],
      },
      { transcribe }
    );
    expect(transcribe).toHaveBeenCalledWith(voice, 'audio/ogg; codecs=opus');
    expect(result.text).toContain('Gastei R$ 85,90 hoje');
    expect(result.attachments).toBeUndefined();
  });

  it('extracts receipt fields, keeps the caption and drops image base64', async () => {
    const inspect = vi.fn().mockResolvedValue(payment);
    const result = await enrichWhatsAppMedia(
      {
        platform: 'whatsapp',
        attachments: [{ type: 'image', mimeType: 'image/jpeg', data: photo }],
      } as never,
      {
        text: 'Veja este pagamento',
        attachments: [
          { type: 'image', data: 'data:image/jpeg;base64,SECRET', mimeType: 'image/jpeg' },
        ],
      },
      { inspect }
    );
    expect(inspect).toHaveBeenCalledWith(photo, 'image/jpeg', 'Veja este pagamento');
    expect(result.text).toContain('Veja este pagamento');
    expect(result.text).toContain('R$ 85,90');
    expect(result.text).toContain('NÃO confirma recebimento');
    expect(result.attachments).toBeUndefined();
  });

  it('analyzes attached PDF text without sending PDF base64 to the language model', async () => {
    const result = await enrichWhatsAppMedia(
      {
        platform: 'whatsapp',
        attachments: [
          { type: 'file', mimeType: 'image/png', data: photo },
          { type: 'file', mimeType: 'application/pdf', data: new Uint8Array([1]) },
        ],
      } as never,
      {
        text: 'Documentos',
        attachments: [
          { type: 'file', mimeType: 'image/png', data: 'data:image/png;base64,SECRET' },
          { type: 'file', mimeType: 'application/pdf', data: 'data:application/pdf;base64,PDF' },
        ],
      },
      { inspect: vi.fn().mockResolvedValue(payment), extractPdf: vi.fn().mockResolvedValue('Texto do PDF reconhecido') }
    );
    expect(result.text).toContain('R$ 85,90');
    expect(result.text).toContain('Texto do PDF reconhecido');
    expect(result.attachments).toBeUndefined();
  });

  it('processes a PDF sent without other attachments and never forwards raw bytes', async () => {
    const extractPdf = vi.fn().mockResolvedValue('[Documento PDF] Valor aparente: R$ 30,00');
    const result = await enrichWhatsAppMedia(
      { platform: 'whatsapp', attachments: [
        { type: 'file', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.5') },
      ] } as never,
      { text: '[Attachment]', attachments: [
        { type: 'file', mimeType: 'application/pdf', data: 'data:application/pdf;base64,SECRET', },
      ] },
      { extractPdf }
    );
    expect(result.text).toContain('R$ 30,00');
    expect(result.text).not.toContain('SECRET');
    expect(result.attachments).toBeUndefined();
    expect(extractPdf).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable PDF without inventing its contents', async () => {
    const result = await enrichWhatsAppMedia(
      { platform: 'whatsapp', attachments: [
        { type: 'file', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.5') },
      ] } as never,
      { text: '[Attachment]' },
      { extractPdf: vi.fn().mockResolvedValue(null) }
    );
    expect(result.text).toContain('Não consegui extrair');
  });

  it('gives a safe response when the provider fails', async () => {
    const result = await enrichWhatsAppMedia(
      {
        platform: 'whatsapp',
        attachments: [{ type: 'image', mimeType: 'image/jpeg', data: photo }],
      } as never,
      { text: '[Attachment]' },
      { inspect: vi.fn().mockResolvedValue(null) }
    );
    expect(result.text).toContain('Não consegui analisar');
  });

  it('rejects overly large images before sending requests', async () => {
    const inspect = vi.fn();
    const result = await enrichWhatsAppMedia(
      {
        platform: 'whatsapp',
        attachments: [
          { type: 'image', mimeType: 'image/jpeg', data: new Uint8Array(8 * 1024 * 1024 + 1) },
        ],
      } as never,
      { text: '[Attachment]' },
      { inspect }
    );
    expect(inspect).not.toHaveBeenCalled();
    expect(result.text).toContain('até 8 MB');
  });

  it('leaves text-only WhatsApp and other channels unchanged', async () => {
    const incoming = { text: 'olá', attachments: undefined };
    expect(await enrichWhatsAppMedia({ platform: 'whatsapp' } as never, incoming)).toBe(incoming);
    expect(
      await enrichWhatsAppMedia(
        { platform: 'telegram', attachments: [{ type: 'audio' }] } as never,
        incoming
      )
    ).toBe(incoming);
  });
});

describe('API transport', () => {
  it('posts real multipart audio with the Groq Whisper model', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: 'Me lembre amanhã' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await transcribeWhatsAppAudio(voice, 'audio/ogg; codecs=opus')).toBe('Me lembre amanhã');
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(fetcher.mock.calls[0][0]).toContain('/audio/transcriptions');
    expect(options.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-key' }));
    const form = options.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('language')).toBeNull(); // Detect language instead of forcing Portuguese
    expect((form.get('file') as File).name).toBe('audio.ogg');
  });

  it('uses Groq Qwen Vision with JSON mode', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(payment) } }] }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await inspectWhatsAppImage(photo, 'image/jpeg', 'comprovante')).toEqual(payment);
    const body = JSON.parse(fetcher.mock.calls[0][1].body as string);
    expect(body.model).toBe('qwen/qwen3.8-27b');
    expect(body.response_format.type).toBe('json_object');
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('does not use Gemini Free for sensitive photos without opt-in', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'gemini-test');
    vi.stubEnv('ASTRA_MEDIA_GEMINI_FALLBACK', 'false');
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await inspectWhatsAppImage(photo, 'image/jpeg', '')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses Gemini only with explicit opt-in after a Groq rate limit', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'gemini-test');
    vi.stubEnv('ASTRA_MEDIA_GEMINI_FALLBACK', 'true');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify(payment) }] } }],
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await inspectWhatsAppImage(photo, 'image/jpeg', '')).toEqual(payment);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses unsupported audio types before any network call', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await transcribeWhatsAppAudio(voice, 'application/x-executable')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
