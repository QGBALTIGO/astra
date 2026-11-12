/** Local QA only. Serves public files; never connects to the agent or a database. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
let baseline = {};
try { baseline = JSON.parse(await readFile(join(root, 'tests/baseline/bundle.json'), 'utf8')); } catch {}
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2' };
const runtime = await readFile(join(root, 'runtime.ts'), 'utf8');
const csp = runtime.match(/const CSP="([^"]+)"/)[1].replace('; upgrade-insecure-requests', '');
const routes = { '/': '/index.html', '/privacidade': '/privacidade.html', '/condicoes': '/condicoes.html', '/remover': '/remover.html', '/baseline/': '/baseline/index.html' };
const server = createServer(async (req, res) => {
  let files;
  try { files = JSON.parse(await readFile(join(root, 'dist/bundle.json'), 'utf8')); }
  catch { res.writeHead(503); res.end('Aguarde a atualização da prévia.'); return; }
  const path = new URL(req.url, `http://localhost:${port}`).pathname;
  const headers = { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  if (path === '/api/evento') { res.writeHead(204, headers); res.end(); return; }
  if (path.startsWith('/api/')) {
    res.writeHead(503, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Prévia local: formulário indisponível. Use a página publicada.' }));
    return;
  }
  const resolved = routes[path] || path;
  const content = files[resolved] ?? baseline[resolved];
  const status = content === undefined ? 404 : 200;
  const body = content ?? files['/404.html'];
  let buffer = String(body).startsWith('BASE64:') ? Buffer.from(body.slice(7), 'base64') : Buffer.from(body);
  const responseHeaders = { ...headers, 'Content-Type': types[(status === 404 ? '/404.html' : resolved).split('.').at(-1)] || 'application/octet-stream' };
  if ((req.headers['accept-encoding'] || '').includes('gzip')) { buffer = gzipSync(buffer); responseHeaders['Content-Encoding'] = 'gzip'; }
  responseHeaders['Content-Length'] = buffer.length;
  res.writeHead(status, responseHeaders);
  res.end(req.method === 'HEAD' ? undefined : buffer);
});
server.listen(port, '0.0.0.0', () => console.log(`Astra public preview listening on ${port}`));
