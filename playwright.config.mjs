import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  timeout: 60000,
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
