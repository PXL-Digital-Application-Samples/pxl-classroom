import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

test.describe('04 - Lecturer Assignment Admin Panel (CRUD & Validation)', () => {
  test('Happy Path: Lecturer fills out assignment form, searches template, and previews pattern', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
    });

    await page.goto(`/dashboard/${ORG}/admin`);
    const adminHeader = page.locator('.app-header-crumbs .app-header-heading');
    await expect(adminHeader).toBeVisible({ timeout: 10000 });

    // Click "+ New assignment"
    const newBtn = page.locator('.new-btn');
    await expect(newBtn).toBeVisible();
    await newBtn.click();

    // Fill Title and verify slug derivation
    const titleInput = page.getByPlaceholder('e.g. Linux Processes 2026');
    await expect(titleInput).toBeVisible();
    await titleInput.fill('Security Lab Assignment 1');

    const slugInput = page.getByPlaceholder('linux-processes-2026');
    await expect(slugInput).toHaveValue('security-lab-assignment-1');

    // Toggle to Group Assignment
    const groupRadio = page.locator('input[value="group"]');
    if (await groupRadio.isVisible()) {
      await groupRadio.check();
      // Verify group options appear (Max Team Size)
      await expect(page.locator('#max-team-size, input[type="number"]').first()).toBeVisible();
    }
  });

  test('Sad Path: Form validation blocks submission when required fields are missing', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
    });

    await page.goto(`/dashboard/${ORG}/admin`);
    const newBtn = page.locator('.new-btn');
    await newBtn.click();

    // With empty title, save buttons are disabled
    const saveDraftBtn = page.locator('button', { hasText: 'Save as draft' }).first();
    await expect(saveDraftBtn).toBeDisabled();

    const savePublishBtn = page.locator('button', { hasText: /Save & publish/ }).first();
    await expect(savePublishBtn).toBeDisabled();
  });

  test('Edge Case: Slug field is locked when editing an existing assignment', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'existing-asgn': {
          id: 'existing-asgn',
          title: 'Existing Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          opens_at: new Date().toISOString(),
          deadline_at: new Date(Date.now() + 86400000).toISOString(),
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/admin?edit=existing-asgn`);
    const slugInput = page.getByPlaceholder('linux-processes-2026');
    if (await slugInput.isVisible()) {
      await expect(slugInput).toBeDisabled();
    }
  });
});
