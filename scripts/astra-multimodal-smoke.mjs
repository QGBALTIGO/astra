/**
 * Run inside the production Docker image as the unprivileged service user:
 * node scripts/astra-multimodal-smoke.mjs
 *
 * Generates synthetic data in memory. Never accesses actual user messages,
 * credentials, connected WhatsApp sessions, or production databases.
 */
import { createRequire } from 'node:module';
import {
  extractImageText,
  extractPdfText,
} from '../packages/gateway/dist/services/multimodal/document.js';

const require = createRequire(new URL('../packages/gateway/package.json', import.meta.url));
const sharp = require('sharp');

function makePdf(text) {
  const escaped = text.replace(/[\\()]/g, '\\$&');
  const stream = 'BT /F1 25 Tf 48 710 Td (' + escaped + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((value, index) => {
    offsets.push(Buffer.byteLength(document));
    document += index + 1 + ' 0 obj\n' + value + '\nendobj\n';
  });
  const xref = Buffer.byteLength(document);
  document += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    document += String(offset).padStart(10, '0') + ' 00000 n \n';
  });
  document +=
    'trailer\n<< /Size ' +
    (objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' +
    xref +
    '\n%%EOF\n';
  return Buffer.from(document);
}

const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="230">' +
    '<rect width="1100" height="230" fill="white"/>' +
    '<text x="36" y="148" font-family="DejaVu Sans" font-size="75" fill="black">RECIBO TESTE</text>' +
    '</svg>'
);
const image = await sharp(svg).png().toBuffer();
const imageResult = await extractImageText(image, 'image/png');
if (!imageResult || !/RECIBO/i.test(imageResult.text)) {
  throw new Error('Tesseract failed to read a synthetic receipt image');
}

const pdf = makePdf('RECIBO PIX TESTE VALOR R$ 78,90');
const pdfResult = await extractPdfText(pdf);
if (!pdfResult || pdfResult.source !== 'pdf_text' || !/RECIBO/i.test(pdfResult.text)) {
  throw new Error('pdftotext failed to read a generated PDF');
}
process.stdout.write('Astra OCR smoke OK: synthetic PNG and selectable-text PDF\n');
