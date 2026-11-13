import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 35000,
  expect: { timeout: 7000, toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' } },
  workers: 2,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'artifacts/browser-results.json' }],
  ],
  snapshotPathTemplate: '{testDir}/screenshots/assessor-pattern/{projectName}/{arg}{ext}',
  use: {
    baseURL: process.env.ASTRA_LANDING_TEST_URL || 'http://127.0.0.1:4173',
    locale: 'pt-BR',
    timezoneId: 'America/Campo_Grande',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'phone-320',
      use: {
        browserName: 'chromium',
        viewport: { width: 320, height: 740 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'phone-360',
      use: {
        browserName: 'chromium',
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'phone-390-safari',
      use: {
        browserName: 'webkit',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'phone-412',
      use: {
        browserName: 'chromium',
        viewport: { width: 412, height: 915 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'landscape-844',
      use: {
        browserName: 'webkit',
        viewport: { width: 844, height: 390 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'tablet-768',
      use: { browserName: 'chromium', viewport: { width: 768, height: 1024 }, hasTouch: true },
    },
    {
      name: 'laptop-1024',
      use: { browserName: 'chromium', viewport: { width: 1024, height: 768 } },
    },
    {
      name: 'desktop-1440',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'desktop-firefox',
      use: { browserName: 'firefox', viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: process.env.ASTRA_LANDING_TEST_URL
    ? undefined
    : { command: 'node preview.mjs', port: 4173, reuseExistingServer: !process.env.CI },
});
