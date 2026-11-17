import { defineConfig, loadEnv, createLogger } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Plugin } from 'vite';

/**
 * Fail the build if the emitted CSS is suspiciously small.
 *
 * Tailwind v4 scans source files with the native `@tailwindcss/oxide` addon.
 * If that native binary fails to load (e.g. a corrupt platform package on
 * Windows), oxide silently falls back to its WASM build, which scans nothing
 * and emits a utility-less stylesheet (~13 KB instead of ~250 KB) — with no
 * error. That ships an entirely unstyled UI, including in Docker images.
 * A healthy build is hundreds of KB; 80 KB is far above the broken case and
 * far below any legitimate output, so it cleanly distinguishes the two.
 */
function cssSizeGuard(minBytes = 80_000): Plugin {
  return {
    name: 'css-size-guard',
    apply: 'build',
    writeBundle(_options, bundle) {
      let total = 0;
      for (const [name, asset] of Object.entries(bundle)) {
        if (name.endsWith('.css') && asset.type === 'asset') {
          const src = asset.source;
          total += typeof src === 'string' ? Buffer.byteLength(src) : src.byteLength;
        }
      }
      if (total < minBytes) {
        throw new Error(
          `[css-size-guard] Emitted CSS is only ${total} bytes (< ${minBytes}). ` +
            `Tailwind likely generated no utilities — the native @tailwindcss/oxide ` +
            `scanner probably failed and fell back to WASM. Repair the install ` +
            `(pnpm install --force) before shipping.`
        );
      }
    },
  };
}

