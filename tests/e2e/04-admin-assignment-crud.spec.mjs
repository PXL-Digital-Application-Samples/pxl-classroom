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

  // ARCHITECTURE §5.4, on the rendered form rather than the source.
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

  // Reported from live use: the field wants `owner/repo` and what a lecturer
  // has on the clipboard is an address bar, so pasting produced "Use the full
  // name, e.g. ..." - a control refusing the ordinary way to fill it in and
  // then explaining itself (DESIGN.md §1.5).
  //
  // tests/github-repo-ref.test.mjs covers what the parser makes of each shape.
  // This is the other half, and the half a unit test cannot reach: that the
  // parser is actually WIRED to the input event, that the box is rewritten
  // rather than only the model, and that the pre-flight check then runs on the
  // normalised value.
  const templateBox = (page) => page.getByPlaceholder('Type or select a template repository');

  test('A pasted GitHub URL is rewritten to owner/repo, and the field accepts it', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    const box = templateBox(page);
    await expect(box).toBeVisible();
    await box.fill(`https://github.com/${ORG}/linux-template`);

    await expect(box, 'the box shows what will be saved, not the URL').toHaveValue(
      `${ORG}/linux-template`,
    );
    await expect(page.locator('.field-error-msg', { hasText: /Use the full name/ })).toHaveCount(0);
    // The whole point: it reaches the pre-flight check, which is what tells the
    // lecturer the template is real.
    await expect(page.locator('.template-preflight-badge .badge-success')).toBeVisible({
      timeout: 10000,
    });
  });

  test('The "Use this template" URL is the likeliest paste, and it works too', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await templateBox(page).fill(`https://github.com/${ORG}/linux-template/generate`);
    await expect(templateBox(page)).toHaveValue(`${ORG}/linux-template`);
  });

  test('A non-GitHub URL is left alone and still says what the field wants', async ({ page }) => {
    // Normalising this to `x/y` would hand back a valid-looking value for a
    // repository that cannot exist. The error is the honest answer.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await templateBox(page).fill('https://gitlab.com/x/y');
    await expect(templateBox(page)).toHaveValue('https://gitlab.com/x/y');
    await expect(page.locator('.field-error-msg', { hasText: /Use the full name/ })).toBeVisible();
  });
});
