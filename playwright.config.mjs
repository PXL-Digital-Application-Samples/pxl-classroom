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
    env: {
      // The claim public key the SPA seals addresses to. FIXED and test-only -
      // its private half is E2E_CLAIM_KEYPAIR in tests/fixtures, so a spec can
      // decrypt what the browser actually posted and assert on the address.
      //
      // Supplied here rather than committed to acceptance/claim-keys.json,
      // because that file is the PRODUCTION key list and putting a key there
      // whose private half nobody holds would make a deployment look
      // configured while sealing claims the hub can never open.
      //
      // Fixed rather than generated per run: a keypair minted at import time
      // would differ between the config process and the spec process, which is
      // the same class of flake as a Date.now()-derived invite token straddling
      // a minute boundary (~1 run in 4).
      VITE_CLAIM_PUBLIC_KEY:
        'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5G7dKlveZqzrCbiKJio4qdp-2yRGEPoPkuI7f6T3hhdCu7En-0hAUpMw3LKaCXd33LnUNe3tO-SLlld57y1uQQ',
    },
  },
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173/',
    trace: 'on-first-retry',
  },
});
