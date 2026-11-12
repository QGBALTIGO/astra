/** Same-origin lab comparison of the captured public release and the new build.
 * These are lab observations, not field Core Web Vitals or a real-user INP.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const server = spawn(process.execPath, ['preview.mjs'], { stdio: 'ignore', env: { ...process.env, PORT: '4174' } });
const baseURL = 'http://127.0.0.1:4174';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ready = false;
for (let index = 0; index < 40; index++) { try { if ((await fetch(baseURL)).ok) { ready = true; break; } } catch {} await pause(150); }
if (!ready) { server.kill(); throw Error('Performance preview did not start'); }
const browser = await chromium.launch();
const output = [];
await mkdir('artifacts/performance', { recursive: true });
try {
  for (const device of [{ name: 'mobile-390', width: 390, height: 844 }, { name: 'desktop-1440', width: 1440, height: 1000 }]) {
    for (const version of ['before', 'after']) {
      for (let sample = 1; sample <= 3; sample++) {
        const context = await browser.newContext({ viewport: device, locale: 'pt-BR', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const client = await context.newCDPSession(page);
        await client.send('Network.enable');
        await client.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1600000 / 8, uploadThroughput: 750000 / 8 });
        await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.addInitScript(() => {
          window.__lab = { lcp: null, cls: 0, maxEventDuration: null, longTasksMs: 0 };
          for (const [type, callback] of [
            ['largest-contentful-paint', (entry) => { window.__lab.lcp = entry.startTime; }],
            ['layout-shift', (entry) => { if (!entry.hadRecentInput) window.__lab.cls += entry.value; }],
            ['event', (entry) => { if (entry.interactionId) window.__lab.maxEventDuration = Math.max(window.__lab.maxEventDuration || 0, entry.duration); }],
            ['longtask', (entry) => { window.__lab.longTasksMs += Math.max(0, entry.duration - 50); }]
          ]) { try { new PerformanceObserver((list) => list.getEntries().forEach(callback)).observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) }); } catch {} }
        });
        const response = await page.goto(baseURL + (version === 'before' ? '/baseline/' : '/'), { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);
        if (version === 'after') {
          await page.locator('[data-scenario="agenda"]').click();
          await page.locator('#tab-categorias').click();
        } else {
          const button = page.locator('.astra-try-buttons button').first();
          if (await button.count()) await button.click();
        }
        await pause(300);
        const data = await page.evaluate(() => ({ ...window.__lab, domContentLoadedMs: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd, requests: performance.getEntriesByType('resource').length, resourceTransferBytes: performance.getEntriesByType('resource').reduce((sum, entry) => sum + entry.transferSize, 0), viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
        output.push({ device: device.name, version, sample, httpStatus: response.status(), ...data });
        if (sample === 1) await page.screenshot({ path: `artifacts/performance/${device.name}-${version}.png`, fullPage: true });
        await context.close();
      }
    }
  }
  const report = { conditions: { networkMbps: 1.6, latencyMs: 150, cpuSlowdown: 4, samplesPerVersion: 3, data: 'Public illustrative fixtures only', limitation: 'Local lab comparison. maxEventDuration is an interaction timing observation, not field INP. No real-user 75th-percentile claim.' }, observations: output };
  await writeFile('artifacts/performance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); server.kill(); }
