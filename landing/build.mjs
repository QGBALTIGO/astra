import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pages } from './src/legal.mjs';
import { publicPages } from './src/public-pages.mjs';
import { header, footer, dialogs } from './src/shared.mjs';
import { trialCtas, trialAffiliateHtml } from './src/trial.mjs';
import {
  homeMetadata,
  metadataHead,
  structuredData,
  release,
  indexNowKey,
  googleSiteVerification,
  siteOrigin,
} from './src/seo.mjs';
import { minify } from 'terser';
import CleanCSS from 'clean-css';
import { minify as minifyHtml } from 'html-minifier-terser';
import { encodeZ85, decodeZ85, z85Alphabet } from './transport.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'assets'), { recursive: true });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const files = {};
const paths = {};
const names = (await readdir(join(root, 'src/assets'))).sort();
const textual = new Set(['.svg', '.css', '.js', '.txt']);
const isText = (name) => [...textual].some((ext) => name.endsWith(ext));
const replaceAssets = (text) => {
  let value = text;
  for (const [source, target] of Object.entries(paths)) value = value.replaceAll(source, target);
  return value;
};
async function asset(name) {
  let raw = await readFile(join(root, 'src/assets', name));
  if (isText(name)) raw = Buffer.from(replaceAssets(raw.toString('utf8')));
  if (name.endsWith('.js')) {
    const { code } = await minify(raw.toString('utf8'), { module: true });
    raw = Buffer.from(code);
  }
  if (name.endsWith('.css')) {
    const css = new CleanCSS({ level: 0, rebase: false }).minify(raw.toString('utf8'));
    if (css.errors.length) throw new Error(css.errors.join('\n'));
    raw = Buffer.from(css.styles);
  }
  const ext = name.slice(name.lastIndexOf('.'));
  const stem = name.slice(0, -ext.length);
  // Official logo files already carry a content identity; their bytes stay intact.
  const target = name.startsWith('brand-')
    ? `/assets/${name}`
    : `/assets/${stem}-${digest(raw).slice(0, 12)}${ext}`;
  paths[`/assets/${name}`] = target;
  paths[`./${name}`] = `.${target.slice(7)}`;
  files[target] = isText(name) ? raw.toString('utf8') : `BASE64:${raw.toString('base64')}`;
  await writeFile(join(dist, target.slice(1)), raw);
}
// Dependencies first, then the CSS and JavaScript that refer to them.
for (const name of names.filter((name) => !['app.js', 'styles.css'].includes(name)))
  await asset(name);
await asset('styles.css');
await asset('app.js');
const render = (html) =>
  replaceAssets(
    trialCtas(html).replace(
      /\{\{icon:([a-z-]+)\}\}/g,
      (_, name) =>
        `<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#${name}"></use></svg>`
    )
  );
const compactHtml = (html) =>
  minifyHtml(html, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    quoteCharacter: '"',
  });
const source = await readFile(join(root, 'src/index.html'), 'utf8');
const baseHead =
  source.match(/<head>([\s\S]*?)<\/head>/)[1] +
  `<meta name="google-site-verification" content="${googleSiteVerification}">`;
