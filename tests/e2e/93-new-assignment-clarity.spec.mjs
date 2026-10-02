// 93 - The new-assignment form says what it needs and shows what it derived.
//
// Reviewed as a whole on 2026-10-02. Each test is one place the form made a
// lecturer guess: Save greyed out with no reason, a derived repository name
// asked for in a box, a UTC timestamp under every date, the institution's
// address rule sitting among the everyday choices, and a slug that a route
// would shadow.

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

const blockers = (page) => page.locator('.save-blockers');

test.describe('93 - What the new-assignment form says', () => {
  test('a disabled Save names what is still needed', async ({ page }) => {
    await openNewAssignmentForm(page);
    await expect(page.getByRole('button', { name: 'Save as draft' })).toBeDisabled();
    await expect(blockers(page)).toContainText('Still needed:');
    await expect(blockers(page)).toContainText('template');
    await expect(blockers(page)).toContainText('title');

    // Typing the title takes it off the list - the line follows the form.
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Linux Processes 2026');
    await expect(blockers(page)).not.toContainText('title');
    await expect(blockers(page)).toContainText('template');
  });

  test('the repository name is shown as what it is, and opens for editing on request', async ({ page }) => {
    await openNewAssignmentForm(page);
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Linux Processes 2026');
    const line = page.locator('[data-derived="pattern"]');
    await expect(line.locator('code')).toHaveText('linux-processes-2026-{github_login}');
    await expect(page.getByPlaceholder('linux-processes-{github_login}')).toHaveCount(0);

    await line.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByPlaceholder('linux-processes-{github_login}')).toHaveValue('linux-processes-2026-{github_login}');
  });

  test('a repository name with something wrong opens the box, and keeps it open once fixed', async ({ page }) => {
    await openNewAssignmentForm(page);
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Lab');
    await page.locator('[data-derived="pattern"]').getByRole('button', { name: 'Edit' }).click();
    const box = page.getByPlaceholder('linux-processes-{github_login}');
    await box.fill('lab-without-placeholder');
    await expect(page.locator('.field-error-msg').first()).toBeVisible();
    await box.fill('lab-{github_login}');
    await expect(box, 'fixing it must not swap the box away under the cursor').toBeVisible();
  });

  test('the dates say which clock they are in, not what UTC they are stored as', async ({ page }) => {
    await openNewAssignmentForm(page);
    const schedule = page.locator('fieldset', { has: page.locator('legend', { hasText: 'Schedule' }) });
    await expect(schedule).toContainText("In your computer's time");
    await expect(schedule).not.toContainText('Stored as');
  });

  test('the address-format rule lives under Advanced', async ({ page }) => {
    await openNewAssignmentForm(page);
    const rule = page.locator('label', { hasText: /Only accept the .* form of the address/ });
    // Confirm-email is on by default, so the rule applies - and it is inside
    // the Advanced disclosure, not among the everyday choices.
    await expect(page.locator('details.advanced').locator('label', { hasText: /Only accept the .* form/ })).toHaveCount(1);
    await expect(rule).toBeHidden();
    await page.locator('details.advanced > summary').click();
    await expect(rule).toBeVisible();
  });

  test('"roster" is reserved, like "admin" and "usage", because it is a route', async ({ page }) => {
    await openNewAssignmentForm(page);
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Roster');
    await expect(blockers(page)).toContainText('slug');
  });
});
