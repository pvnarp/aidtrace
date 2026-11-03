import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['**/rules-draft.spec.ts', '**/fund-modes.spec.ts', '**/fund-modes-bulk.spec.ts', '**/autopilot.spec.ts', '**/receipt-photo.spec.ts'], fullyParallel: false, workers: 1, retries: 0, timeout: 120000,
  reporter: 'list', outputDir: 'local/rules-ui-artifacts',
  use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, baseURL: 'http://127.0.0.1:3100', actionTimeout: 15000, trace: 'off', screenshot: 'off', video: 'off' },
});
