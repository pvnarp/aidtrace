import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: '**/give.spec.ts', fullyParallel: false, workers: 1, retries: 0, timeout: 120000,
  reporter: 'list', outputDir: 'local/give-ui-artifacts',
  use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, baseURL: 'http://127.0.0.1:3100', actionTimeout: 15000, trace: 'off', screenshot: 'off', video: 'off' },
});
