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

test.describe('20b - Read timeouts', () => {
  test('A stalled GitHub read is bounded and reported, not left hanging', async ({ page }) => {
    // The whole point is measuring a slow path, so it needs more than the
    // 60s default before Playwright kills it.
    test.setTimeout(300000);
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });

    // Black-hole every GitHub call: never respond, never reject. ghApi used to
    // be a bare fetch() with no AbortSignal, so this stranded the modal behind
    // a spinner with no way out but a reload.
    await page.route('https://api.github.com/**', async () => {
      await new Promise(() => {});
    });

    await page.goto(`/dashboard/${ORG}`);
    const started = Date.now();
    await page.locator(HEALTH_BTN).click();
    await expect(page.locator('.diagnostic-modal')).toBeVisible();

    // runDiagnostics turns a thrown request into a failed CHECK rather than
    // letting it escape, so the timeout surfaces inside the report - which is
    // the better surface than a toast.
    // The pass must finish and hand the control back.
    await expect(page.locator('.modal-head .btn')).toBeEnabled({ timeout: 120000 });
    const elapsed = Date.now() - started;

    // And it must say what went wrong. runDiagnostics turns a thrown request
    // into a failed CHECK rather than letting it escape, so the failure lands
    // inside the report - a better surface than a toast.
    // It must name the real problem. A stalled network reaching tier 0 used to
    // be reported as "session is invalid or expired - sign in again", sending
    // the lecturer to re-authenticate a session that was never at fault.
    const msgs = (await page.locator('.check-msg').allTextContents()).join(' ');
    expect(msgs, 'the report must blame the network, not the session').toMatch(/could not reach github/i);
    expect(msgs, 'must not tell the user to sign in again for a network fault')
      .not.toMatch(/sign in again/i);

    // runDiagnostics awaits ~17 checks in sequence, so a per-request bound alone
    // would still cost 17 x 10s here. The pass budget is what keeps this near
    // 30s instead of minutes.
    expect(
      elapsed,
      `a fully stalled network took ${Math.round(elapsed / 1000)}s to report`,
    ).toBeLessThan(60000);
    console.log(`  [stalled-network] reported in ${Math.round(elapsed / 1000)}s`);
  });
});
