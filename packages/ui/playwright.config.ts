import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.join(__dirname, 'playwright/.auth/user.json');

export default defineConfig({
  testDir: './e2e',
  // The 59-route cross-viewport audit runs in its own isolated PostgreSQL job.
  // Avoid rerunning it via the general frontend E2E suite.
  testIgnore: /astra-route-audit\.spec\.ts/,
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
