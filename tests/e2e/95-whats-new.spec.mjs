// 95 - The one-time "New look" card on the Assignments page.
//
// Asked 2026-10-03, ahead of the new screens reaching the live app: tell
// lecturers, once, in a few clear sentences, what moved. Lecturers only - a
// student whose installation reaches the org is never told about staff
// screens. Remembered per browser on the live app; on beta per session, so it
// does not use up the live app's one showing (lib/whats-new.js).

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const card = (page) => page.locator('.whats-new');

test.describe('95 - New look, once', () => {
  test('a lecturer sees it above the assignments, and Got it puts it away for good', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);

    await expect(card(page)).toBeVisible({ timeout: 20000 });
    await expect(card(page).getByRole('heading', { name: 'New look' })).toBeVisible();
    await expect(card(page).locator('li')).toHaveCount(5);
    // Not a second solid button beside New assignment (DESIGN.md §1.2).
    await expect(card(page).locator('.btn-primary')).toHaveCount(0);
    // And it points at the screen, never at documentation (DESIGN.md §1.6).
    await expect(card(page).locator('a')).toHaveCount(0);

    await card(page).getByRole('button', { name: 'Got it' }).click();
    await expect(card(page)).toHaveCount(0);

    await page.reload();
    // The page has decided this is a lecturer - the org's tabs show on the same
    // verdict the card waits for - before the absence below means anything.
    await expect(page.getByRole('navigation', { name: 'Course views' })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('heading', { name: /Welcome to/ })).toBeVisible();
    await expect(card(page), 'remembered in this browser').toHaveCount(0);
  });

  test('a student who reaches the org never sees it', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: {}, studentHasInstallation: true });
    await page.route(`**/api.github.com/repos/${ORG}/pxl-classroom-control*`, (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('.center-card')).toBeVisible({ timeout: 20000 });
    await expect(card(page)).toHaveCount(0);
  });
});
