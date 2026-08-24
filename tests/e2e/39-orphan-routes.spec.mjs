// 39 - Link what exists, or remove it (UX_PLAN WS6, §8)
//
// Four routes shipped that nothing in the app linked to, so the only way in
// was to know the URL:
//
//   /usage                  the only cross-org view in the app. Zero links.
//   /dashboard/:org/usage   one link - from /usage, which had none itself, so
//                           the pair was unreachable together.
//   /setup                  the App Manifest form. Zero links, and the moment
//                           anybody needs it (no App exists) was a diagnostic
//                           branch that returned silently.
//   /sandbox                fabricated cohort data on a public Pages site.
//                           Zero links, and no reason to be there at all.
//
// Plus one feature with no UI: `pxl-classroom feedback list` answers "is the
// PR still open and has anyone left review comments", and the table showed
// only a number.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'linux-processes-2026';
const TITLE = 'Linux Processes 2026';

const assignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: TITLE,
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'enforced',
  max_acceptances: 150,
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 86400_000).toISOString(),
  template: { owner: ORG, repository: 'linux-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  feedback_pr: true,
  feedback_pr_baseline_branch: 'pxl-baseline',
  ...over,
});

const dashboard = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  assignments: {
    [ID]: { title: TITLE, state: 'published', deadline_at: new Date(Date.now() + 86400_000).toISOString(), accepted: 2 },
  },
};

// ============================================================== /usage

test.describe('39 - The cross-org usage view has a way in', () => {
  test('The org switcher carries it, with a label rather than an icon', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: { dashboard },
    });
    await page.goto(`/dashboard/${ORG}`);

    await page.locator('.org-dropdown-btn').click();
    // role="option" here, matching its sibling "Connect an organization": the
    // container is a listbox, so an <a> inside it is announced as an option.
    const link = page.locator('.org-dropdown-menu .org-dropdown-item', { hasText: /Usage . limits/i });
    await expect(link).toBeVisible();

    await link.click();
    await expect(page).toHaveURL(/\/usage$/);
    // And it is the real view, not a 404 that happens to have the URL.
    await expect(page.locator('.not-found-page')).toHaveCount(0);
  });

  test('Choosing it closes the dropdown behind it', async ({ page }) => {
    // It sits in a listbox that closes on outside click; a navigation is not
    // an outside click, so without an explicit close it would still be open
    // on the way back.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, reports: { dashboard } });
    await page.goto(`/dashboard/${ORG}`);

    await page.locator('.org-dropdown-btn').click();
    await expect(page.locator('.org-dropdown-menu')).toBeVisible();
    await page.locator('.org-dropdown-menu .org-dropdown-item', { hasText: /Usage . limits/i }).click();
    await expect(page.locator('.org-dropdown-menu')).toHaveCount(0);
  });
});

// ================================================= /dashboard/:org/usage

test.describe('39 - The usage panel points at its own detail view', () => {
  test('Full report opens the per-org view', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: { dashboard },
    });
    await page.goto(`/dashboard/${ORG}`);

    const full = page.locator('.usage-panel').getByRole('link', { name: /Full report/i });
    await expect(full).toBeVisible({ timeout: 15000 });
    await full.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/usage$`));
  });

  test('Clicking it does not also collapse the panel it sits in', async ({ page }) => {
    // The panel header IS the accordion toggle (role="button"), so the link
    // needs @click.stop. Without it the lecturer navigates away and finds the
    // panel shut when they come back.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: { dashboard },
    });
    await page.goto(`/dashboard/${ORG}`);

    const panel = page.locator('.usage-panel');
    await expect(panel).toBeVisible({ timeout: 15000 });
    const expandedBefore = await panel.evaluate((el) => !el.classList.contains('is-collapsed'));

    await panel.getByRole('link', { name: /Full report/i }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/usage$`));

    await page.goBack();
    await expect(page.locator('.usage-panel')).toBeVisible({ timeout: 15000 });
    const expandedAfter = await page.locator('.usage-panel')
      .evaluate((el) => !el.classList.contains('is-collapsed'));
    expect(expandedAfter, 'the toggle must not have fired under the link').toBe(expandedBefore);
  });
});

// ============================================================== /setup

