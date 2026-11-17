import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'customer-update.spec.ts',
  outputDir: '../test-results/customer-update',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../test-results/customer-update-results.json' }]],
  use: {
    browserName: 'chromium',
    serviceWorkers: 'allow',
    locale: 'pt-BR',
    timezoneId: 'America/Cuiaba',
    storageState: { cookies: [], origins: [] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
