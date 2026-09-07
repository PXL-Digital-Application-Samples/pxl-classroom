// 73 - Saving an imminent deadline arms the sentinel.
//
// `deadline-sentinel.yml` arms from a 4-hourly cron for every deadline inside a
// 4.5h window, then sleeps to the exact instant and locks. A cron cannot see a
// change made after it last fired, and there are two such moments:
//
//   * publishing an exam at 10:15 for a 12:00 deadline, where the last firing
//     was 08:00 and the next is 14:00 - covered by publish-assignment.yml,
//     which is a workflow and is verified live rather than here;
//   * EDITING a live assignment to bring its deadline forward, from next week
//     to this afternoon. That is not a publish, so nothing armed it at all,
//     and the editor is exactly where somebody reschedules under time
//     pressure. That half is this file.
//
// A miss is survivable and wrong: marks are unaffected (late is decided by the
// commit's own timestamp) while the repositories stay writable until the
// nightly, up to fourteen hours later.
//
// Everything here asserts on the DISPATCH LEAVING THE BROWSER, because arming
// is invisible in the UI by design - it is a precision layer the lecturer is
// deliberately not asked to care about.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'sentinel-lab';
const HOUR = 3600_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

const assignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'Sentinel Lab',
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: iso(-24 * HOUR),
  deadline_at: iso(7 * 24 * HOUR),
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
  ...over,
});

// A draft's button reads "Save as draft" and a published one "Save changes",
// so the name has to admit both - matching only one silently skips the very
// case that distinguishes them.
const saveBtn = (page) => page.getByRole('button', { name: /^Save\b/i }).first();
const sentinelDispatches = (d) => d.filter((x) => x.workflow === 'deadline-sentinel.yml');

/** Open the editor on an existing assignment. */
async function openEditor(page, over = {}) {
  const workflowDispatches = [];
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment(over) },
    workflowDispatches,
    contentWrites,
  });
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Sentinel Lab', {
    timeout: 15000,
  });
  return { workflowDispatches, contentWrites };
}

/** Type a new deadline into the schedule field and save. */
async function setDeadlineAndSave(page, whenMs) {
  const local = new Date(Date.now() + whenMs);
  const pad = (n) => String(n).padStart(2, '0');
  const value =
    `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}` +
    `T${pad(local.getHours())}:${pad(local.getMinutes())}`;
  // The schedule lives inside the settings disclosure, which is collapsed for
  // a published assignment with a cohort - so a test that just fills the field
  // fails on "element is not visible" rather than on anything it meant to say.
  const disclosure = page.locator('details.settings-disclosure');
  if (await disclosure.count()) {
    const summary = disclosure.locator('> summary');
    if ((await summary.isVisible()) && !(await disclosure.evaluate((d) => d.open))) {
      await summary.click();
    }
  }
  const field = page.locator('input[type="datetime-local"]').nth(1);
  await field.fill(value);
  await saveBtn(page).click();
  await expect(page.locator('.toast', { hasText: /Saved/i })).toBeVisible({ timeout: 15000 });
}

test.describe('73 - a deadline brought forward arms the sentinel', () => {
  test('THE REGRESSION: next week becomes two hours from now', async ({ page }) => {
    // The scenario. Nothing about this is a publish, so before this change the
    // deadline waited for a cron firing that might come after it.
    const { workflowDispatches } = await openEditor(page);
    await setDeadlineAndSave(page, 2 * HOUR);

    await expect
      .poll(() => sentinelDispatches(workflowDispatches).length, { timeout: 10000 })
      .toBe(1);
    expect(sentinelDispatches(workflowDispatches)[0].inputs).toMatchObject({ org: ORG });
  });

  test('a deadline beyond the window is left to the cron', async ({ page }) => {
    // Arming must be conditional. A deadline a week out would spawn a sentinel
    // that sleeps for a week, and the GitHub job limit is six hours.
    const { workflowDispatches } = await openEditor(page);
    await setDeadlineAndSave(page, 30 * HOUR);

    await page.waitForTimeout(1500);
    expect(sentinelDispatches(workflowDispatches)).toEqual([]);
  });

  test('the boundary: just inside arms, just outside does not', async ({ page }) => {
    // 4.5h is the window. Asserting only the middle of the range would pass
    // against a check with the wrong comparison or the wrong constant.
    const inside = await openEditor(page);
    await setDeadlineAndSave(page, 4 * HOUR);
    await expect.poll(() => sentinelDispatches(inside.workflowDispatches).length, { timeout: 10000 }).toBe(1);

    const outside = await openEditor(page);
    await setDeadlineAndSave(outside.page ?? page, 5 * HOUR);
    await page.waitForTimeout(1500);
    expect(sentinelDispatches(outside.workflowDispatches)).toEqual([]);
  });
});

test.describe('73 - what must NOT arm', () => {
  test('a DRAFT with an imminent deadline arms nothing', async ({ page }) => {
    // There is nobody to freeze. A draft assignment has no accepted students
    // and no repositories, so a sentinel would wake to an empty cohort.
    const { workflowDispatches } = await openEditor(page, { state: 'draft' });
    await setDeadlineAndSave(page, 2 * HOUR);

    await page.waitForTimeout(1500);
    expect(sentinelDispatches(workflowDispatches)).toEqual([]);
  });

  test('a deadline already PAST arms nothing', async ({ page }) => {
    // The sentinel stops writes at an instant. An instant that has gone is the
    // nightly's job; arming for it spawns a job that wakes, finds the moment
    // gone and exits - noise that looks like coverage.
    const { workflowDispatches } = await openEditor(page, { deadline_at: iso(-3 * HOUR) });
    await setDeadlineAndSave(page, -1 * HOUR);

    await page.waitForTimeout(1500);
    expect(sentinelDispatches(workflowDispatches)).toEqual([]);
  });
});

test.describe('73 - arming is a precision layer, never a gate', () => {
  test('A FAILED DISPATCH DOES NOT FAIL THE SAVE', async ({ page }) => {
    // Dispatching a hub workflow needs write access on the hub, which most
    // lecturers do not have (OPEN-ITEMS 4). If that turned a successful save
    // into a red toast, the common case would look broken while the deadline
    // was in fact perfectly safe - the cron and the nightly are both still
    // behind it.
    const workflowDispatches = [];
    const contentWrites = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      workflowDispatches,
      contentWrites,
    });
    await page.route('**/actions/workflows/deadline-sentinel.yml/dispatches', (route) =>
      route.fulfill({ status: 403, body: JSON.stringify({ message: 'Resource not accessible by integration' }) }));

    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Sentinel Lab', { timeout: 15000 });
    await setDeadlineAndSave(page, 2 * HOUR);

    // The save itself landed, and said so.
    expect(
      contentWrites.some((w) => w.path === `assignments/${ID}.yml`),
      'the assignment must still be written when arming fails',
    ).toBe(true);
    await expect(page.locator('.toast', { hasText: /failed|error/i })).toHaveCount(0);
  });

  test('the save is not blocked waiting on the dispatch', async ({ page }) => {
    // A hung dispatch must not hold the editor. The save is the thing the
    // lecturer is waiting on; arming is behind it.
    const workflowDispatches = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      workflowDispatches,
    });
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route('**/actions/workflows/deadline-sentinel.yml/dispatches', async (route) => {
      await held;
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Sentinel Lab', { timeout: 15000 });
    await setDeadlineAndSave(page, 2 * HOUR);
    // setDeadlineAndSave already waited for the "Saved" toast with the
    // dispatch still in flight, which is the assertion.
    release();
  });
});
