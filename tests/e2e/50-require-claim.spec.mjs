// 50 - Open enrolment that still knows who accepted.
//
// `open` collects nothing: no roster gate, no address, and afterwards a
// lecturer has a list of GitHub usernames and no way to match them to students.
// ARCHITECTURE said they would "reconcile github_login -> student afterward",
// which was a hope rather than a mechanism - nothing had been recorded to
// reconcile against.
//
// `require_claim` is that mechanism. The form ticks it for a new assignment
// (2026-10-02); an assignment document without the field still asks nothing,
// which is what every open assignment before then relies on.
//
// What it does NOT do is gate: anyone with the link still accepts. It records
// who, so the reconciliation is possible.

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { test, expect } from '@playwright/test';

// The checkbox is found by its label, and the label names the institution from
// deployment.yml - so this reads it rather than spelling it. Written out, this
// locator stopped matching the moment the copy stopped saying "institutional",
// and it would fail for a fork whose own label is perfectly correct.
const INSTITUTION_SHORT = parse(
  readFileSync(new URL('../../deployment.yml', import.meta.url), 'utf8'),
).institution_short;
const ASK_LABEL = `confirm their ${INSTITUTION_SHORT} email address`;
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
  page.locator('fieldset', { has: page.locator('legend', { hasText: 'Students' }) });

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
    await page.goto(`/dashboard/${ORG}/new`);
    await expect(guardrails(page)).toBeVisible({ timeout: 15000 });
  }

  // An ANSWER since 2026-10-02 - "When accepting, students: confirm their ...
  // email address / just click Accept" - where it was a checkbox.
  const ask = (page) => guardrails(page).getByRole('radio', { name: ASK_LABEL });
  const justClick = (page) => guardrails(page).getByRole('radio', { name: 'just click Accept' });

  test('an open assignment asks for the address by default', async ({ page }) => {
    // A new assignment defaults to open, so this is the state it opens in. On
    // since 2026-10-02: a username alone is what nobody can reconcile later.
    await newAssignment(page);

    await expect(ask(page)).toBeChecked();
    await expect(guardrails(page)).toContainText('it turns nobody away');

    // The other answer is the anonymous assignment, and says what it costs.
    await justClick(page).check();
    await expect(guardrails(page)).toContainText('You will only know their GitHub username');
  });

  test('choosing it says what it does and does not do', async ({ page }) => {
    // Specifically that it is NOT a gate - the mode is still open, and a
    // lecturer must not read this as "only my students can accept now".
    await newAssignment(page);
    await justClick(page).check();
    await ask(page).check();

    // The line under the question, which is the one a lecturer reads without
    // asking for help.
    await expect(guardrails(page)).toContainText('Anyone with the link can accept after confirming');
    await expect(guardrails(page)).toContainText('it turns nobody away');

    // The detail moved into the drawer on 2026-09-04 - four lines under a
    // checkbox was three too many - so that is where the rest has to be, or it
    // has simply been deleted.
    await page.getByRole('button', { name: /What does confirming an email address mean/ }).click();
    const drawer = page.locator('.help-drawer');
    await expect(drawer).toContainText('confirms an address before they can accept');
    await expect(drawer).toContainText('does not restrict who may accept');
    // The topic covers BOTH ways an address is collected now. This answer is
    // the acceptance-time one; the standalone link is the other, and a lecturer
    // opening this drawer should meet it rather than discover it by accident.
    await expect(drawer).toContainText('Confirm-email link');
  });

  test('under the roster, the same question chooses what the roster is matched on', async ({ page }) => {
    // It used to vanish under `enforced` and `claim`, because there the
    // checkbox meant nothing. As a question it means something in all four
    // corners: on the roster it is the difference between `claim` (match the
    // confirmed address) and `enforced` (match the GitHub username).
    await newAssignment(page);
    await guardrails(page).getByLabel('Only students on the roster').check();

    await ask(page).check();
    await expect(guardrails(page)).toContainText("roster's Email column");
    await justClick(page).check();
    await expect(guardrails(page)).toContainText("roster's GitHub Account column");
  });
});
