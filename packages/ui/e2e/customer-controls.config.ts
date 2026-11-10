import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: 'customer-mobile-controls.spec.ts',
  outputDir: fileURLToPath(new URL('../test-results/customer-controls', import.meta.url)),
  timeout: 30000,
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: fileURLToPath(new URL('../customer-controls-report', import.meta.url)),
        open: 'never',
      },
    ],
  ],
  use: {
    baseURL: 'http://localhost:8199',
    headless: true,
    hasTouch: true,
    locale: 'pt-BR',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-touch', use: { browserName: 'chromium' } },
    { name: 'webkit-touch', use: { browserName: 'webkit' } },
  ],
  webServer: {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    command: 'npx vite --port 8199 --strictPort',
    url: 'http://localhost:8199/cliente/entrar',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
