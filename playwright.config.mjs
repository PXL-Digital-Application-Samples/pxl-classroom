import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  timeout: 60000,
  // `trace: 'on-first-retry'` below produces nothing without a retry to be the
  // first one, so a CI flake used to leave a line of output and no evidence.
  // Locally, zero: a failure should fail immediately while you are watching.
  retries: process.env.CI ? 1 : 0,
  webServer: {
    command: 'npm run --prefix frontend dev -- --port 5173',
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173/',
    trace: 'on-first-retry',
  },
});
