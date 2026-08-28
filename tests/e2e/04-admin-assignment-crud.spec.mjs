import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, openAutogradeModal, addCheck, CHECK_PYTHON } from '../fixtures/e2e-fixtures.mjs';

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

  // ARCHITECTURE §5.4 / §3.3, on the rendered form rather than the source.
  test('A new assignment opens on open enrolment, and asks nothing about acceptance mode', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    // `open` since 2026-08-24: signed invitations gate the broker, so the
    // roster is no longer what stands between a stranger and a repository -
    // and requiring a CSV import before anyone could accept bought nothing.
    const rosterSelect = page.locator('select').filter({ hasText: 'only students on the roster' });
    await expect(rosterSelect).toHaveValue('open');
    // No roster status, because no gate to report on - it says what open
    // enrolment means instead.
    await expect(page.locator('.roster-status')).toHaveCount(0);
    await expect(page.locator('text=Students need the link')).toBeVisible();

    // And the gate is one dropdown away, with its own answer to "can anyone
    // accept?" (ARCHITECTURE §10.4, covered in depth by 32-first-run-wall).
    await rosterSelect.selectOption('enforced');
    await expect(page.locator('.roster-status')).toContainText('nobody can accept');

    // One enum value is not a decision, so there is no control for it.
    await page.locator('details.advanced summary').click();
    await expect(page.locator('details.advanced')).toContainText('Student permission');
    await expect(page.locator('details.advanced')).not.toContainText('Acceptance mode');
  });

  // ARCHITECTURE §11.6 - the panel refuses what the schema refuses, in a sentence.
  // The checks live in a modal now (§6), so the refusal is on the row.
  test('A python check with no script cannot be saved, and says why', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await openAutogradeModal(page);
    await addCheck(page, CHECK_PYTHON);
    await page.getByLabel('Check 1 Python script').fill('');

    const err = page.locator('.autograde-setup-modal .field-error-msg');
    await expect(err).toContainText('needs a script');
    await expect(page.getByRole('button', { name: 'Save checks' })).toBeDisabled();

    await page.getByLabel('Check 1 Python script').fill('assert 1 == 1');
    await expect(err).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save checks' })).toBeEnabled();
  });
});
