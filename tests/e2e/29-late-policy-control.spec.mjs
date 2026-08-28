// 29 - The late-work control (ARCHITECTURE §11.2.1.7)
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
const demoteBox = (page) =>
  page.locator('label', { hasText: 'Also take admin away at the deadline' }).locator('input[type="checkbox"]');

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
    await expect(guardrails).toContainText('Students keep their repository, their Actions, their secrets');
    // The caveat, in the UI rather than only in the code: the lock fires on the
    // nightly, so anything in between is filtered by a client-supplied date.
    await expect(guardrails).toContainText('first nightly run after the deadline');
    await expect(guardrails).toContainText('rather than as proof');
  });

  test('Locking the branch unticks the demotion, because it takes what the lock preserves', async ({ page }) => {
    await openNewAssignmentForm(page);
    await expect(demoteBox(page)).toBeChecked();

    await doesNotCount(page).check();
    await expect(demoteBox(page)).not.toBeChecked();
    await expect(page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) }))
      .toContainText('Tick this only if they should lose those too');
  });

  test('Ticking the demotion back on is a deliberate choice and sticks', async ({ page }) => {
    await openNewAssignmentForm(page);
    await doesNotCount(page).check();
    await demoteBox(page).check();

    // Editing anything else must not quietly undo it.
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Exam 2026');
    await expect(demoteBox(page)).toBeChecked();
    await expect(doesNotCount(page)).toBeChecked();
  });

  test('Going back to "Counts" leaves the demotion where the lecturer left it', async ({ page }) => {
    await openNewAssignmentForm(page);
    await doesNotCount(page).check();
    await expect(demoteBox(page)).not.toBeChecked();
    await counts(page).check();
    await expect(demoteBox(page)).not.toBeChecked();
    await expect(page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) }))
      .toContainText('Untick to leave their repositories open');
  });
});
