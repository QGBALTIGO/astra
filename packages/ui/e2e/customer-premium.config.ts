import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: [
    'customer-premium.spec.ts',
    'customer-portal.spec.ts',
    'customer-mobile-controls.spec.ts',
  ],
  outputDir: '../test-results/customer-premium',
  timeout: 45000,
  fullyParallel: true,
  workers: 3,
  retries: 0,
  expect: { timeout: 7000, toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.002 } },
  snapshotPathTemplate: '{testDir}/customer-premium-snapshots/{projectName}/{arg}{ext}',
  reporter: [
    ['list'],
    ['html', { outputFolder: '../customer-premium-report', open: 'never' }],
    ['json', { outputFile: '../test-results/customer-premium-results.json' }],
  ],
  use: {
    baseURL: 'http://localhost:8199',
    locale: 'pt-BR',
    timezoneId: 'America/Campo_Grande',
    serviceWorkers: 'block',
    storageState: { cookies: [], origins: [] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'firefox', testMatch: 'customer-premium.spec.ts', use: { browserName: 'firefox' } },
  ],
  webServer: {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    command: 'npx vite --port 8199 --strictPort',
    url: 'http://localhost:8199/cliente/entrar',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
