/**
 * Cheap request checks before logging, body parsing and static-file lookups.
 * This is a production routing boundary, not a payload/XSS blacklist.
 */

import { createMiddleware } from 'hono/factory';

export const MAX_REQUEST_URL_LENGTH = 8_192;

const SERVICE_ROOTS = new Set(['api', 'webhooks', 'health', 'ws', 'mcp', '_internal']);
const DEVELOPMENT_ROOTS = new Set([
  '@vite',
  '@id',
  '@fs',
  '@react-refresh',
  '__vite',
  '__vite_ping',
  '__open-in-editor',
  '__inspect',
  '__webpack_hmr',
  '__webpack_dev_server__',
  'node_modules',
  'src',
]);
const SOURCE_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  'vite.config.js',
  'vite.config.ts',
  'webpack.config.js',
  'dockerfile',
  'docker-compose.yml',
  'compose.yml',
]);

// A missing public file must not be returned as HTML. Do not reject every dot:
// valid SPA identifiers and routes can contain dots (e.g. /skills/example.v1/edit).
const PUBLIC_FILE_EXTENSION =
  /\.(?:html?|css|m?js|cjs|map|json|webmanifest|txt|xml|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|wasm|pdf|zip|gz|mp[34]|webm|wav|ogg|php|aspx?|jsp|cgi)$/i;

function pathSegments(path: string): string[] {
  return path.replaceAll('\\', '/').split('/').filter(Boolean);
}

function isServicePath(path: string): boolean {
  return SERVICE_ROOTS.has(pathSegments(path)[0] ?? '');
}

/** Only registered service handlers or existing files may answer these paths. */
export function canServeSpaFallback(path: string): boolean {
  try {
    path = decodeURIComponent(path);
  } catch {
    return false;
  }
  const root = pathSegments(path)[0];
  return (
    !isServicePath(path) &&
    root !== 'assets' &&
    root !== '.well-known' &&
    !PUBLIC_FILE_EXTENSION.test(path)
  );
}

function isPrivatePublicPath(path: string): boolean {
  const segments = pathSegments(path).map((part) => part.toLowerCase());
  const root = segments[0] ?? '';
  if (DEVELOPMENT_ROOTS.has(root) || SOURCE_FILES.has(root)) return true;
  if (/\.(?:map|tsx?|jsx|vue|svelte)$/.test(segments.at(-1) ?? '')) return true;
  // .well-known is a public standards namespace; hidden entries beneath it are
  // still private. Its missing files are excluded from the SPA fallback above.
  return segments.some(
    (part, index) => part.startsWith('.') && !(index === 0 && part === '.well-known')
  );
}

export const publicPerimeter = createMiddleware(async (c, next) => {
  // Check length before decoding. Include the query in the bound but never scan
  // query contents: OAuth state, signed callbacks and user input are opaque.
  if (c.req.url.length > MAX_REQUEST_URL_LENGTH) {
    c.header('Cache-Control', 'no-store');
    return c.text('URI too long', 414);
  }

  let path: string;
  try {
    path = decodeURIComponent(c.req.path);
  } catch {
    c.header('Cache-Control', 'no-store');
    return c.text('Bad request', 400);
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    c.header('Cache-Control', 'no-store');
    return c.text('Bad request', 400);
  }

  // API and webhook path parameters are governed by their authenticated route
  // handlers. Keep this file-access policy scoped to public static/SPA routes.
  if (!isServicePath(c.req.path)) {
    // Check a bounded number of nested encodings as well as the normal decoded
    // form. There is no recursive/unbounded decoding of attacker-controlled text.
    for (let depth = 0; depth < 3; depth++) {
      if (isPrivatePublicPath(path)) {
        c.header('Cache-Control', 'no-store');
        return c.text('Not found', 404);
      }
      if (!path.includes('%')) break;
      try {
        const decoded = decodeURIComponent(path);
        if (decoded === path) break;
        path = decoded;
      } catch {
        // A literal percent in a correctly encoded public filename is valid.
        break;
      }
    }
  }

  return next();
});
