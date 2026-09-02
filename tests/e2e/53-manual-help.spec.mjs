// 53 - The manual, and the help buttons that open it.
//
// Two surfaces over one source: MANUAL.md is compiled at build time into a
// block tree, and both the drawer and the /manual page render it through the
// same components. So the interesting failures are not "is the text right" -
// a unit test covers the parse - but whether the drawer actually appears where
// the reader is looking, and whether the two surfaces still agree.
//
// The drawer is `position: fixed` and lives beside <router-view> in App.vue for
// the reason spec 47 exists: an ancestor with a transform becomes the
// containing block and puts a fixed overlay off-screen, where it reads as a
// dead button. `fade-in` on a view wrapper is enough to do it, so the assertion
// here is geometric rather than "is it in the DOM".

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

async function openForm(page) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('button', { hasText: 'New assignment' }).first().click();
}

test.describe('53 - the help drawer', () => {
  test('a help button opens the drawer on its own topic', async ({ page }) => {
    await openForm(page);

    const button = page.getByRole('button', { name: /What does who may accept mean/ });
    await expect(button).toBeVisible({ timeout: 15000 });
    await button.click();

    const drawer = page.locator('.help-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Who may accept');
    await expect(drawer).toContainText('Roster is the default');
  });

  test('the drawer is inside the viewport, not scrolled off it', async ({ page }) => {
    // The spec-47 failure mode, on a different fixed element. Reaching the Late
    // work control scrolls the page, which is the precondition that hid the
    // Automated checks modal.
    await openForm(page);

    const button = page.getByRole('button', { name: /What does late work mean/ });
    await expect(button).toBeVisible({ timeout: 15000 });
    await button.click();

    const box = await page.locator('.help-drawer').boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.y).toBeLessThan(viewport.height);
    expect(box.x).toBeLessThan(viewport.width);
  });

  test('Escape closes it', async ({ page }) => {
    await openForm(page);
    await page.getByRole('button', { name: /What does late work mean/ }).click();
    await expect(page.locator('.help-drawer')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.help-drawer')).toHaveCount(0);
  });

  test('an internal link moves the drawer rather than navigating away', async ({ page }) => {
    // "Who may accept" links to the promote topic. Following it must not leave
    // the form the reader is filling in.
    await openForm(page);
    await page.getByRole('button', { name: /What does who may accept mean/ }).click();

    const drawer = page.locator('.help-drawer');
    await drawer.getByRole('button', { name: /Adding students who accepted/ }).click();

    await expect(drawer).toContainText('Adding students who accepted');
    await expect(page).toHaveURL(/\/admin/);
  });
});

test.describe('53 - the manual page', () => {
  test('Help in the header reaches every topic', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/admin`);

    await page.getByRole('link', { name: 'Help' }).first().click();
    await expect(page).toHaveURL(/\/manual/);

    // Same source as the drawer, so if these disagree one of the two surfaces
    // has stopped rendering the compiled manual.
    await expect(page.locator('#who-may-accept')).toContainText('Roster is the default');
    await expect(page.locator('#archiving')).toContainText('frozen');
    await expect(page.locator('.manual-topic')).toHaveCount(9);
  });
});
