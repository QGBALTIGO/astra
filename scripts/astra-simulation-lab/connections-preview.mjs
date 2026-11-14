import http from 'node:http';
import { resolve } from 'node:path';
import { createServer } from '../../packages/ui/node_modules/vite/dist/node/index.js';
import { ASTRA_CONNECTED_APPS } from '../../packages/gateway/src/config/astra-connected-apps.ts';

// Synthetic UI preview only: no database, credentials, provider calls or channel sends.
const customer = {
  accountId: 'preview',
  dataUserId: 'lab:preview',
  phoneNumber: '5511999990000',
  displayName: 'Cliente fictício · revisão visual',
  timeZone: 'America/Cuiaba',
  currency: 'BRL',
  theme: 'light',
  hideAmounts: false,
  access: { status: 'active', expiresAt: null, canWrite: true },
};
const apps = ASTRA_CONNECTED_APPS.map((app, i) => ({
  ...app,
  status:
    i === 0 ? 'connected' : i === 1 ? 'needs_attention' : i === 2 ? 'pending' : 'disconnected',
  connectionId: i < 3 ? 'ca_preview_' + i : null,
  lastSyncedAt: i === 0 ? '2026-11-13T13:00:00Z' : null,
  itemCount: i === 0 ? 4 : 0,
}));
const routes = {
  '/api/v1/auth/status': { passwordConfigured: true, authenticated: true },
  '/api/v1/customer/auth/session': { customer },
  '/api/v1/customer/profile': { profile: customer },
  '/api/v1/customer/sessions': { sessions: [] },
  '/api/v1/customer/integrations': {
    whatsapp: { available: true, connected: true, status: 'connected' },
    siteUrl: 'https://astraacessor.pro',
    renewalUrl: null,
    supportUrl: null,
  },
  '/api/v1/customer/connected-apps': { configured: true, timeZone: 'America/Cuiaba', apps },
  '/api/v1/composio/status': { configured: true, recommendedApps: ASTRA_CONNECTED_APPS },
  '/api/v1/composio/apps': { apps: ASTRA_CONNECTED_APPS },
  '/api/v1/composio/connections': {
    connections: [
      { id: 'old', appName: 'googlecalendar', status: 'INITIATED' },
      { id: 'older', appName: 'googlecalendar', status: 'INITIATED' },
      { id: 'active', appName: 'googlecalendar', status: 'ACTIVE' },
      { id: 'gmail', appName: 'gmail', status: 'INITIATED' },
      { id: 'gmail-old', appName: 'gmail', status: 'INITIATED' },
    ],
  },
};
const handler = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:51983');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const path = new URL(req.url, 'http://127.0.0.1:51984').pathname;
  if (path.endsWith('/avatar')) {
    res.writeHead(404).end();
    return;
  }
  let data = routes[path] ?? {};
  if (path.endsWith('/sync')) data = { updated: true, lastSyncedAt: new Date().toISOString() };
  if (path.endsWith('/telegram-link'))
    data = {
      command: '/connect TESTE-FICTICIO',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
  res
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ success: true, data }));
};
const server = http.createServer(handler);
await new Promise((resolve) => server.listen(51984, '127.0.0.1', resolve));
process.env.VITE_API_BASE = '';
const vite = await createServer({
  define: { 'import.meta.env.VITE_API_BASE': '""' },
  plugins: [
    {
      name: 'synthetic-preview-api',
      configureServer(server) {
        server.middlewares.use('/api', (req, res) => {
          req.url = '/api' + req.url;
          handler(req, res);
        });
      },
    },
  ],
  root: resolve('packages/ui'),
  configFile: resolve('packages/ui/vite.config.ts'),
  server: { host: '127.0.0.1', port: 51983, strictPort: true },
});
await vite.listen();
console.log(
  'Synthetic connections preview ready at http://127.0.0.1:51983/cliente/perfil?integracoes=1'
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    server.close();
    await vite.close();
    process.exit(0);
  });
