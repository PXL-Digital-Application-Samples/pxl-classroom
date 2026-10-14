// PXL Classroom - the LIVE UI suite. Not part of `npm run test:e2e`.
//
// The e2e suite (tests/e2e) drives the SPA against a GitHub that a fixture
// fakes. This drives the same SPA against the real one, signed in as the test
// accounts in .env.test, on the drill organization, so what a lecturer and a
// student actually see is checked against real data: the drill's own records,
// check runs, locks and archives (tests/live/drill.mjs makes them).
//
//   npx playwright test --config tests/live/ui/playwright.live.config.mjs
//
// The SPA runs on a localhost dev server, never the deployed site: the test
// accounts' tokens go into a page on this machine only. The one thing that is
// not GitHub - the published student data under /data/ - is fetched from the
// deployed site as it is (live-ui.mjs `publishedData`).
//
// NO VITE_CLAIM_PUBLIC_KEY here, unlike playwright.config.mjs: that is the e2e
// suite's test key, and an address a live student page seals to it is one the
// real hub can never open.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.live.mjs',
  // Real GitHub, real latency, and a rate limit shared by every spec.
  timeout: 180_000,
  retries: 0,
  workers: 1,
  webServer: {
    command: 'npm run --prefix ../../../frontend dev -- --port 5198',
    port: 5198,
    reuseExistingServer: false,
  },
  use: {
    baseURL: 'http://localhost:5198/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
