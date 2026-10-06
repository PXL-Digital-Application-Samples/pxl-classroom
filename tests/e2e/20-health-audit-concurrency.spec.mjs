import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, openAdvanced, healthPanel } from '../fixtures/e2e-fixtures.mjs';

// A System Health pass is a fan-out of GitHub REST calls made from the browser -
// not a workflow dispatch. So an impatient lecturer cannot start runaway Actions
// runs, but before the guard landed they COULD stack concurrent passes: the
// isOpen watcher called run() on every open with no check on `running`, and the
// component is never unmounted (only its inner v-if content is), so state
// persisted across open/close.
//
// On the Organization tab it is part of the page (2026-10-06): opening its
// section runs the checks, closing it hides them, and "Check again" re-runs.
// The same guards hold - an open is what a click on Run the checks used to be.

const healthFold = (page) => page.locator('details.org-health');
const toggleHealth = (page, opts) => healthFold(page).locator('> summary').click(opts);
const rerun = (page) => healthPanel(page).locator('[data-health-rerun]');

async function toOrganization(page) {
  await page.goto(`/dashboard/${ORG}/organization`);
  await openAdvanced(page);
  await expect(healthFold(page)).toBeVisible();
}

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
  test('Opening and closing it mid-pass does not stack another diagnostic pass', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await toOrganization(page);

    // Baseline cost of exactly one pass, measured at full speed.
    const single = await countApiCalls(page, async () => {
      await toggleHealth(page);
      await expect(healthPanel(page)).toBeVisible();
      await expect(rerun(page)).toBeEnabled({ timeout: 15000 });
    });
    expect(single, 'a diagnostic pass should make GitHub API calls').toBeGreaterThan(0);

    await toggleHealth(page);
    await expect(healthPanel(page)).toBeHidden();

    // Now slow GitHub down so one pass spans the whole thrash, then open/close
    // six times inside that window. Unguarded, every open started a new pass.
    await slowDownGitHub(page, 250);

    const thrash = await countApiCalls(page, async () => {
      for (let i = 0; i < 6; i++) {
        await toggleHealth(page, { noWaitAfter: true });
        await toggleHealth(page, { noWaitAfter: true });
      }
      await toggleHealth(page, { noWaitAfter: true });
      await expect(rerun(page)).toBeEnabled({ timeout: 20000 });
    });

    // Seven opens inside one pass's lifetime. Guarded, the later opens are
    // no-ops, so the total stays near a single pass rather than a multiple.
    expect(
      thrash,
      `seven rapid opens made ${thrash} API calls; one pass costs ${single}. ` +
        'Passes are stacking - the reopen guard is not holding.',
    ).toBeLessThan(single * 2);
  });

  test('Check again is inert while a pass is in flight', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await toOrganization(page);
    await toggleHealth(page);

    // Settle, then confirm hammering it does not multiply the work.
    await expect(rerun(page)).toBeEnabled({ timeout: 15000 });
    const single = await countApiCalls(page, async () => {
      await rerun(page).click();
      await expect(rerun(page)).toBeEnabled();
    });

    const hammered = await countApiCalls(page, async () => {
      for (let i = 0; i < 8; i++) await rerun(page).click({ force: true });
      await expect(rerun(page)).toBeEnabled();
    });

    expect(
      hammered,
      `eight clicks made ${hammered} API calls vs ${single} for one pass`,
    ).toBeLessThan(single * 3);
  });

  test('It says which organization it checked', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await toOrganization(page);
    await toggleHealth(page);
    await expect(rerun(page)).toBeEnabled({ timeout: 15000 });
    await expect(healthPanel(page).locator('.health-inline-head')).toContainText(`Checked ${ORG}`);
  });
});

test.describe('20b - Read timeouts', () => {
  test('A stalled GitHub ends every part of the page, and System health reports it', async ({ page }) => {
    // The whole point is measuring a slow path, so it needs more than the
    // 60s default before Playwright kills it.
    test.setTimeout(300000);
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });

    // Black-hole every GitHub call: never respond, never reject. ghApi used to
    // be a bare fetch() with no AbortSignal, so this stranded the page behind
    // a spinner with no way out but a reload.
    await page.route('https://api.github.com/**', async () => {
      await new Promise(() => {});
    });

    const started = Date.now();
    await page.goto(`/dashboard/${ORG}/organization`);

    // The page itself: no spinner left behind - it says GitHub did not answer.
    await expect(page.getByText(/GitHub did not answer in time/)).toBeVisible({ timeout: 40000 });
    await expect(page.locator('.org-needs-loading')).toHaveCount(0);
    const pageElapsed = Date.now() - started;

    // System health is still there - it is the tool for exactly this.
    await openAdvanced(page);
    const healthStarted = Date.now();
    await toggleHealth(page);
    await expect(healthPanel(page)).toBeVisible();

    // The pass must finish and hand the control back.
    await expect(rerun(page)).toBeEnabled({ timeout: 120000 });
    const elapsed = Date.now() - healthStarted;

    // And it must say what went wrong. runDiagnostics turns a thrown request
    // into a failed CHECK rather than letting it escape, so the failure lands
    // inside the report - a better surface than a toast. It must name the real
    // problem: a stalled network reaching tier 0 used to be reported as
    // "session is invalid or expired - sign in again", sending the lecturer to
    // re-authenticate a session that was never at fault.
    const msgs = (await healthPanel(page).locator('.check-msg').allTextContents()).join(' ');
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
    console.log(`  [stalled-network] page ended in ${Math.round(pageElapsed / 1000)}s, health reported in ${Math.round(elapsed / 1000)}s`);
  });
});
