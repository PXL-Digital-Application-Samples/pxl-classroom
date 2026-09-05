// 60 - The refusals a lecturer never saw.
//
// A rejection is an OUTCOME, not a failure: `accept.mjs` exits 0 for every
// `rejected:*` so a student who is not on the roster does not paint the hub's
// Actions tab red, and `acceptance-handler.yml` tells the lecturer by
// commenting on a tracking issue in the private control repo.
//
// That was the whole of it. The Admin Panel showed nothing, so an assignment
// refusing exactly the students it was configured to refuse looked identical,
// on screen, to a broken invitation link - and the lecturer's only way to tell
// the difference was to leave the app and read GitHub. Sharpest for a cohort,
// where "the right people were turned away" is the feature working.
//
// The panel is INLINE. The help drawer owns the overlay layer (position: fixed,
// above the modals), and a second panel competing for it is the failure
// tests/e2e/47 exists for.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
import { DEDUP_MARKER, rejectionDedupKey } from '../../lib/rejection-notice.mjs';

const ID = 'lab-3';

const ISSUE = {
  number: 7,
  state: 'open',
  html_url: `https://github.com/${ORG}/pxl-classroom-control/issues/7`,
  labels: [{ name: 'pxl-tracking' }],
};

/** A notification comment exactly as notify.mjs writes one. */
const refusal = (login, outcome, assignmentId = ID) => ({
  id: Math.floor(Math.random() * 1e6),
  body:
    `${DEDUP_MARKER}${rejectionDedupKey({ assignmentId, login, outcome })}-->\n` +
    `### ⚠️ acceptance-rejected\n\n**Assignment:** ${assignmentId}\n**Time:** 2026-09-05T10:00:00Z\n\n` +
    `\`${login}\` tried to accept and was turned away: **${outcome}**\n`,
});

const assignment = () => ({
  schema_version: 1,
  id: ID,
  title: 'Lab 3',
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: '2026-09-01T08:00:00Z',
  deadline_at: '2026-12-30T20:00:00Z',
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'enforced',
  cohort: ['num:0001'],
});

const panel = (page) => page.locator('.rejections');

async function detail(page, opts = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment() },
    reports: { [ID]: { schema_version: 1, assignment_id: ID, students: [] } },
    ...opts,
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.locator('.table-footer')).toBeVisible({ timeout: 20000 });
}

test.describe('60 - refusals reach the lecturer in the app', () => {
  test('the reasons are named, in plain language, with who', async ({ page }) => {
    await detail(page, {
      trackingIssue: ISSUE,
      trackingComments: [
        refusal('cara', 'rejected:not-in-cohort'),
        refusal('dries', 'rejected:not-in-cohort'),
        refusal('zoe', 'rejected:not-on-roster'),
        refusal('finn', 'rejected:cap-reached'),
        // Another assignment's refusal on the SAME shared tracking issue - the
        // panel is per assignment and must not borrow it.
        refusal('otto', 'rejected:past-deadline', 'lab-4'),
      ],
    });

    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText('4 students were turned away');
    await expect(panel(page)).toContainText('not in this assignment');
    await expect(panel(page)).toContainText('@cara, @dries');
    await expect(panel(page)).toContainText('not on the roster');
    await expect(panel(page)).toContainText('the acceptance cap was full');
    // A lecturer is not shown a slug.
    await expect(panel(page)).not.toContainText('rejected:');
    // And not somebody else's assignment.
    await expect(panel(page)).not.toContainText('@otto');
  });

  test('most refusals are the assignment working, and it says so', async ({ page }) => {
    // The whole point. Without this line a panel counting refusals reads as an
    // error report, and a lecturer starts undoing a cohort that is correct.
    await detail(page, { trackingIssue: ISSUE, trackingComments: [refusal('cara', 'rejected:not-in-cohort')] });

    await expect(panel(page)).toContainText('1 student was turned away');
    await expect(panel(page)).toContainText('working as configured');
    await expect(panel(page).getByRole('link', { name: 'Full history' })).toHaveAttribute(
      'href',
      ISSUE.html_url,
    );
  });

  test('nobody turned away shows nothing at all', async ({ page }) => {
    // An empty panel on every assignment forever is a chore that is never
    // finished, and it would make the presence of the panel meaningless.
    await detail(page, { trackingIssue: ISSUE, trackingComments: [] });
    await expect(panel(page)).toHaveCount(0);
  });

  test('an org that has never been notified is not an error', async ({ page }) => {
    // No tracking issue is a real answer - nothing has happened - and must not
    // read as a failed lookup.
    await detail(page, { trackingIssue: null });
    await expect(panel(page)).toHaveCount(0);
  });

  test('a failed read says so, and never reads as nobody', async ({ page }) => {
    // UNREADABLE IS NOT EVIDENCE. A silent zero here is the same mistake as a
    // green check over a grading run nobody could read: it tells a lecturer
    // their link is fine when the truth is unknown.
    await detail(page, { trackingIssue: 'UNREADABLE' });

    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText("Couldn't check for refused acceptances");
    await expect(panel(page)).toContainText('it is unknown');
    // No COUNT, which is the claim that would be false. The copy does quote the
    // phrase "nobody was turned away" in order to deny it, so the assertion is
    // on the assertion, not on the words.
    await expect(panel(page)).not.toContainText(/\d+ students? (was|were) turned away/);
  });

  test('a failed comment walk is unreadable too, not a partial answer', async ({ page }) => {
    await detail(page, { trackingIssue: ISSUE, trackingComments: 'UNREADABLE' });
    await expect(panel(page)).toContainText("Couldn't check");
  });

  test('the panel is in the page, not over it', async ({ page }) => {
    // The help drawer is position: fixed and owns the overlay layer. A second
    // panel there is tests/e2e/47's failure - a dialog rendered scrollY pixels
    // off-screen because something above it was a containing block.
    await detail(page, { trackingIssue: ISSUE, trackingComments: [refusal('cara', 'rejected:not-in-cohort')] });

    const position = await panel(page).evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe('static');

    // And it sits inside the report, not floating over the table.
    const box = await panel(page).boundingBox();
    const footer = await page.locator('.table-footer').boundingBox();
    expect(box.y).toBeGreaterThan(footer.y);
  });

  test('a report that fails to load does not take the panel with it, or vice versa', async ({ page }) => {
    // Its failures stay inside it: whether anybody was refused is worth knowing
    // and worth nothing at the cost of the cohort table.
    await detail(page, { trackingIssue: 'UNREADABLE', trackingComments: 'UNREADABLE' });
    await expect(page.locator('.table-footer')).toBeVisible();
    await expect(panel(page)).toContainText("Couldn't check");
  });
});
