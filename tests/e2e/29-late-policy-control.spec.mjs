// 29 - The late-work control (ARCHITECTURE §11.2.1)
//
// `late_policy: block` said "refuse late pushes" and no code read the field;
// `lock_down_enabled` said "demote admin -> pull at the deadline" and no code
// read that either - lockdown demoted everyone regardless. Two controls, neither
// wired, and `block` shipped as the form's default. DESIGN.md §1.5: the UI must not
// describe behaviour the system does not have.
//
// Both are wired now, so these run against the real component: what the form
// starts at, and what choosing each option actually sets.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

async function openNewAssignmentForm(page) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
  await page.goto(`/dashboard/${ORG}/admin`);
  await expect(page.locator('.app-header-crumbs .app-header-heading')).toBeVisible({ timeout: 10000 });
  await page.locator('.new-btn').click();
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
}

const counts = (page) => page.locator('input[type="radio"][value="report"]');
const doesNotCount = (page) => page.locator('input[type="radio"][value="block"]');
// TWO QUESTIONS, TWO RADIO GROUPS. This was a checkbox beginning "Also", which
// made the heaviest thing this system does to a student read as a modifier of a
// grading setting - and the two fields are a 2x2, not two rungs of one ladder:
// `late_policy` decides what COUNTS as the submission (lockdown.mjs passes
// `deadlineFor` to phase 2 only under `block`), `lock_down_enabled` decides
// ACCESS, and `report` + demotion is meaningful and is what both 2026 exams ran
// on. Same fields, same four combinations, asked as what they are.
const repoField = (page) =>
  page.locator('.field', { has: page.locator('label', { hasText: "The student's repository" }) });
const staysAsIs = (page) => repoField(page).locator('input[type="radio"]').first();
const becomesReadOnly = (page) => repoField(page).locator('input[type="radio"]').last();

test.describe('29 - Late work control', () => {
  test('A new assignment does not discard late work by default', async ({ page }) => {
    // `block` throws away commits. Now that it does something, defaulting to it
    // would start silently discarding students' work on every new assignment.
    await openNewAssignmentForm(page);
    await expect(counts(page)).toBeChecked();
    await expect(doesNotCount(page)).not.toBeChecked();
  });

  test('The control lives in Guardrails, not behind the Advanced disclosure', async ({ page }) => {
    await openNewAssignmentForm(page);
    const guardrails = page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) });
    await expect(guardrails.locator('input[type="radio"][value="block"]')).toBeVisible();
    // Visible without opening <details>: it is a policy decision, not a knob.
    await expect(doesNotCount(page)).toBeVisible();
  });

  test('Choosing "Does not count" explains what it actually does, including the fallback', async ({ page }) => {
    await openNewAssignmentForm(page);
    await doesNotCount(page).check();

    const guardrails = page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) });
    // The promise: pushes stop, everything else survives.
    await expect(guardrails).toContainText('only pushing is blocked');
    // The caveat, in the UI rather than only in the code, and it is three
    // separate facts: WHEN the lock lands, what happens to work pushed before
    // it does, and how much the timestamp behind that is worth. They used to be
    // one run-on sentence that a lecturer could not parse (2026-09-02), so the
    // assertions are per fact rather than on one phrase.
    await expect(guardrails).toContainText('applied by the nightly run');
    await expect(guardrails).toContainText('Work pushed in that gap does not count');
    await expect(guardrails).toContainText('not proof');
  });

  test('A new assignment does not take admin away by default', async ({ page }) => {
    // Demoting to `pull` removes Actions, secrets, environments and runners -
    // the subject being taught. It used to be the default, so every new
    // assignment confiscated it at the deadline unless the lecturer noticed the
    // checkbox. Preservation does not depend on it.
    await openNewAssignmentForm(page);
    await expect(staysAsIs(page)).toBeChecked();
    await expect(becomesReadOnly(page)).not.toBeChecked();
  });

  test('The two questions are asked as two questions, not as one and a footnote', async ({ page }) => {
    // The whole point of the reframing. `late_policy` is about what COUNTS,
    // `lock_down_enabled` about ACCESS, and the second used to begin "Also",
    // which read as an intensifier of the first. Both 2026 exams landed on the
    // diagonal that wording made easy to pick by accident.
    await openNewAssignmentForm(page);
    const guardrails = page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) });
    await expect(guardrails).toContainText('After the deadline, work a student pushes');
    await expect(guardrails).toContainText("The student's repository");
    await expect(guardrails).not.toContainText('Also take admin away');
    // Same shape for both, so neither is the other's afterthought.
    await expect(repoField(page).locator('.policy-option')).toHaveCount(2);
  });

  test('Blocking pushes resets the repository answer, because it takes what the lock preserves', async ({ page }) => {
    await openNewAssignmentForm(page);
    await becomesReadOnly(page).check();

    await doesNotCount(page).check();
    await expect(staysAsIs(page)).toBeChecked();

    // The note belongs to the deliberate re-choice, not to the reset: once
    // pushing is blocked, read-only takes exactly what the block preserves, so
    // it is said at the moment somebody picks it anyway.
    const guardrails = page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) });
    await expect(guardrails).not.toContainText('Choose this only if they should lose those too');
    await becomesReadOnly(page).check();
    await expect(guardrails).toContainText('Choose this only if they should lose those too');
  });

  test('Choosing read-only again is a deliberate choice and sticks', async ({ page }) => {
    await openNewAssignmentForm(page);
    await doesNotCount(page).check();
    await becomesReadOnly(page).check();

    // Editing anything else must not quietly undo it.
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Exam 2026');
    await expect(becomesReadOnly(page)).toBeChecked();
    await expect(doesNotCount(page)).toBeChecked();
  });

  test('The odd diagonal says what it actually does', async ({ page }) => {
    // `still counts` + read-only is NOT incoherent - it means they lose the
    // toolchain at the deadline while work pushed before the nightly ran still
    // counts. It is what both 2026 exams ran on, and it surprised the lecturer,
    // so the form says it where they have just chosen it.
    await openNewAssignmentForm(page);
    await counts(page).check();
    await becomesReadOnly(page).check();
    const guardrails = page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) });
    await expect(guardrails).toContainText('still counts');
    await expect(guardrails).toContainText('two different answers');
  });

  test('Going back to "still counts" leaves the repository answer where the lecturer left it', async ({ page }) => {
    await openNewAssignmentForm(page);
    await becomesReadOnly(page).check();
    await doesNotCount(page).check();
    await expect(staysAsIs(page)).toBeChecked();
    await counts(page).check();
    await expect(staysAsIs(page)).toBeChecked();
  });
});
