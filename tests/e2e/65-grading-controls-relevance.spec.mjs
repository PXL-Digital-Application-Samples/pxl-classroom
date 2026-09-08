// 65 - A grading control only appears where there is grading
//
// The Autograding controls READ a check run. On an assignment that grades
// nothing there is no check run to read, so pressing one could only ever
// report a failure per student - and it was offered on every such assignment.
// The gate was `!localRunnerDeclared`, a double negative asked of a tri-state:
// true whenever autograding was ABSENT.
//
// The cause was in the document. AutogradeModal wrote the same thing for "the
// checks come with my template" and for "remove all", so the lecturer's own
// answer was discarded at save and every surface downstream had to guess.
// `template_grades` records it, and `frontend/src/lib/autograde.js` decides.
//
// Driven through the real detail view, because the unit tests can only prove
// the decision - not that the control is wired to it.
import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'relevance-lab';

const report = {
  schema_version: 1,
  assignment_id: ID,
  generated_at: new Date().toISOString(),
  students: [
    {
      github_login: 'student-one',
      acceptance_state: 'provisioned',
      repo_name: `${ORG}/${ID}-student-one`,
      submission_status: 'on-time',
      preservation_status: 'preserved',
      preserved_sha: 'a'.repeat(40),
    },
  ],
};

const base = {
  id: ID,
  title: 'Relevance Lab',
  organization: ORG,
  assignment_type: 'individual',
  roster_mode: 'open',
  state: 'published',
  max_acceptances: 30,
  deadline_at: new Date(Date.now() - 86400_000).toISOString(),
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: new Date(Date.now() - 8 * 86400_000).toISOString(),
};

async function openDetail(page, assignment) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    assignments: { [ID]: assignment },
    reports: { [ID]: report },
    currentUser: LECTURER,
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  // Wait on a control that is on this view whatever the answer is, so a
  // missing grading control is a real absence rather than a page that had not
  // finished loading - which is the difference between this spec proving
  // something and passing vacuously.
  await expect(page.getByRole('button', { name: /Export/i })).toBeVisible();
}

/**
 * The MORE menu, by the label it actually carries. `/Actions/i` matched the
 * per-student row buttons (`aria-label="Actions for <login>"`) instead, so the
 * absence assertions below passed over a menu that had never opened - a
 * vacuous green, which is the failure mode a test like this one has.
 */
async function openMoreMenu(page) {
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.locator('.export-dropdown-menu')).toBeVisible();
}

/** Every control that reads a grading run, by the label a lecturer sees. */
const CI_CONTROL = /Read scores from GitHub Actions/;

test.describe('65 - grading controls appear only where there is grading', () => {
  test('AN ASSIGNMENT THAT GRADES NOTHING OFFERS NO WAY TO READ A SCORE', async ({ page }) => {
    await openDetail(page, { ...base, template_grades: false });

    await openMoreMenu(page);
    await expect(page.locator('.export-dropdown-item', { hasText: CI_CONTROL })).toHaveCount(0);
    // ...and no Autograding panel behind it either.
    await expect(page.locator('.autograde-section')).toHaveCount(0);
  });

  test('an assignment the template grades offers it', async ({ page }) => {
    // The common case: MANUAL.md says most templates grade themselves, and the
    // document says so now instead of being indistinguishable from the case
    // above.
    await openDetail(page, { ...base, template_grades: true });

    await openMoreMenu(page);
    await expect(page.locator('.export-dropdown-item', { hasText: CI_CONTROL })).toHaveCount(1);
  });

  test('checks the LECTURER runs offer the CLI command and never the CI read', async ({ page }) => {
    // Two controls, opposite answers, same assignment - which is what makes
    // this worth an end-to-end test rather than another unit one.
    await openDetail(page, {
      ...base,
      autograde: {
        enabled: true,
        execution_environment: 'lecturer_local',
        tests: [{ id: 'one', type: 'run', points: 5, run: 'make test' }],
      },
    });

    const exportBtn = page.getByRole('button', { name: /Export/i });
    await exportBtn.click();
    await expect(
      page.locator('.export-dropdown-item', { hasText: 'Copy CLI Grade' }),
    ).toHaveCount(1);
    await page.keyboard.press('Escape');

    await openMoreMenu(page);
    await expect(page.locator('.export-dropdown-item', { hasText: CI_CONTROL })).toHaveCount(0);
  });

  test('an assignment saved before the answer existed is decided by evidence', async ({ page }) => {
    // No `template_grades` at all - every assignment that predates the field.
    // A hand-in message names the commit whose GRADING RUN to read, so setting
    // one is a statement that this assignment grades.
    await openDetail(page, {
      ...base,
      // The shape lib/submission-marker.mjs actually accepts - `commit_message`,
      // not a `message` this spec invented. An unknown type reads as NO marker,
      // so the wrong fixture would have tested the opposite of the intent.
      submission_marker: { type: 'commit_message', value: 'hand-in', multiple: true },
    });

    await openMoreMenu(page);
    await expect(page.locator('.export-dropdown-item', { hasText: CI_CONTROL })).toHaveCount(1);
  });

  test('an old assignment with no evidence at all stays quiet', async ({ page }) => {
    await openDetail(page, { ...base });

    await openMoreMenu(page);
    await expect(page.locator('.export-dropdown-item', { hasText: CI_CONTROL })).toHaveCount(0);
  });
});

test.describe('65 - re-grading one student', () => {
  const openRowActions = async (page) => {
    await page.getByRole('button', { name: /Actions for student-one/i }).click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
  };

  test('THE ROW OFFERS A RE-GRADE, so chasing one student is not re-grading forty', async ({ page }) => {
    await openDetail(page, { ...base, template_grades: true });
    await openRowActions(page);
    await expect(page.getByRole('button', { name: 'Re-grade this student' })).toBeVisible();
    // And it says which commit the score will come from, so the lecturer is not
    // guessing what they are about to read.
    await expect(page.locator('.modal-overlay')).toContainText(/commit aaaaaaa/);
  });

  test('and does not, on an assignment that grades nothing', async ({ page }) => {
    await openDetail(page, { ...base, template_grades: false });
    await openRowActions(page);
    await expect(page.getByRole('button', { name: 'Re-grade this student' })).toHaveCount(0);
    // Not a disabled control with an explanation either: there is no grading
    // here at all, so the section is absent rather than "not yet".
    await expect(page.locator('.modal-overlay')).not.toContainText('Re-grade');
  });

  test('a student with no repository is told why, not offered a button', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [ID]: { ...base, template_grades: true } },
      reports: {
        [ID]: {
          ...report,
          students: [{ github_login: 'student-one', acceptance_state: 'accepted' }],
        },
      },
      currentUser: LECTURER,
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(page.getByRole('button', { name: /Export/i })).toBeVisible();
    await openRowActions(page);
    await expect(page.getByRole('button', { name: 'Re-grade this student' })).toHaveCount(0);
    await expect(page.locator('.modal-overlay')).toContainText(/no repository yet/i);
  });
});
