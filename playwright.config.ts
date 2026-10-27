import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testIgnore: ['**/analytics.spec.ts', '**/proposal.spec.ts'], fullyParallel: false,
  workers: 1, retries: 0, timeout: 120000, reporter: 'list', outputDir: 'local/ui-artifacts',
  use: { browserName: 'chromium', viewport: { width: 375, height: 812 }, isMobile: true,
    hasTouch: true, baseURL: 'http://127.0.0.1:3100', actionTimeout: 15000,
    trace: 'off', screenshot: 'off', video: 'off' },
});
