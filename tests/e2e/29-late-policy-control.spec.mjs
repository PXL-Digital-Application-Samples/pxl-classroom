// 29 - What happens after the deadline (ARCHITECTURE §11.2.1, DESIGN.md §1.9)
//
// Two stored fields: `late_policy` (block locks the submission branch and makes
// the last commit before the deadline the submission) and `lock_down_enabled`
// (demote the student, taking Actions, secrets, environments and runners).
// They were asked as two questions, and a lecturer could not tell which decided
// grading and which access - because `block` does some of each.
//
// Since 2026-10-02 they are ONE question whose answers say what happens, each
// answer writing both fields. The fourth combination, read-only while late work
// still counts, is what both 2026 exams ran on: it is not offered for a new
// assignment, and an assignment that holds it shows it as a fourth answer, so
// loading one changes nothing and saving it untouched keeps it.

import { test, expect } from '@playwright/test';
import { parse } from 'yaml';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const field = (page) =>
  page.locator('.field', { has: page.locator('label', { hasText: 'After the deadline' }) });
const answer = (page, value) => field(page).locator(`input[type="radio"][value="${value}"]`);

async function openNewAssignmentForm(page) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
  await page.goto(`/dashboard/${ORG}/new`);
  await expect(page.locator('.app-header-crumbs .app-header-heading')).toBeVisible({ timeout: 10000 });
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
}

const ID = 'exam-2026';
const draft = (over = {}) => ({
  id: ID,
  title: 'Exam 2026',
  organization: ORG,
  state: 'draft',
  assignment_type: 'individual',
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: '2026-01-01T08:00:00.000Z',
  deadline_at: '2027-01-01T16:00:00.000Z',
  roster_mode: 'open',
  max_acceptances: 50,
  ...over,
});

/** Open a stored draft in the editor; returns the list contents writes land in. */
async function openDraft(page, over) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: draft(over) },
    contentWrites,
  });
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(field(page)).toBeVisible({ timeout: 15000 });
  return contentWrites;
}

async function savedDoc(page, contentWrites) {
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect.poll(
    () => contentWrites.find((w) => w.path === `assignments/${ID}.yml`),
    { timeout: 15000 },
  ).toBeTruthy();
  return parse(contentWrites.findLast((w) => w.path === `assignments/${ID}.yml`).content);
}

test.describe('29 - After the deadline', () => {
  test('a new assignment stops pushes by default and leaves the toolchain alone', async ({ page }) => {
    await openNewAssignmentForm(page);
    await expect(answer(page, 'stop-pushes')).toBeChecked();
  });

  test('a new assignment is offered three answers, and not the fourth', async ({ page }) => {
    await openNewAssignmentForm(page);
    await expect(field(page).locator('.policy-option strong')).toHaveText([
      'Pushing stops',
      'Nothing is locked',
      'The repository becomes read-only',
    ]);
    await expect(answer(page, 'legacy')).toHaveCount(0);
  });

  test('it is one question, visible without opening Advanced', async ({ page }) => {
    await openNewAssignmentForm(page);
    await expect(answer(page, 'stop-pushes')).toBeVisible();
    // The two questions it replaced are gone, not hidden.
    await expect(page.getByText('After the deadline, work a student pushes')).toHaveCount(0);
    await expect(page.getByText("The student's repository", { exact: true })).toHaveCount(0);
  });

  test('when the lock lands is said where a lock is chosen, and not where none is', async ({ page }) => {
    await openNewAssignmentForm(page);
    // The deadline sentinel locks at the instant; the nightly is the fallback.
    await expect(field(page)).toContainText('The lock lands at the deadline');
    await expect(field(page)).toContainText('not proof');
    await expect(field(page)).not.toContainText('applied by the nightly run');

    await answer(page, 'nothing').check();
    await expect(field(page)).not.toContainText('The lock lands at the deadline');
  });

  for (const [value, late_policy, lock_down_enabled] of [
    ['nothing', 'report', false],
    ['stop-pushes', 'block', false],
    ['read-only', 'block', true],
  ]) {
    test(`"${value}" writes both fields: ${late_policy} + ${lock_down_enabled}`, async ({ page }) => {
      // Start from the opposite corner, so a field left behind would show.
      const writes = await openDraft(page, { late_policy: 'report', lock_down_enabled: true });
      await answer(page, value).check();
      const doc = await savedDoc(page, writes);
      expect(doc.late_policy).toBe(late_policy);
      expect(doc.lock_down_enabled).toBe(lock_down_enabled);
    });
  }

  test('an assignment holding the fourth combination shows it, chosen, and keeps it on save', async ({ page }) => {
    // `lock_down_enabled` absent means true (lockdown.mjs), so this is every
    // older `report` assignment - and both 2026 exams.
    const writes = await openDraft(page, { late_policy: 'report' });
    await expect(answer(page, 'legacy')).toBeChecked();
    await expect(field(page)).toContainText('Read-only, but late work still counts');

    const doc = await savedDoc(page, writes);
    expect(doc.late_policy).toBe('report');
    expect(doc.lock_down_enabled).toBe(true);
  });

  test('moving off the fourth answer before saving can still come back to it', async ({ page }) => {
    await openDraft(page, { late_policy: 'report', lock_down_enabled: true });
    await answer(page, 'stop-pushes').check();
    await expect(answer(page, 'legacy')).toBeVisible();
    await answer(page, 'legacy').check();
    await expect(answer(page, 'legacy')).toBeChecked();
  });

  test('each stored combination opens on its own answer', async ({ page }) => {
    await openDraft(page, { late_policy: 'block', lock_down_enabled: true });
    await expect(answer(page, 'read-only')).toBeChecked();
    await expect(answer(page, 'legacy'), 'not an assignment that holds it').toHaveCount(0);
  });
});
