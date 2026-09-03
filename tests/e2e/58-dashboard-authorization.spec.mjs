// 58 - A student must not be handed the lecturer dashboard.
//
// Reported live with a screenshot, 2026-09-03. `tomccargo` - a test STUDENT
// account, not a member of PXL-Automation-II - signed in and saw the
// organization in the switcher, a "Lecturer" tag beside their name, and:
//
//   "Almost there - PXL-Automation-II needs its control repository"
//   [ Open Setup Organization ]
//
// The control repository existed. They simply could not read it, and GitHub
// returns 404 rather than 403 for a private repository you cannot see - so
// "does not exist" and "not yours" arrived identically and the page picked the
// friendlier one. The organization reaches the switcher for anyone whose App
// installation touches it, which accepting ONE assignment is enough to do.
//
// Nothing was exposed: every read behind that screen is the private control
// repo and every write is refused by GitHub. But a surface that hands a student
// a staff console and an admin button is its own defect - and it teaches them
// they have found a hole.
//
// THE FIXTURE COULD NOT EXPRESS THIS. "Student" meant "no installations at
// all", so no test could reach the dashboard as one; `studentHasInstallation`
// is what makes the reported situation reachable.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

/** The control repository is invisible - the 404 that means two things. */
async function controlRepoUnreadable(page) {
  await page.route(`**/api.github.com/repos/${ORG}/pxl-classroom-control*`, (route) =>
    route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
}

/** No write on the hub, which is what Setup Organization would need. */
async function noHubWrite(page) {
  await page.route('**/api.github.com/repos/PXL-Digital-Application-Samples/pxl-classroom', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ name: 'pxl-classroom', permissions: { push: false } }),
    }));
}

test.describe('58 - The dashboard refuses an account with no staff access', () => {
  test('a student who accepted an assignment is refused, not onboarded', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {},
      studentHasInstallation: true,
    });
    await controlRepoUnreadable(page);
    await noHubWrite(page);

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.center-card');
    await expect(card).toBeVisible({ timeout: 20000 });

    await expect(card).toContainText(/lecturer view for/i);
    await expect(card, 'the org is right there in the switcher, so say why')
      .toContainText(/at least one repository in it/i);

    // The three things that made the screenshot alarming.
    await expect(page.locator('.lecturer-tag'), 'a role nothing had checked').toHaveCount(0);
    await expect(card, 'the repository exists - this claimed it does not')
      .not.toContainText(/needs its control repository/i);
    await expect(page.getByRole('button', { name: /Setup Organization/i }), 'an admin action they cannot run')
      .toHaveCount(0);
    await expect(page.getByRole('link', { name: /Setup Organization/i })).toHaveCount(0);
  });

  test('and is given the way back to their own assignments', async ({ page }) => {
    // A dead end reads like a bug. The one thing they can actually do is the
    // single primary action here (DESIGN.md §1.2).
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1, assignments: {}, studentHasInstallation: true,
    });
    await controlRepoUnreadable(page);
    await noHubWrite(page);

    await page.goto(`/dashboard/${ORG}`);
    const back = page.getByRole('link', { name: /My assignments/i });
    await expect(back).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.btn-primary')).toHaveCount(1);
  });

  test('an org OWNER onboarding a new organization is NOT refused', async ({ page }) => {
    // The persona the fix must not break, and the reason hub write alone was
    // not enough: a lecturer who has just been made an org owner has no write
    // on the hub, and produces exactly the same 404 as the student above.
    // GET /orgs/{org} separates them - `default_repository_permission` is
    // returned to an owner and null to everyone else.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await controlRepoUnreadable(page);
    await noHubWrite(page);

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.setup-required-card');
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card).toContainText(/needs its control repository/i);
    // Still no dead button - they cannot dispatch it themselves.
    await expect(card).toContainText(/a hub admin runs/i);
  });

  test('the org admin check is a POSITIVE signal, so a failed read refuses', async ({ page }) => {
    // Unreadable is not evidence of authority. If GET /orgs/{org} cannot be
    // read, the page must not admit on the strength of not knowing.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await controlRepoUnreadable(page);
    await noHubWrite(page);
    await page.route(`**/api.github.com/orgs/${ORG}`, (route) =>
      route.fulfill({ status: 500, body: JSON.stringify({ message: 'boom' }) }));

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.center-card');
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card).toContainText(/lecturer view for/i);
    await expect(card).not.toContainText(/needs its control repository/i);
  });
});
