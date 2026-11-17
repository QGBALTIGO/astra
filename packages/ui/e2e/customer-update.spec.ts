import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockCustomerApi, navigateCustomer } from './customer-fixtures';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const oldDist = process.env.ASTRA_OLD_UI_DIST;
let server: Server,
  origin: string,
  phase = 0;
let currentEntry: string;
const newEntry = '/assets/index-updated-test.js';
const types: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
const legacyWorker = `self.addEventListener('install',event=>{event.waitUntil(caches.open('legacy-customer-shell').then(async cache=>{await cache.add('/legacy-shell.html');await self.skipWaiting()}))});self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(event.request.mode==='navigate')event.respondWith(caches.match('/legacy-shell.html'))});`;

test.beforeAll(async () => {
  currentEntry = JSON.parse(await readFile(resolve(dist, 'astra-release.json'), 'utf8')).entry;
  if (oldDist) await access(resolve(oldDist, 'sw.js'));
  server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    try {
      res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
      if (phase === 0 && !oldDist && path === '/sw.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(legacyWorker);
        return;
      }
      if (
        phase === 0 &&
        !oldDist &&
        (path.startsWith('/cliente') || path === '/legacy-shell.html')
      ) {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><html data-test-release="legacy"><body>Versão antiga em cache<script src="/legacy-register.js"></script></body></html>'
        );
        return;
      }
      if (path === '/legacy-register.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end("navigator.serviceWorker.register('/sw.js');");
        return;
      }
      if (path === '/astra-release.json' && phase === 2) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ entry: newEntry }));
        return;
      }
      if (path.startsWith('/api/')) {
        res.statusCode = 503;
        res.end();
        return;
      }
      const root = phase === 0 && oldDist ? oldDist : dist;
      const navigation = path === '/' || path.startsWith('/cliente');
      const target = resolve(
        root,
        navigation ? 'index.html' : path === newEntry ? currentEntry.slice(1) : '.' + path
      );
      if (!target.startsWith(resolve(root) + '\\') && !target.startsWith(resolve(root) + '/')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = await readFile(target);
      if (navigation || path === '/index.html') {
        let html = body
          .toString()
          .replace(
            '<html',
            `<html data-test-release="${phase === 0 ? 'legacy' : phase === 1 ? 'current' : 'updated'}"`
          );
        if (phase === 2) html = html.replace(currentEntry, newEntry);
        body = Buffer.from(html);
      }
      if (path === '/sw.js' && phase === 2)
        body = Buffer.concat([body, Buffer.from('\n// isolated next release\n')]);
      res.setHeader('Content-Type', types[extname(target)] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

test('upgrades a cached legacy app and thereafter fetches current navigation HTML', async ({
  page,
}) => {
  phase = 0;
  await mockCustomerApi(page);
  await page.goto(origin + '/cliente/entrar');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-test-release', 'legacy');
  phase = 1;
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const old = registration?.active;
    await registration?.update();
    const deadline = Date.now() + 25_000;
    while (
      !registration?.active ||
      registration.active === old ||
      registration.active.state !== 'activated'
    ) {
      if (Date.now() > deadline) throw new Error('New worker did not activate');
      await new Promise((done) => setTimeout(done, 50));
    }
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-test-release', 'current');
  await expect(page.getByRole('heading', { name: 'Entre no seu Astra' })).toBeVisible();
  phase = 2;
  await page.goto(origin + '/cliente/entrar?online-navigation=1');
  await expect(page.locator('html')).toHaveAttribute('data-test-release', 'updated');
  // Public shell can fall back offline; private API data must never be cached.
  const cachedApis = await page.evaluate(async () => {
    const names = await caches.keys();
    return (
      await Promise.all(
        names.map(async (name) =>
          (await (await caches.open(name)).keys()).map((request) => request.url)
        )
      )
    )
      .flat()
      .filter((url) => new URL(url).pathname.startsWith('/api/'));
  });
  expect(cachedApis).toEqual([]);
});

test('offers a new release while preserving a form until the user chooses to update', async ({
  page,
}) => {
  phase = 1;
  await page.clock.install({ time: new Date('2026-11-17T17:00:00Z') });
  await mockCustomerApi(page, { authenticated: true });
  await page.goto(origin + '/cliente/transacoes');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByRole('button', { name: 'Nova transação', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Nova movimentação' });
  await form.getByLabel('Descrição', { exact: true }).fill('Meu formulário preservado');
  phase = 2;
  await page.clock.runFor(16_000);
  await expect(page.locator('.astra-release-notice')).toBeVisible();
  await expect(form.getByLabel('Descrição', { exact: true })).toHaveValue(
    'Meu formulário preservado'
  );
  await expect(page.locator('html')).toHaveAttribute('data-test-release', 'current');
  await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Atualizar agora', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-test-release', 'updated');
  await expect(page.locator('.astra-release-notice')).toHaveCount(0);
});

test('receives external financial changes without reloading or discarding an open draft', async ({
  page,
}) => {
  phase = 1;
  await page.clock.install({ time: new Date('2026-11-17T17:00:00Z') });
  const api = await mockCustomerApi(page, { authenticated: true });
  await page.goto(origin + '/cliente/transacoes');
  await expect(page.getByText('Salário de novembro', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nova transação', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Nova movimentação' });
  await form.getByLabel('Descrição', { exact: true }).fill('Rascunho local');
  api.receiveFromChannel('income', 'Entrada recebida pelo WhatsApp');
  api.receiveFromChannel('expense', 'Despesa recebida pelo WhatsApp');
  await page.clock.runFor(16_000);
  await expect(form.getByLabel('Descrição', { exact: true })).toHaveValue('Rascunho local');
  await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.getByText('Entrada recebida pelo WhatsApp', { exact: true })).toBeVisible();
  await expect(page.getByText('Despesa recebida pelo WhatsApp', { exact: true })).toBeVisible();
  expect(api.mutations.filter((item) => item.path === '/finance/transactions')).toEqual([]);
  expect(api.pageErrors).toEqual([]);
});

test('shows channel entries in home activity and transactions despite a full page of future receivables', async ({
  page,
}) => {
  phase = 1;
  await page.clock.install({ time: new Date('2026-11-17T17:00:00Z') });
  const api = await mockCustomerApi(page, { authenticated: true, futureDueDates: true });
  await page.goto(origin + '/cliente');
  await expect(page.locator('.home-summary-balance')).toBeVisible();
  api.receiveFromChannel('income', 'Nova entrada confirmada no WhatsApp');
  api.receiveFromChannel('expense', 'Nova despesa confirmada no WhatsApp');
  await page.clock.runFor(16_000);
  const activity = page.locator('.transactions-panel');
  await expect(
    activity.getByText('Nova entrada confirmada no WhatsApp', { exact: true })
  ).toBeVisible();
  await expect(
    activity.getByText('Nova despesa confirmada no WhatsApp', { exact: true })
  ).toBeVisible();
  await navigateCustomer(page, 'Transações');
  await expect(
    page.getByText('Nova entrada confirmada no WhatsApp', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Nova despesa confirmada no WhatsApp', { exact: true })
  ).toBeVisible();
  await navigateCustomer(page, 'Início');
  api.receiveFromChannel('income', 'Entrada enquanto a aba está fechada');
  await page.clock.runFor(16_000);
  await navigateCustomer(page, 'Transações');
  await expect(
    page.getByText('Entrada enquanto a aba está fechada', { exact: true })
  ).toBeVisible();
  expect(api.mutations).toEqual([]);
  expect(api.pageErrors).toEqual([]);
});
