/**
 * Run inside the production Docker image as the unprivileged service user:
 * node scripts/astra-multimodal-smoke.mjs
 *
 * Generates synthetic data in memory. Never accesses actual user messages,
 * credentials, connected WhatsApp sessions, or production databases.
 */
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
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

function makeScannedPdf(raw, width, height) {
  // Image-only PDF with no text layer, to exercise Poppler rendering and OCR.
  const drawing = Buffer.from('q\n530 0 0 130 42 600 cm\n/Im1 Do\nQ\n', 'ascii');
  const pixels = deflateSync(raw);
  const image = Buffer.concat([
    Buffer.from(
      '<< /Type /XObject /Subtype /Image /Width ' + width + ' /Height ' + height +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' +
      pixels.length + ' >>\nstream\n',
      'ascii'
    ),
    pixels,
    Buffer.from('\nendstream', 'ascii'),
  ]);
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
      'ascii'
    ),
    Buffer.concat([
      Buffer.from('<< /Length ' + drawing.length + ' >>\nstream\n', 'ascii'),
      drawing,
      Buffer.from('endstream', 'ascii'),
    ]),
    image,
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xff\xff\xff\xff\n', 'binary')];
  const offsets = [0];
  let position = parts[0].length;
  objects.forEach((value, index) => {
    offsets.push(position);
    const obj = Buffer.concat([
      Buffer.from(String(index + 1) + ' 0 obj\n', 'ascii'),
      value,
      Buffer.from('\nendobj\n', 'ascii'),
    ]);
    parts.push(obj);
    position += obj.length;
  });
  let xref = 'xref\n0 ' + String(objects.length + 1) + '\n0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    xref += String(offset).padStart(10, '0') + ' 00000 n \n';
  });
  xref +=
    'trailer\n<< /Size ' + String(objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' + String(position) + '\n%%EOF\n';
  parts.push(Buffer.from(xref, 'ascii'));
  return Buffer.concat(parts);
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
const { data: rgb, info } = await sharp(svg)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
if (info.channels !== 3) throw new Error('Unexpected RGB channel count');
const scannedPdf = makeScannedPdf(rgb, info.width, info.height);
const scannedResult = await extractPdfText(scannedPdf);
if (!scannedResult || scannedResult.source !== 'ocr' || !/RECIBO/i.test(scannedResult.text)) {
  throw new Error('Local OCR failed on image-only scanned PDF');
}
process.stdout.write(
  'Astra OCR smoke OK: synthetic PNG, selectable-text PDF and scanned PDF\n'
);