const index = await compactHtml(
  render(
    source.replace(
      /<head>[\s\S]*?<\/head>/,
      `<head>${metadataHead(baseHead, homeMetadata)}${structuredData(homeMetadata)}</head>`
    )
  )
);
files['/index.html'] = index;
await writeFile(join(dist, 'index.html'), index);
for (const page of publicPages) {
  const head = metadataHead(baseHead, page) + structuredData(page);
  const html = await compactHtml(
    render(
      `<!doctype html><html lang="pt-BR"><head>${head}</head><body${page.path === '/demonstracao' ? ' class="demo-page"' : ''}><a class="skip-link" href="#principal">Pular para o conteúdo</a>${header}<main id="principal">${page.body}</main>${footer}${dialogs}</body></html>`
    )
  );
  const path = `${page.path}.html`;
  files[path] = html;
  await writeFile(join(dist, path.slice(1)), html);
}
for (const [path, page] of Object.entries(pages)) {
  let head = metadataHead(baseHead, page) + structuredData(page);
  if (page.noindex) head += '<meta name="robots" content="noindex, nofollow">';
  const html = await compactHtml(
    render(
      `<!doctype html><html lang="pt-BR"><head>${head}</head><body><a class="skip-link" href="#principal">Pular para o conteúdo</a><header class="site-header legal-header"><div class="container header-inner"><a class="brand" href="/" aria-label="Astra, início"><picture><source media="(prefers-color-scheme: dark)" srcset="/assets/brand-2a6daf003c28.svg"><img src="/assets/brand-0cf450d05c3b.svg" width="176" height="45" alt="Astra"></picture></a><a class="text-link" href="/">Voltar ao início {{icon:arrow-right}}</a></div></header><main class="container info-page" id="principal"><h1>${page.heading}</h1>${page.body}</main></body></html>`
    )
  );
  files[path] = html;
  await writeFile(join(dist, path.slice(1)), html);
}
// A dedicated text file proves ownership to IndexNow; it never uses the HTML fallback.
files[`/${indexNowKey}.txt`] = indexNowKey;
await writeFile(join(dist, `${indexNowKey}.txt`), indexNowKey);
const publicPaths = new Set(
  Object.keys(files)
    .filter((path) => path.endsWith('.html') && path !== '/404.html')
    .map((path) => (path === '/index.html' ? '/' : path.slice(0, -5)))
);
for (const [path, html] of Object.entries({ ...files })) {
  if (!path.endsWith('.html') || path === '/404.html') continue;
  const page = path === '/index.html' ? '/' : path.slice(0, -5);
  const target = '/julio' + (path === '/index.html' ? '.html' : path);
  files[target] = trialAffiliateHtml(html, page, publicPaths);
  await mkdir(dirname(join(dist, target.slice(1))), { recursive: true });
  await writeFile(join(dist, target.slice(1)), files[target]);
}
const raw = Buffer.from(JSON.stringify(files));
const sha = digest(raw);
const compressed = brotliCompressSync(raw, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
});
const padded = Buffer.alloc(Math.ceil(compressed.length / 4) * 4);
compressed.copy(padded);
const packed = encodeZ85(padded);
// JSON.parse coerces the verified Buffer to UTF-8, retaining the transport size budget.
const loader = `const z85Alphabet=${JSON.stringify(z85Alphabet)};\n${decodeZ85.toString()}\nconst rawBundle=brotliDecompressSync(decodeZ85(${JSON.stringify(packed)}).subarray(0,${compressed.length}));\nif(digest(rawBundle)!=='${sha}')throw Error('Asset hash mismatch');\nconst files=JSON.parse(rawBundle);`;
const readableRuntime = (await readFile(join(root, 'runtime.ts'), 'utf8'))
  .replace('/* PUBLIC_ASSET_BUNDLE */', () => loader)
  .replace('/* DISCOVERY_CONFIGURATION */', `const INDEXNOW_KEY=${JSON.stringify(indexNowKey)};`);
const { code: runtime } = await minify(readableRuntime, {
  module: true,
  compress: { passes: 2 },
  mangle: { toplevel: true, reserved: ['SQL'] },
  format: { comments: false },
});
// Railway still base64-encodes the Function in its start command, including API deploys.
// Keep the existing transport budget with margin below the documented 96 KiB file cap.
const functionBytes = Buffer.byteLength(runtime);
const argumentBytes = Buffer.from(runtime).toString('base64').length;
if (argumentBytes > 130800)
  throw Error(`Function source needs ${argumentBytes} base64 bytes. The release budget is 130800.`);
await writeFile(join(dist, 'railway-function.ts'), runtime);
await writeFile(join(dist, 'bundle.json'), raw);
await writeFile(
  join(dist, 'build.json'),
  JSON.stringify(
    {
      release,
      sha256: sha,
      files: Object.keys(files),
      paths,
      rawBytes: raw.length,
      packedBytes: packed.length,
      transport: 'brotli-z85',
      argumentBytes,
      functionBytes,
      indexNowKey,
      siteOrigin,
      publicUrls: [homeMetadata, ...publicPages, ...Object.values(pages)]
        .filter((page) => !page.noindex)
        .map((page) => siteOrigin + page.path),
      htmlBytes: Buffer.byteLength(index),
      htmlGzipBytes: gzipSync(index).length,
    },
    null,
    2
  )
);
console.log(
  JSON.stringify({
    release,
    sha256: sha,
    files: Object.keys(files).length,
    htmlBytes: Buffer.byteLength(index),
    htmlGzipBytes: gzipSync(index).length,
    functionBytes: Buffer.byteLength(runtime),
  })
);
