// 69 - Refresh has to SAVE, not just redraw.
//
// Reported from a live org as a red toast: "Refreshed locally but save failed."
// The table updated, the footer said "Live-refreshed 14:57", and nothing was
// written - so a reload, and every other lecturer's Dashboard, went on showing
// the nightly snapshot.
//
// The cause was one line, five days old:
//
//   const reportPath = reportPath(props.assignmentId)
//
// `reportPath` is imported at the top of the view. That declaration shadows the
// import for the whole block, and its own initializer then reads it inside the
// temporal dead zone - so the line threw `Cannot access 'reportPath' before
// initialization` on EVERY refresh, into a catch that reported "save failed".
// It arrived in a refactor that replaced an inline path string with the helper
// and named the local after it.
//
// Nothing caught it. The build is happy (it is valid syntax), eslint is happy
// (`no-use-before-define` and `no-shadow` both flag it, and both flag 31 and 82
// other sites that are fine, so neither is on), and no test pressed Refresh and
// looked for a write. That last one is the cheap guard, and it is this file:
// the assertion is on the CONTENT LEAVING THE BROWSER, because everything else
// about a broken save looks exactly like a working one.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'linux-processes-2026';

const assignment = () => ({
  schema_version: 1,
  id: ID,
  title: 'Linux Processes 2026',
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
});

// NO `org:` FIELD. The report schema is `additionalProperties: false` and has
// no such root property - several specs stage one anyway and stay green,
// because they never reach a save. This file does reach it, so the fixture has
// to be the shape the app actually writes.
const report = () => ({
  schema_version: 1,
  assignment_id: ID,
  generated_at: new Date(Date.now() - 3600_000).toISOString(),
  students: [
    // `repo_name` is required, not decoration: refreshLiveStatus queues only
    // students that have one, and returns early with "No provisioned
    // repositories to check" if none do - which is a green test that never
    // reached the save it was written to guard.
    {
      github_login: 'alice-dev',
      acceptance_state: 'accepted',
      submission_status: 'on-time',
      repo_name: `${ID}-alice-dev`,
    },
  ],
});

async function openDetail(page) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment() },
    reports: { [ID]: report() },
    contentWrites,
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.locator('.cohort-table, table').first()).toBeVisible({ timeout: 15000 });
  return { contentWrites };
}

const refreshButton = (page) => page.getByRole('button', { name: /^Refresh$/i }).first();
const reportWrites = (w) => w.filter((x) => x.path === `reports/${ID}.json`);

test.describe('69 - a live refresh writes what it shows', () => {
  test('THE REGRESSION: pressing Refresh commits the report', async ({ page }) => {
    const { contentWrites } = await openDetail(page);
    await refreshButton(page).click();

    // The whole guard. Before the fix this stayed at 0 for ever while the
    // screen updated and the toast said the save had failed.
    await expect.poll(() => reportWrites(contentWrites).length, { timeout: 20000 }).toBe(1);
  });

  test('and what it writes is the refreshed snapshot, not the old one', async ({ page }) => {
    // A write that happened is not the same as a write that carried the
    // refresh: `live_refreshed_at` is set immediately before the save, so it is
    // the field that proves the two are the same act.
    const { contentWrites } = await openDetail(page);
    await refreshButton(page).click();
    await expect.poll(() => reportWrites(contentWrites).length, { timeout: 20000 }).toBe(1);

    const written = JSON.parse(reportWrites(contentWrites)[0].content);
    expect(written.assignment_id).toBe(ID);
    expect(written.live_refreshed_at, 'the saved report carries the refresh').toBeTruthy();
    expect(written.live_refreshed_by).toBe(LECTURER.login);
  });

  test('it does not report success it did not have', async ({ page }) => {
    // The inverse of the bug. "Refreshed locally but save failed" was at least
    // honest; the failure this test guards against is the opposite one, where a
    // save that never happened is announced as done.
    const { contentWrites } = await openDetail(page);
    await refreshButton(page).click();

    await expect(page.locator('.toast, [role="status"]').filter({ hasText: /saved/i }))
      .toBeVisible({ timeout: 20000 });
    expect(reportWrites(contentWrites).length,
      'a "saved" toast must mean a write actually left the browser').toBe(1);
  });
});
