import { defineConfig } from '@playwright/test';

// The claim public key the SPA seals addresses to. FIXED and test-only - its
// private half is E2E_CLAIM_KEYPAIR in tests/fixtures, so a spec can decrypt
// what the browser actually posted and assert on the address.
//
// Supplied here rather than committed to acceptance/claim-keys.json, because
// that file is the PRODUCTION key list and putting a key there whose private
// half nobody holds would make a deployment look configured while sealing
// claims the hub can never open.
//
// Fixed rather than generated per run: a keypair minted at import time would
// differ between the config process and the spec process, which is the same
// class of flake as a Date.now()-derived invite token straddling a minute
// boundary (~1 run in 4). The build bakes it in as the dev server serves it.
const env = {
  VITE_CLAIM_PUBLIC_KEY:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5G7dKlveZqzrCbiKJio4qdp-2yRGEPoPkuI7f6T3hhdCu7En-0hAUpMw3LKaCXd33LnUNe3tO-SLlld57y1uQQ',
};

// THE BUILT SPA, served by `vite preview`, for every spec but these. On the
// dev server each of eight browsers loads hundreds of unbundled modules at
// once, and under the full suite one first render a run missed its 15s - a
// different spec each time, each passing alone in a second (TS-13). Against
// the build the suite ran in 3.7 minutes instead of 6, with none. It is also
// what the site serves.
//
// These five need the dev server: four visit `/sandbox`, which the build
// drops (`import.meta.env.DEV`, frontend/src/router), and 46 imports
// `/src/lib/claim.js` into the page. A spec that needs it and is not listed
// fails loudly on the build, never silently.
const DEV_SERVER_SPECS = [
  '**/08-group-autograding-scenarios.spec.mjs',
  '**/19-theme-toggle.spec.mjs',
  '**/22-design-conformity.spec.mjs',
  '**/39-orphan-routes.spec.mjs',
  '**/46-claim-address.spec.mjs',
];

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  timeout: 60000,
  // `trace: 'on-first-retry'` below produces nothing without a retry to be the
  // first one, so a CI flake used to leave a line of output and no evidence.
  // Locally, zero: a failure should fail immediately while you are watching.
  retries: process.env.CI ? 1 : 0,
  webServer: [
    {
      command: 'npm run --prefix frontend build && npm run --prefix frontend preview -- --port 4173 --strictPort',
      port: 4173,
      // Never reused: one left running serves an older build, and the suite
      // would test code that is no longer there. A port in use fails instead.
      reuseExistingServer: false,
      timeout: 300000,
      env,
    },
    {
      command: 'npm run --prefix frontend dev -- --port 5173',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      env,
    },
  ],
  use: { trace: 'on-first-retry' },
  projects: [
    { name: 'built', testIgnore: DEV_SERVER_SPECS, use: { baseURL: process.env.BASE_URL || 'http://localhost:4173/' } },
    { name: 'dev-server', testMatch: DEV_SERVER_SPECS, use: { baseURL: process.env.DEV_BASE_URL || 'http://localhost:5173/' } },
  ],
});