test.describe('39 - /setup is offered where somebody discovers they need it', () => {
  /** Make GET /apps/{slug} answer as if no such App exists. */
  async function noApp(page, status = 404) {
    await page.route('**/api.github.com/apps/pxl-classroom-provisioner*', (route) =>
      route.fulfill({ status, body: JSON.stringify({ message: 'Not Found' }) }));
  }

  async function openTier1(page) {
    await page.locator('button[aria-label="System health check"]').click();
    const overlay = page.locator('.modal-overlay:has(.diagnostic-modal)');
    await expect(overlay.locator('.diag-banner')).toBeVisible({ timeout: 15000 });
    const tier1 = overlay.locator('.tier-card', { hasText: 'Course Organization & GitHub App' });
    await expect(tier1).toBeVisible();
    if (!(await tier1.locator('.tier-checks').isVisible())) {
      await tier1.locator('.tier-header').click();
    }
    await expect(tier1.locator('.tier-checks')).toBeVisible();
    return { overlay, tier1 };
  }

  test('A missing App is reported, and the fix goes to the setup form', async ({ page }) => {
    // This branch returned silently before: `if (appRes.ok) { … }` and no
    // else. Everything below Tier 1 is downstream of the App existing, so a
    // lecturer got a wall of failures and no cause.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, reports: { dashboard } });
    await noApp(page);
    await page.goto(`/dashboard/${ORG}`);

    const { tier1 } = await openTier1(page);
    const check = tier1.locator('.check-item', { hasText: 'GitHub App Declaration' });
    await expect(check).toContainText(/No GitHub App named/i);
    await expect(check).toContainText(/pxl-classroom-provisioner/);

    const fix = check.getByRole('button', { name: /Open App setup/i });
    await expect(fix).toBeVisible();
    await fix.click();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.locator('.setup-view')).toBeVisible();
  });

  test('An App that cannot be read stays silent, because a false alarm forks the install base', async ({ page }) => {
    // 404 is "no such App". A 403, a 500 or a rate limit is "we could not
    // ask" - and telling somebody to create an App when one already exists
    // splits every org's installation across two of them.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, reports: { dashboard } });
    await noApp(page, 500);
    await page.goto(`/dashboard/${ORG}`);

    const { tier1 } = await openTier1(page);
    await expect(
      tier1.locator('.check-item', { hasText: 'GitHub App Declaration' }),
      'no verdict at all beats the wrong one here',
    ).toHaveCount(0);
  });

  test('A healthy App says so and offers nothing', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, reports: { dashboard } });
    await page.goto(`/dashboard/${ORG}`);

    const { tier1 } = await openTier1(page);
    const check = tier1.locator('.check-item', { hasText: 'GitHub App Declaration' });
    await expect(check).toContainText(/declares every permission/i);
    await expect(check.getByRole('button', { name: /Open App setup/i })).toHaveCount(0);
  });
});

// ===================================================== feedback PR status

