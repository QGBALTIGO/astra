/** Update the two existing landing login links while retaining the public bundle. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants } from 'node:zlib';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath)
  throw new Error(
    'Usage: node scripts/prepare-landing-customer-entry.mjs public-bundle.json output-vars.json'
  );
const files = JSON.parse(readFileSync(inputPath, 'utf8'));
const oldLink = 'href="https://astra-gateway-production.up.railway.app/"';
const newLink = 'href="https://astra-gateway-production.up.railway.app/cliente/entrar"';
if (Object.keys(files).length !== 12 || typeof files['/index.html'] !== 'string')
  throw new Error('Unexpected landing bundle; review the current release first.');
const count = files['/index.html'].split(oldLink).length - 1;
if (count !== 2) throw new Error(`Expected two reviewed login links; found ${count}.`);
files['/index.html'] = files['/index.html'].replaceAll(oldLink, newLink);
const raw = Buffer.from(JSON.stringify(files));
const packed = brotliCompressSync(raw, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
}).toString('base64');
const size = Math.ceil(packed.length / 4);
const variables = { LANDING_ASSETS_SHA256: createHash('sha256').update(raw).digest('hex') };
for (let i = 0; i < 4; i++)
  variables[`LANDING_ASSETS_${i}`] = packed.slice(i * size, (i + 1) * size);
writeFileSync(outputPath, JSON.stringify(variables));
console.log(
  JSON.stringify({
    files: Object.keys(files).length,
    updatedLoginLinks: count,
    publicBundleSha256: variables.LANDING_ASSETS_SHA256,
    compressedBytes: packed.length,
  })
);
