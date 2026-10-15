// The README's screenshots: the built SPA against the e2e suite's mocked
// GitHub, filled with a fictional course (demo-course.mjs). Not part of the
// e2e suite - its files are `*.shots.mjs`, which the suite does not match.
//
//   npx playwright test --config tests/screenshots/playwright.shots.config.mjs
//
// Writes assets/images/readme-*.png: dark theme, a 1440x900 window at twice
// its pixel density, so they stay sharp when opened.
import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../playwright.config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4191;

// What the header names, as a deployed build does (frontend/src/lib/build-info.js):
// the latest release tag and this commit, rather than `dev`.
const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const buildEnv = { VITE_BUILD_VERSION: git('describe', '--tags', '--abbrev=0'), VITE_BUILD_SHA: git('rev-parse', 'HEAD') };

export default defineConfig({
  testDir: '.',
  testMatch: '*.shots.mjs',
  timeout: 120000,
  workers: 1,
  retries: 0,
  webServer: {
    command: `npm run --prefix frontend build && npm run --prefix frontend preview -- --port ${PORT} --strictPort`,
    cwd: root,
    port: PORT,
    reuseExistingServer: true,
    timeout: 300000,
    env: { ...base.webServer[0].env, ...buildEnv },
  },
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'en-GB',
    timezoneId: 'Europe/Brussels',
  },
});
