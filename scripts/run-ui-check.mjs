import { spawnSync } from 'node:child_process';
if (process.env.UI_TEST_CONTAINER !== 'true') throw new Error('Use the isolated OrbStack UI service');
// Separate processes let each suite own port 8080 and its isolated database lifecycle.
for (const args of [
  ['node_modules/next/dist/bin/next', 'build'],
  ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.config.ts'],
  ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.proposal.config.ts'],
  ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.analytics.config.ts'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
