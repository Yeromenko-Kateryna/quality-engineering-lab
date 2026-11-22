import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  retries: 0,
  timeout: 15_000,
  globalTimeout: 90_000,
  expect: { timeout: 2_000 },
  outputDir: '/reports/test-output',
  reporter: [['list'], ['json', { outputFile: '/reports/playwright.json' }]],
  use: {
    browserName: 'chromium',
    baseURL: 'http://sut:3000',
    bypassCSP: false,
    serviceWorkers: 'block',
    navigationTimeout: 5_000,
    actionTimeout: 3_000,
  },
});