test.describe('39 - The Feedback PR column answers what the CLI answers', () => {
  const students = [
    { github_login: 'student-a', acceptance_state: 'accepted', submission_status: 'on-time', repo_name: `${ID}-student-a`, commit_count: 3 },
    { github_login: 'student-b', acceptance_state: 'accepted', submission_status: 'on-time', repo_name: `${ID}-student-b`, commit_count: 1 },
  ];

  const report = {
    schema_version: 1, assignment_id: ID, org: ORG, generated_at: new Date().toISOString(),
    students,
  };

  /** Repository records are where feedback_pr_number is stitched on from. */
  const records = {
    'student-a': { github_login: 'student-a', feedback_pr_number: 7, feedback_pr_url: `https://github.com/${ORG}/${ID}-student-a/pull/7` },
    'student-b': { github_login: 'student-b' },
  };

  async function open(page, { prs = {}, sink = [] } = {}) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: { [ID]: report },
    });
    // repositories/<id>/<login>.json - what the view stitches PR numbers from.
    await page.route('**/pxl-classroom-control/contents/repositories/**', async (route) => {
      const url = route.request().url();
      const file = url.match(/repositories\/[^/]+\/([^/?#]+)\.json/);
      if (file) {
        const doc = records[file[1]];
        if (!doc) {
          await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
          return;
        }
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ content: Buffer.from(JSON.stringify(doc)).toString('base64'), encoding: 'base64' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        body: JSON.stringify(Object.keys(records).map((l) => ({
          name: `${l}.json`, path: `repositories/${ID}/${l}.json`, type: 'file',
        }))),
      });
    });
    // GET /repos/:org/:repo/pulls/:n - state, draft and review_comments in one.
    await page.route(/api\.github\.com\/repos\/[^/]+\/[^/]+\/pulls\/\d+(\?|$)/, async (route) => {
      const n = Number(route.request().url().match(/pulls\/(\d+)/)[1]);
      sink.push(n);
      const body = prs[n];
      if (!body) {
        await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
        return;
      }
      await route.fulfill({ status: 200, body: JSON.stringify(body) });
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(page.locator('.students-table, table')).toBeVisible({ timeout: 15000 });
  }

  const menu = async (page) => {
    await page.locator('.export-dropdown-btn, button', { hasText: /More/i }).first().click();
  };

  test('It is a live read behind a control, not N requests on render', async ({ page }) => {
    // One request per open PR. On a 200-student cohort that is 200 requests
    // nobody asked for, so nothing is fetched until the lecturer asks.
    const sink = [];
    await open(page, { prs: { 7: { state: 'open', draft: true, review_comments: 0 } }, sink });
    await expect(page.locator('td.col-feedback-pr').first()).toContainText('#7');
    expect(sink, 'nothing fetched on render').toEqual([]);

    await menu(page);
    await page.getByRole('menuitem', { name: /Refresh feedback PR status/i }).click();
    await expect.poll(() => sink.length, { timeout: 15000 }).toBe(1);
    expect(sink, 'only the student who HAS a PR is asked about').toEqual([7]);
  });

  test('State and review-comment count land in the column', async ({ page }) => {
    await open(page, { prs: { 7: { state: 'open', draft: false, review_comments: 4 } } });
    await menu(page);
    await page.getByRole('menuitem', { name: /Refresh feedback PR status/i }).click();

    const cell = page.locator('td.col-feedback-pr').first();
    await expect(cell).toContainText('Open', { timeout: 15000 });
    await expect(cell).toContainText('4');
    await expect(page.locator('.toast', { hasText: /1 carry review comments|1 feedback PR/i }).first())
      .toBeVisible();
  });

  test('A draft PR reads as Draft, not as Open', async ({ page }) => {
    // Every PR this system opens starts as a draft - reporting them all as
    // "Open" would make the column say the same thing for every student.
    await open(page, { prs: { 7: { state: 'open', draft: true, review_comments: 0 } } });
    await menu(page);
    await page.getByRole('menuitem', { name: /Refresh feedback PR status/i }).click();
    await expect(page.locator('td.col-feedback-pr').first()).toContainText('Draft', { timeout: 15000 });
  });

  test('A merged PR is not reported as closed-and-abandoned', async ({ page }) => {
    await open(page, { prs: { 7: { state: 'closed', draft: false, merged_at: new Date().toISOString(), review_comments: 2 } } });
    await menu(page);
    await page.getByRole('menuitem', { name: /Refresh feedback PR status/i }).click();
    const cell = page.locator('td.col-feedback-pr').first();
    await expect(cell).toContainText('Merged', { timeout: 15000 });
    await expect(cell).not.toContainText('Closed');
  });

  test('A PR that has been deleted stops claiming it is open', async ({ page }) => {
    // 404 means the PR is gone. Leaving a stale "Open" beside a dead link is
    // the report telling the lecturer to go and review nothing.
    await open(page, { prs: {} });
    await menu(page);
    await page.getByRole('menuitem', { name: /Refresh feedback PR status/i }).click();
    await expect(page.locator('td.col-feedback-pr').first()).toContainText('Closed', { timeout: 15000 });
  });

  test('The control is disabled while no PR has been opened', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: { [ID]: { ...report, students: [{ ...students[1] }] } },
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(page.locator('.students-table, table')).toBeVisible({ timeout: 15000 });

    await menu(page);
    const item = page.getByRole('menuitem', { name: /Refresh feedback PR status/i });
    await expect(item).toBeDisabled();
    await expect(item).toContainText(/No feedback PRs have been opened yet/i);
  });

  test('A student with no PR is left alone, not marked closed', async ({ page }) => {
    await open(page, { prs: { 7: { state: 'open', draft: false, review_comments: 1 } } });
    await menu(page);
    await page.getByRole('menuitem', { name: /Refresh feedback PR status/i }).click();
    await expect(page.locator('td.col-feedback-pr').first()).toContainText('Open', { timeout: 15000 });

    const rows = page.locator('td.col-feedback-pr');
    await expect(rows.nth(1)).toContainText('pending');
    await expect(rows.nth(1)).not.toContainText('Closed');
  });
});
