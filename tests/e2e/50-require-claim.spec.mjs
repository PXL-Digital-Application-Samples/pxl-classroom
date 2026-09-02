// 50 - Open enrolment that still knows who accepted.
//
// `open` collects nothing: no roster gate, no address, and afterwards a
// lecturer has a list of GitHub usernames and no way to match them to students.
// ARCHITECTURE said they would "reconcile github_login -> student afterward",
// which was a hope rather than a mechanism - nothing had been recorded to
// reconcile against.
//
// `require_claim` is that mechanism, and it is OFF by default on purpose. Open
// is the mode for a cohort nobody listed up front, most often an exam, and
// making one identify itself by accident is the opposite of the point.
//
// What it does NOT do is gate: anyone with the link still accepts. It records
// who, so the reconciliation is possible.

import { test, expect } from '@playwright/test';
import {
  ORG,
  STUDENT_1,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteUrl,
  inviteToken,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'open-exam-2026';

const openAssignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'Open Exam 2026',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
  repository_name_pattern: `${ID}-{github_login}`,
  broker_repo: `broker-${ID}`,
  invite_key: inviteToken(ORG, ID),
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  ...over,
});

async function student(page, assignment) {
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: { [ID]: assignment },
  });
  await page.route('**/api.github.com/user/emails*', async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify([{ email: 'student1@student.pxl.be', verified: true, primary: true }]),
    });
  });
  await page.goto(inviteUrl(ORG, ID));
}

const guardrails = (page) =>
  page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) });

test.describe('50 - the student side', () => {
  test('open enrolment asks for nothing by default', async ({ page }) => {
    // The behaviour every existing open assignment has, and must keep. An exam
    // cohort is not made to identify itself because a field was added.
    await student(page, openAssignment());

    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeEnabled({ timeout: 15000 });
    await expect(page.getByText('student1@student.pxl.be')).toHaveCount(0);
  });

  test('with require_claim the address is asked for, and offered from GitHub', async ({ page }) => {
    await student(page, openAssignment({ require_claim: true }));

    // The page offers what GitHub has already verified rather than asking the
    // student to type - a typed address is recorded `unverified`, and the point
    // here is evidence.
    await expect(page.getByText('student1@student.pxl.be')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('50 - the lecturer side', () => {
  async function newAssignment(page) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('button', { hasText: 'New assignment' }).first().click();
    await expect(guardrails(page)).toBeVisible({ timeout: 15000 });
  }

  const askBox = (page) =>
    guardrails(page).locator('label', { hasText: 'Ask students to confirm their institutional email address' });

  test('the option is offered on an open assignment, and starts off', async ({ page }) => {
    // A new assignment defaults to open, so this is the state it opens in.
    await newAssignment(page);

    await expect(askBox(page)).toBeVisible();
    await expect(askBox(page).locator('input[type="checkbox"]')).not.toBeChecked();
    await expect(guardrails(page)).toContainText('accepts anonymously');
  });

  test('ticking it says what it does and does not do', async ({ page }) => {
    // Specifically that it is NOT a gate - the mode is still open, and a
    // lecturer must not read this as "only my students can accept now".
    await newAssignment(page);
    await askBox(page).locator('input[type="checkbox"]').check();

    await expect(guardrails(page)).toContainText('must confirm an address before they can accept');
    await expect(guardrails(page)).toContainText('does not restrict who may accept');
  });

  test('the option is absent when it would mean nothing', async ({ page }) => {
    // Under `claim` an address is already required; under `enforced` none is
    // collected at all. A control that changes nothing is DESIGN.md §1.5.
    await newAssignment(page);

    for (const mode of ['enforced', 'claim']) {
      await guardrails(page).locator('select').first().selectOption(mode);
      await expect(askBox(page)).toHaveCount(0, { timeout: 5000 });
    }
  });
});
