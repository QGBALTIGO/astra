import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'customer-mobile-controls.spec.ts',
  timeout: 30000,
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'customer-controls-report', open: 'never' }]],
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
    command: 'npx vite --port 8199',
    port: 8199,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
