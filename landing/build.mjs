import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pages } from './src/legal.mjs';
import { minify } from 'terser';
import CleanCSS from 'clean-css';
import { minify as minifyHtml } from 'html-minifier-terser';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'assets'), { recursive: true });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const files = {};
const paths = {};
const names = (await readdir(join(root, 'src/assets'))).sort();
const textual = new Set(['.svg', '.css', '.js']);
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
    html.replace(
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
let index = await compactHtml(render(await readFile(join(root, 'src/index.html'), 'utf8')));
const schema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Astra',
  applicationCategory: 'ProductivityApplication',
  operatingSystem: 'Web, WhatsApp',
  description:
    'Assistente pessoal com inteligência artificial para organizar registros pelo WhatsApp.',
  url: 'https://astraacessor.pro/',
  offers: {
    '@type': 'Offer',
    price: '19.90',
    priceCurrency: 'BRL',
    description: 'Assinatura mensal do Astra Pessoal.',
  },
};
index = index.replace(
  '</head>',
  `<script type="application/ld+json">${JSON.stringify(schema)}</script>\n</head>`
);
files['/index.html'] = index;
await writeFile(join(dist, 'index.html'), index);
const baseHead = index
  .match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
for (const [path, page] of Object.entries(pages)) {
  let head = baseHead
    .replace(/<title>.*?<\/title>/, `<title>${page.title}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
      `<meta name="description" content="${page.description}">`
    )
    .replaceAll('https://astraacessor.pro/"', `https://astraacessor.pro${page.path}"`)
    .replace(
      /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/,
      `<meta property="og:title" content="${page.title}">`
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/,
      `<meta property="og:description" content="${page.description}">`
    );
  if (page.noindex) head += '<meta name="robots" content="noindex, nofollow">';
  const html = await compactHtml(
    render(
      `<!doctype html><html lang="pt-BR"><head>${head}</head><body><a class="skip-link" href="#principal">Pular para o conteúdo</a><header class="site-header legal-header"><div class="container header-inner"><a class="brand" href="/" aria-label="Astra, início"><picture><source media="(prefers-color-scheme: dark)" srcset="/assets/brand-2a6daf003c28.svg"><img  src="/assets/brand-0cf450d05c3b.svg" width="176" height="45" alt="Astra"></picture></a><a class="text-link" href="/">Voltar ao início {{icon:arrow-right}}</a></div></header><main class="container info-page" id="principal"><h1>${page.heading}</h1>${page.body}</main></body></html>`
    )
  );
  files[path] = html;
  await writeFile(join(dist, path.slice(1)), html);
}
const raw = Buffer.from(JSON.stringify(files));
const sha = digest(raw);
const packed = brotliCompressSync(raw, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
}).toString('base64');
const loader = `import { brotliDecompressSync } from 'node:zlib';\nconst rawBundle=brotliDecompressSync(Buffer.from('${packed}','base64'));\nif(createHash('sha256').update(rawBundle).digest('hex')!=='${sha}')throw Error('Asset integrity check failed');\nconst files=JSON.parse(rawBundle.toString('utf8'));`;
const readableRuntime = (await readFile(join(root, 'runtime.ts'), 'utf8')).replace(
  '/* PUBLIC_ASSET_BUNDLE */',
  loader
);
const { code: runtime } = await minify(readableRuntime, {
  module: true,
  compress: false,
  mangle: { toplevel: false, reserved: ['SQL'] },
  format: { comments: false },
});
const argumentBytes = Buffer.from(runtime).toString('base64').length;
if (argumentBytes > 130800)
  throw Error(`Function source needs ${argumentBytes} base64 bytes. The release budget is 130800.`);
await writeFile(join(dist, 'railway-function.ts'), runtime);
await writeFile(join(dist, 'bundle.json'), raw);
await writeFile(
  join(dist, 'build.json'),
  JSON.stringify(
    {
      release: 'premium-20261112',
      sha256: sha,
      files: Object.keys(files),
      paths,
      rawBytes: raw.length,
      packedBytes: packed.length,
      htmlBytes: Buffer.byteLength(index),
      htmlGzipBytes: gzipSync(index).length,
    },
    null,
    2
  )
);
console.log(
  JSON.stringify({
    release: 'premium-20261112',
    sha256: sha,
    files: Object.keys(files).length,
    htmlBytes: Buffer.byteLength(index),
    htmlGzipBytes: gzipSync(index).length,
    functionBytes: Buffer.byteLength(runtime),
  })
);
