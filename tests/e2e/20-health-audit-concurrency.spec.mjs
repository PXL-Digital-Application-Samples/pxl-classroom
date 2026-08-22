import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// A System Health pass is a fan-out of GitHub REST calls made from the browser -
// not a workflow dispatch. So an impatient lecturer cannot start runaway Actions
// runs, but before the guard landed they COULD stack concurrent passes: the
// isOpen watcher called run() on every open with no check on `running`, and the
// component is never unmounted (only its inner v-if content is), so state
// persisted across open/close.

const HEALTH_BTN = 'button[aria-label="System health check"]';

/**
 * Make every GitHub call take `ms`, so a pass is still in flight while the test
 * clicks again. Without this the mocks answer instantly, passes never overlap,
 * and each open legitimately starts a fresh pass - the guard is never exercised.
 * Registered after the fixtures so it matches first, then falls through to them.
 */
async function slowDownGitHub(page, ms) {
  await page.route('https://api.github.com/**', async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.fallback();
  });
}

/** Count GitHub API calls the page makes while `body` runs. */
async function countApiCalls(page, body) {
  let calls = 0;
  const onRequest = (req) => {
    if (req.url().startsWith('https://api.github.com/')) calls++;
  };
  page.on('request', onRequest);
  try {
    await body();
  } finally {
    page.off('request', onRequest);
  }
  return calls;
}

test.describe('20 - System Health audit concurrency', () => {
  test('Reopening mid-pass does not stack another diagnostic pass', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator(HEALTH_BTN)).toBeVisible();

    // Baseline cost of exactly one pass, measured at full speed.
    const single = await countApiCalls(page, async () => {
      await page.locator(HEALTH_BTN).click();
      await expect(page.locator('.diagnostic-modal')).toBeVisible();
      await expect(page.locator('.modal-head .btn')).toBeEnabled();
    });
    expect(single, 'a diagnostic pass should make GitHub API calls').toBeGreaterThan(0);

    await page.locator('.modal-close').click();
    await expect(page.locator('.diagnostic-modal')).toBeHidden();

    // Now slow GitHub down so one pass spans the whole thrash, then open/close
    // six times inside that window. Unguarded, every open started a new pass.
    await slowDownGitHub(page, 250);

    const thrash = await countApiCalls(page, async () => {
      for (let i = 0; i < 6; i++) {
        await page.locator(HEALTH_BTN).click({ noWaitAfter: true });
        await page.locator('.modal-close').click({ noWaitAfter: true });
      }
      await page.locator(HEALTH_BTN).click({ noWaitAfter: true });
      await expect(page.locator('.modal-head .btn')).toBeEnabled({ timeout: 20000 });
    });

    // Seven opens inside one pass's lifetime. Guarded, the later opens are
    // no-ops, so the total stays near a single pass rather than a multiple.
    expect(
      thrash,
      `seven rapid opens made ${thrash} API calls; one pass costs ${single}. ` +
        'Passes are stacking - the reopen guard is not holding.',
    ).toBeLessThan(single * 2);
  });

  test('The re-run button is inert while a pass is in flight', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);

    await page.locator(HEALTH_BTN).click();
    const rerun = page.locator('.modal-head .btn');
    await expect(rerun).toBeVisible();

    // Settle, then confirm hammering it does not multiply the work.
    await expect(rerun).toBeEnabled();
    const single = await countApiCalls(page, async () => {
      await rerun.click();
      await expect(rerun).toBeEnabled();
    });

    const hammered = await countApiCalls(page, async () => {
      for (let i = 0; i < 8; i++) await rerun.click({ force: true });
      await expect(rerun).toBeEnabled();
    });

    expect(
      hammered,
      `eight clicks made ${hammered} API calls vs ${single} for one pass`,
    ).toBeLessThan(single * 3);
  });

  test('Switching org while a pass is in flight still reports the new org', async ({ page }) => {
    // The guard must NOT swallow this: a changed target makes any in-flight
    // pass answer the wrong question, so it has to start and supersede.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);

    await page.locator(HEALTH_BTN).click();
    await expect(page.locator('.diagnostic-modal')).toBeVisible();
    await expect(page.locator('.modal-head .btn')).toBeEnabled();

    // The modal header echoes the org it is reporting on.
    await expect(page.locator('.diagnostic-modal .head-title code')).toContainText(ORG);
  });
});