/** Small uncached release pointer; contains no account or deployment secrets. */
const customerShellAssets = new Set<string>();
function customerReleasePointer(): Plugin {
  return {
    name: 'astra-customer-release',
    apply: 'build',
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (item) => item.type === 'chunk' && item.isEntry && item.name === 'index'
      );
      if (!entry) throw new Error('Customer application entry missing');
      customerShellAssets.clear();
      const visit = (file: string) => {
        if (customerShellAssets.has(file)) return;
        customerShellAssets.add(file);
        const chunk = bundle[file];
        if (chunk?.type === 'chunk') chunk.imports.forEach(visit);
      };
      visit(entry.fileName);
      // The customer entry is lazy-loaded from main; include its static graph
      // as well, so the installed shell does not depend on an uncached chunk.
      for (const item of Object.values(bundle))
        if (item.type === 'chunk' && item.name === 'CustomerApp') visit(item.fileName);
      this.emitFile({
        type: 'asset',
        fileName: 'astra-release.json',
        source: JSON.stringify({ entry: '/' + entry.fileName }),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load env from monorepo root (two levels up from packages/ui)
  const env = loadEnv(mode, resolve(__dirname, '../..'), '');

  // Read version from core package.json (single source of truth)
  const corePkg = JSON.parse(readFileSync(resolve(__dirname, '../core/package.json'), 'utf-8'));

  const uiPort = parseInt(env.UI_PORT || '8199', 10);
  const apiPort = env.PORT || '8080';
  const apiTarget = `http://127.0.0.1:${apiPort}`;
  const wsTarget = `ws://127.0.0.1:${apiPort}`;

  // Filter out "ws proxy error" noise from Claude Desktop Preview Panel.
  // The embedded browser has no auth token, so gateway rejects WS upgrades
  // with 401. This is expected and harmless — UI works fine without realtime.
  const logger = createLogger();
  const originalError = logger.error.bind(logger);
  logger.error = (msg, options) => {
    if (typeof msg === 'string' && msg.includes('ws proxy error')) return;
    originalError(msg, options);
  };

  // Bundle visualizer: emits `dist/bundle-stats.html` (treemap) when
  // `ANALYZE=true` is set. Use locally to spot vendor-chunk bloat; CI can
  // upload the artifact for size-diff review.
  const enableVisualizer = env.ANALYZE === 'true';

  return {
    customLogger: logger,
    plugins: [
      react(),
      tailwindcss(),
      customerReleasePointer(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'astra-icons/*',
          'apple-touch-icon.png',
          'favicon.ico',
          'logo.svg',
          'ownpilot-logo.jpeg',
        ],
        manifest: {
          name: 'Astra',
          short_name: 'Astra',
          description: 'Assistente pessoal com IA, agenda, tarefas e finanças.',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          display_override: ['window-controls-overlay', 'standalone'],
          // Preserve the installed app's original identity while opening the customer portal.
          id: '/',
          start_url: '/cliente',
          scope: '/',
          categories: ['productivity', 'finance'],
          icons: [
            {
              src: '/astra-icons/astra-192-v1.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/astra-icons/astra-512-v1.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/astra-icons/astra-maskable-512-v1.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          cleanupOutdatedCaches: true,
          skipWaiting: true,
          clientsClaim: true,
          globPatterns: ['**/*.{js,css,html,svg,jpeg,png,ico,woff2}'],
          // Installing 180+ unrelated lazy admin chunks delayed activation on
          // real connections and kept old customer HTML in control. Precache
          // the entry's static dependency graph; cache lazy public assets as
          // they are actually used. No private API response is cached.
          manifestTransforms: [
            async (entries) => ({
              manifest: entries.filter(
                ({ url }) =>
                  customerShellAssets.has(url) ||
                  url.startsWith('astra-icons/') ||
                  url.endsWith('.css') ||
                  [
                    'index.html',
                    'registerSW.js',
                    'poppins.woff2',
                    'logo.svg',
                    'ownpilot-logo.jpeg',
                    'apple-touch-icon.png',
                    'favicon.ico',
                    'astra-approved-logo.svg',
                    'astra-approved-logo-light.svg',
                    'astra-logo.svg',
                    'astra-logo-light.svg',
                    'astra-boot.css',
                  ].includes(url)
              ),
              warnings: [],
            }),
          ],
          // Online customer navigations must ask the server for the current
          // shell. Only public HTML is cached for a network-failure fallback;
          // authenticated API requests never enter a service-worker cache.
          navigateFallbackDenylist: [/^\/cliente(?:\/|$)/, /^\/$/, /^\/api(?:\/|$)/],
          runtimeCaching: [
            {
              urlPattern: ({ url, sameOrigin }) =>
                sameOrigin && /^\/assets\/[\w.-]+\.(?:js|css)$/.test(url.pathname),
              handler: 'CacheFirst',
              options: {
                cacheName: 'astra-public-assets-v1',
                cacheableResponse: { statuses: [200] },
                expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 },
              },
            },
            {
              urlPattern: ({ request, url }) =>
                request.mode === 'navigate' &&
                (url.pathname === '/' || /^\/cliente(?:\/|$)/.test(url.pathname)),
              handler: 'NetworkFirst',
              options: {
                cacheName: 'astra-customer-shell-v1',
                cacheableResponse: { statuses: [200] },
                expiration: { maxEntries: 12, maxAgeSeconds: 7 * 24 * 60 * 60 },
              },
            },
          ],
          // APIs autenticadas devem sempre ser consultadas pela rede.
        },
      }),
      cssSizeGuard(),
      ...(enableVisualizer
        ? [
            visualizer({
              filename: 'dist/bundle-stats.html',
              template: 'treemap',
              gzipSize: true,
              brotliSize: true,
              open: false,
            }),
          ]
        : []),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(corePkg.version),
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    server: {
      port: uiPort,
      // Ignore coverage artifact changes across the entire monorepo.
      // Vitest writes HTML/JS coverage reports under each package's coverage/
      // directory during test runs—Vite detects these as new/changed files and
      // triggers a full page reload, creating a disruptive feedback loop.
      watch: {
        ignored: ['**/coverage/**'],
      },
      // NOTE: Vite 7.3.1 built-in proxy is broken on Node.js 24.
      // In dev mode with VITE_API_BASE set, the UI fetches directly from gateway.
      // Without VITE_API_BASE, proxy is used (works on Node 22).
      ...(env.VITE_API_BASE
        ? {}
        : {
            proxy: {
              '/api': {
                target: apiTarget,
                // Preserve the browser Host. The gateway compares the Origin
                // and the request's canonical host for cookie-session CSRF
                // protection. Rewriting Host to :8080 breaks genuine
                // same-origin browser writes from the Vite dev server :8199.
                changeOrigin: false,
              },
              '/ws': {
                target: wsTarget,
                ws: true,
                changeOrigin: true,
              },
            },
          }),
    },
    build: {
      outDir: 'dist',
      // Production builds should not ship source maps — they leak the entire
      // TypeScript source tree, including auth flows and tool implementations,
      // through `gateway` `serveStatic('/assets/*')`. Set `VITE_SOURCEMAP=true`
      // to opt back in for staging/debug builds.
      sourcemap: env.VITE_SOURCEMAP === 'true' ? true : mode !== 'production',
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, '/');
            // Vendor chunks (node_modules only)
            if (normalizedId.includes('node_modules')) {
              if (normalizedId.includes('/react-dom/')) {
                return 'vendor-react-dom';
              }
              if (normalizedId.includes('/react/') || normalizedId.includes('/scheduler/')) {
                return 'vendor-react-core';
              }
              if (normalizedId.includes('/react-router')) {
                return 'vendor-router';
              }
              if (normalizedId.includes('/@xyflow/')) {
                return 'vendor-reactflow';
              }
              if (normalizedId.includes('/@xterm/')) {
                return 'vendor-xterm';
              }
              if (
                normalizedId.includes('/@monaco-editor/') ||
                normalizedId.includes('/monaco-editor/')
              ) {
                return 'vendor-monaco';
              }
              if (normalizedId.includes('/recharts/') || normalizedId.includes('/d3-')) {
                return 'vendor-charts';
              }
              if (normalizedId.includes('/prism-react-renderer/')) {
                return 'vendor-prism';
              }
              return; // let Rollup decide for other deps
            }
            // App chunks (source code only)
            if (normalizedId.includes('/components/icons')) return 'icons';
            if (normalizedId.includes('/src/api/')) return 'api';
            if (normalizedId.includes('/src/hooks/')) return 'stores';
          },
        },
      },
    },
  };
});
