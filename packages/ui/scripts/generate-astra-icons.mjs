import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Derive every platform icon from the approved vector; no fonts or redrawn mark.
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const approved = await readFile(publicDir + 'astra-approved-logo-light.svg', 'utf8');
const outputDir = publicDir + 'astra-icons/';
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  const mark = await page.evaluate((source) => {
    const documentSvg = new DOMParser().parseFromString(source, 'image/svg+xml');
    const symbol = documentSvg.querySelector('svg > g > g');
    if (!symbol || documentSvg.querySelector('parsererror'))
      throw new Error('Approved symbol missing');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.innerHTML = symbol.innerHTML;
    document.body.append(svg);
    const box = svg.getBBox();
    const result = {
      markup: symbol.innerHTML,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
    svg.remove();
    return result;
  }, approved);
  function vector(maskable = false) {
    const { x, y, width, height } = mark.box;
    // The maskable mark fits completely inside the platform's 40% safe circle.
    const scale = maskable
      ? (512 * 0.78) / Math.hypot(width, height)
      : 400 / Math.max(width, height);
    const tx = 256 - (x + width / 2) * scale;
    const ty = 256 - (y + height / 2) * scale;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><title>Astra</title><rect width="512" height="512" fill="#ffffff"/><g fill="#0061fd" transform="translate(${tx} ${ty}) scale(${scale})">${mark.markup}</g></svg>\n`;
  }
  async function raster(size, maskable = false, type = 'image/png') {
    const result = await page.evaluate(
      async ({ svg, size, type, maskable }) => {
        const image = new Image();
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, size, size);
        if (maskable) {
          const pixels = context.getImageData(0, 0, size, size).data;
          for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++) {
              const offset = (y * size + x) * 4;
              if (pixels[offset + 3] !== 255) throw new Error('Icon must be opaque');
              if (
                pixels[offset] < 240 &&
                Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > size * 0.4
              )
                throw new Error('Approved mark exceeds maskable safe zone');
            }
        }
        return canvas.toDataURL(type, 0.95).split(',')[1];
      },
      { svg: vector(maskable), size, type, maskable }
    );
    return Buffer.from(result, 'base64');
  }
  await writeFile(outputDir + 'astra-icon-v1.svg', vector());
  const pngs = new Map();
  for (const size of [16, 32, 48, 180, 192, 512]) pngs.set(size, await raster(size));
  await writeFile(outputDir + 'astra-192-v1.png', pngs.get(192));
  await writeFile(outputDir + 'astra-512-v1.png', pngs.get(512));
  await writeFile(outputDir + 'astra-maskable-512-v1.png', await raster(512, true));
  await writeFile(outputDir + 'astra-apple-touch-v1.png', pngs.get(180));
  await writeFile(outputDir + 'astra-favicon-32-v1.png', pngs.get(32));
  // Keep root aliases valid for Safari autodiscovery and already cached manifests.
  await writeFile(publicDir + 'apple-touch-icon.png', pngs.get(180));
  await writeFile(publicDir + 'logo.svg', vector());
  await writeFile(publicDir + 'ownpilot-logo.jpeg', await raster(256, false, 'image/jpeg'));
  const sizes = [16, 32, 48];
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  sizes.forEach((size, index) => {
    const position = 6 + index * 16;
    const png = pngs.get(size);
    directory[position] = directory[position + 1] = size;
    directory.writeUInt16LE(1, position + 4);
    directory.writeUInt16LE(32, position + 6);
    directory.writeUInt32LE(png.length, position + 8);
    directory.writeUInt32LE(offset, position + 12);
    offset += png.length;
  });
  await writeFile(
    publicDir + 'favicon.ico',
    Buffer.concat([directory, ...sizes.map((size) => pngs.get(size))])
  );
  console.log(
    'Astra icons generated from the approved vector; opaque maskable safe zone verified.'
  );
} finally {
  await browser.close();
}
