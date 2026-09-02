// 52 - The roster tab is where linking happens.
//
// The pair was half missing: the UI could Unlink a binding and never make one.
// Verified claims fold themselves into the roster overnight now, so the common
// case needs no action at all - but the three the nightly refuses to decide
// (typed-not-verified, a claim naming a different account than the row holds,
// and an address two accounts claim) existed only in a workflow log, which is
// not where a lecturer looks.
//
// And "add the students who accepted" writes THIS file, so it is offered here
// as well as from the assignment that prompts it. It is per-assignment while
// the roster is org-wide, so it asks which first rather than guessing.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ROSTER = [
  // Already linked - nothing to decide, and must NOT appear in the review list.
  { student_number: '0001', full_name: 'Alice Example', email: 'alice@student.pxl.be', github_login: 'alice-gh', active: true },
  // Typed, not verified: the one a lecturer can settle with a single click.
  { student_number: '0002', full_name: 'Bram Example', email: 'bram@student.pxl.be', active: true },
  // The roster already names someone else - something has to give first.
  { student_number: '0003', full_name: 'Cara Example', email: 'cara@student.pxl.be', github_login: 'cara-old', active: true },
];

const CLAIMS = [
  { schema_version: 1, github_login: 'alice-gh', github_id: 111, email: 'alice@student.pxl.be', claim_verified: true, domain_allowed: true, claimed_at: '2026-09-01T10:00:00.000Z' },
  { schema_version: 1, github_login: 'bram-typed', github_id: 222, email: 'bram@student.pxl.be', claim_verified: false, domain_allowed: true, claimed_at: '2026-09-01T10:00:00.000Z' },
  { schema_version: 1, github_login: 'cara-new', github_id: 333, email: 'cara@student.pxl.be', claim_verified: true, domain_allowed: true, claimed_at: '2026-09-01T10:00:00.000Z' },
];

const openAssignment = {
  schema_version: 1,
  id: 'open-exam',
  title: 'Open Exam',
  organization: ORG,
  state: 'published',
  roster_mode: 'open',
  assignment_type: 'individual',
  max_acceptances: 50,
  repository_name_pattern: 'open-exam-{github_login}',
  opens_at: '2026-08-01T08:00:00Z',
  deadline_at: '2026-12-30T20:00:00Z',
};

async function rosterTab(page, { assignments = {} } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments,
    roster: ROSTER,
    claims: CLAIMS,
  });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();
  await expect(page.locator('.roster-table').first()).toBeVisible({ timeout: 15000 });
}

test.describe('52 - what the nightly could not decide', () => {
  test('the held claims are listed, each with the decision it is waiting for', async ({ page }) => {
    await rosterTab(page);

    const review = page.locator('.claim-review');
    await expect(review).toBeVisible();
    await expect(review).toContainText('need');
    await expect(review).toContainText('everything else linked automatically');

    // Two, not three: Alice is already linked and is nobody's decision.
    await expect(page.locator('.claim-review-row')).toHaveCount(2);
    await expect(review).toContainText('bram@student.pxl.be');
    await expect(review).toContainText('typed by the student, not verified by GitHub');
    await expect(review).toContainText('cara@student.pxl.be');
    await expect(review).toContainText('the roster already names @cara-old');
    await expect(review).not.toContainText('alice@student.pxl.be');
  });

  test('Link anyway is offered only where one click can settle it', async ({ page }) => {
    // A conflict needs the account in the way removed first. Offering a button
    // that would refuse is worse than offering none (DESIGN.md §1.5).
    await rosterTab(page);

    const bram = page.locator('.claim-review-row', { hasText: 'bram@student.pxl.be' });
    await expect(bram.getByRole('button', { name: /Link anyway/ })).toBeVisible();

    const cara = page.locator('.claim-review-row', { hasText: 'cara@student.pxl.be' });
    await expect(cara.getByRole('button', { name: /Link anyway/ })).toHaveCount(0);
    await expect(cara).toContainText('Unlink below to resolve');
  });

  test('nothing to decide means no review box at all', async ({ page }) => {
    // An empty review panel is a chore that is never finished.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
      roster: [ROSTER[0]],
      claims: [CLAIMS[0]],
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();

    await expect(page.locator('.roster-table').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.claim-review')).toHaveCount(0);
  });
});

test.describe('52 - adding the students who accepted', () => {
  test('the roster tab asks which assignment first', async ({ page }) => {
    await rosterTab(page, { assignments: { 'open-exam': openAssignment } });

    await page.getByRole('button', { name: 'Add students who accepted' }).click();
    const picker = page.locator('.promote-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('From which assignment?');
    await expect(picker).toContainText('Open Exam');
  });

  test('it is absent when there is no open assignment to add from', async ({ page }) => {
    // Under `enforced` and `claim` everyone who accepted was already on the
    // roster, so there is nobody to add and the control would do nothing.
    await rosterTab(page, {
      assignments: { 'gated': { ...openAssignment, id: 'gated', roster_mode: 'enforced' } },
    });

    await expect(page.getByRole('button', { name: 'Add students who accepted' })).toHaveCount(0);
  });
});
