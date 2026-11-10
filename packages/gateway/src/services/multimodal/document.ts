/**
 * Astra: private on-container OCR and bounded PDF text extraction.
 * OCR is a transcription of visible marks, never proof of payment settlement.
 * Sensitive document contents and command stderr must not be logged.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 8_000;
const MAX_OUTPUT_BYTES = 150_000;
const OCR_TIMEOUT_MS = 14_000;
const PDF_TIMEOUT_MS = 9_000;
const MAX_CONCURRENT = 2;
let running = 0;

export interface ExtractedDocumentText {
  text: string;
  source: 'ocr' | 'pdf_text';
  pages: number;
}

/** No shell, no arguments originating in untrusted filenames or prompts. */
function runCommand(
  executable: string,
  args: string[],
  input: Uint8Array | undefined,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Local document processing timed out'));
      else if (overflow) reject(new Error('Local document output exceeded limit'));
      else if (code !== 0) reject(new Error('Local document processor failed'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ? Buffer.from(input) : undefined);
  });
}

async function withSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) throw new Error('Document processing is busy');
  running++;
  try {
    return await operation();
  } finally {
    running--;
  }
}

export async function extractImageText(
  data: Uint8Array,
  mimeType: string
): Promise<ExtractedDocumentText | null> {
  const mime = mimeType.toLowerCase().split(';', 1)[0]!.trim();
  if (process.env.ASTRA_OCR_LOCAL_ENABLED === 'false') return null;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return null;
  if (!data.length || data.length > MAX_IMAGE_BYTES) return null;
  try {
    return await withSlot(async () => {
      const image = await sharp(Buffer.from(data), { limitInputPixels: 15_000_000 })
        .rotate()
        .resize({ width: 1800, withoutEnlargement: true })
        .normalize()
        .png()
        .toBuffer();
      const text = await runCommand(
        'tesseract',
        ['stdin', 'stdout', '-l', 'por+eng', '--psm', '6'],
        image,
        OCR_TIMEOUT_MS
      );
      if (!text.trim()) return null;
      return { text: text.slice(0, MAX_TEXT_CHARS), source: 'ocr', pages: 1 };
    });
  } catch {
    return null;
  }
}

/** pdftotext is tried before OCR; scan only the first two pages if needed. */
export async function extractPdfText(data: Uint8Array): Promise<ExtractedDocumentText | null> {
  if (process.env.ASTRA_OCR_LOCAL_ENABLED === 'false') return null;
  if (!data.length || data.length > MAX_PDF_BYTES) return null;
  if (!Buffer.from(data.subarray(0, 5)).equals(Buffer.from('%PDF-'))) return null;
  try {
    return await withSlot(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'astra-doc-'));
      try {
        const input = join(dir, 'document.pdf');
        await writeFile(input, data, { mode: 0o600, flag: 'wx' });
        const text = await runCommand(
          'pdftotext',
          ['-f', '1', '-l', '4', '-layout', input, '-'],
          undefined,
          PDF_TIMEOUT_MS
        );
        if (text.trim().length > 24) {
          return { text: text.slice(0, MAX_TEXT_CHARS), source: 'pdf_text', pages: 4 };
        }
        const output: string[] = [];
        for (let page = 1; page <= 2; page++) {
          const prefix = join(dir, 'render-' + page);
          try {
            await runCommand(
              'pdftoppm',
              [
                '-f',
                String(page),
                '-l',
                String(page),
                '-singlefile',
                '-scale-to',
                '1500',
                '-png',
                input,
                prefix,
              ],
              undefined,
              PDF_TIMEOUT_MS
            );
            const png = await readFile(prefix + '.png');
            const result = await runCommand(
              'tesseract',
              ['stdin', 'stdout', '-l', 'por+eng', '--psm', '6'],
              png,
              OCR_TIMEOUT_MS
            );
            if (result.trim()) output.push(result);
          } catch {
            if (!output.length) continue;
            break;
          }
        }
        if (!output.length) return null;
        return {
          text: output.join('\n\n').slice(0, MAX_TEXT_CHARS),
          source: 'ocr',
          pages: output.length,
        };
      } finally {
        await rm(dir, { force: true, recursive: true }).catch(() => undefined);
      }
    });
  } catch {
    return null;
  }
}
