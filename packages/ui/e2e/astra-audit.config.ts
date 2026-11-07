import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: /astra-route-audit\.spec\.ts/,
  timeout: 25 * 60 * 1000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:18080', headless: true, actionTimeout: 9000 },
});
