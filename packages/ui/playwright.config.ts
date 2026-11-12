import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.join(__dirname, 'playwright/.auth/user.json');

export default defineConfig({
  testDir: './e2e',
  // The route audit and premium portal matrix own their isolated workflows
  // and visual reference configuration. Keep them out of the general suite.
  testIgnore: /(?:astra-route-audit|customer-premium)\.spec\.ts/,
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:8199',
    // Headed locally for debugging, but headless in CI — CI runners have no
    // X server, so a headed launch crashes with "platform failed to initialize".
    headless: !!process.env.CI,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        storageState: authFile,
      },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'npx vite --port 8199',
    port: 8199,
    reuseExistingServer: true,
    timeout: 15000,
  },
});
