// 35 - WS4: autograding becomes a task (ARCHITECTURE §11.6)
//
// It was an "Enable autograding" checkbox that opened a type dropdown and four
// unlabelled textareas whose meaning changed with it - no headers, no totals,
// no validation until the schema refused the save three commits later, and a
// visibility control named after its mechanism ("Private (Hidden via reusable
// workflow)") rather than after the decision.
//
// The form now shows one line. Everything else is a modal, and these tests care
// about the round trip through it: what a lecturer configures, what lands in the
// YAML, and what the summary line says about it afterwards.

import { test, expect } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  openAutogradeModal,
  addCheck,
  CHECK_RUN,
  CHECK_IO,
  CHECK_PYTHON,
} from '../fixtures/e2e-fixtures.mjs';
import { validateAgainst } from '../../lib/validate.mjs';

const modal = (page) => page.locator('.autograde-setup-modal');
const summaryText = (page) => page.locator('.autograde-summary-text');
const saveChecks = (page) => page.getByRole('button', { name: 'Save checks' });
const saveDraft = (page) => page.getByRole('button', { name: 'Save as draft' }).first();
const rowErrors = (page) => page.locator('.autograde-setup-modal .field-error-msg');

function committed(contentWrites, id) {
  const write = [...contentWrites].reverse().find((w) => w.path === `assignments/${id}.yml`);
  return write ? parseYaml(write.content) : null;
}

async function openNewForm(page, opts = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, ...opts });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('.new-btn').click();
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible({ timeout: 10000 });
}

async function fillMinimum(page, title) {
  await page.getByPlaceholder('e.g. Linux Processes 2026').fill(title);
  await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
}

// ================================================ §6.1 one line in the form

test.describe('35 - §6.1 The form shows a summary, never the configuration', () => {
  test('A new assignment says Off, and offers Set up', async ({ page }) => {
    await openNewForm(page);
    await expect(summaryText(page)).toHaveText('Off');
    await expect(page.locator('.autograde-summary-row button', { hasText: 'Set up' })).toBeVisible();
    await expect(page.locator('.autograde-summary-row button', { hasText: 'Remove' })).toHaveCount(0);
  });

  test('The old checkbox and row editor are gone from the form', async ({ page }) => {
    // "Enable autograding" was a flag that could disagree with the
    // configuration; the configuration's existence is the flag now.
    await openNewForm(page);
    await expect(page.locator('text=Enable autograding')).toHaveCount(0);
    await expect(page.locator('.tests-editor')).toHaveCount(0);
    await expect(page.locator('text=Execution Environment')).toHaveCount(0);
    await expect(page.locator('text=Test Visibility')).toHaveCount(0);
  });

  test('The summary describes what was configured, and Remove turns it off', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await addCheck(page, CHECK_IO);
    await saveChecks(page).click();

    await expect(summaryText(page)).toHaveText('2 checks · run on your machine');
    await expect(page.locator('.autograde-summary-row button', { hasText: 'Edit' })).toBeVisible();

    await page.locator('.autograde-summary-row button', { hasText: 'Remove' }).click();
    await expect(summaryText(page)).toHaveText('Off');
  });

  test('Running in student repos, hidden or visible, reads differently', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await saveChecks(page).click();
    await expect(summaryText(page)).toHaveText('1 check · run in student repos, hidden');

    await openAutogradeModal(page);
    await page.locator('input[value="public"]').check();
    await saveChecks(page).click();
    await expect(summaryText(page)).toHaveText('1 check · run in student repos, visible');
  });
});

// ================================================ §6.2 the modal

test.describe('35 - §6.2 The modal explains the decision, not the mechanism', () => {
  async function open(page, opts = {}) {
    await openNewForm(page, opts);
    await openAutogradeModal(page);
  }

  test('It opens with what this does, always visible', async ({ page }) => {
    await open(page);
    await expect(modal(page)).toContainText('record a score per student');
    await expect(modal(page)).toContainText('report and in the CSV export');
  });

  test('Where they run is two cards with the trade-off on them', async ({ page }) => {
    await open(page);
    const cards = modal(page).locator('.ag-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('No Actions minutes');
    await expect(cards.first()).toContainText('Never in the student repo');
    await expect(cards.last()).toContainText("organization's Actions minutes");
    await expect(cards.last()).toContainText('pass/fail on every push');
  });

  test('Visibility is a question about students, and only when it applies', async ({ page }) => {
    await open(page);
    // On your machine: the checks are never in the repo, so there is nothing
    // to ask.
    await expect(modal(page)).not.toContainText('Can students read the checks?');

    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await expect(modal(page)).toContainText('Can students read the checks?');
    await expect(modal(page)).toContainText('committed to each student');
    await expect(modal(page)).toContainText('stay in the control repository');
    // The mechanism is true, but it is not the decision.
    await expect(modal(page)).not.toContainText('reusable workflow');
  });

  test('The checks are a table with headers, and a running total', async ({ page }) => {
    await open(page);
    await expect(modal(page)).toContainText('No checks yet');

    await addCheck(page, CHECK_RUN);
    const head = modal(page).locator('.ag-table thead');
    await expect(head).toContainText('ID');
    await expect(head).toContainText('What it does');
    await expect(head).toContainText('Points');
    await expect(modal(page).locator('.ag-total')).toHaveText('10 points total');

    await addCheck(page, CHECK_IO);
    await expect(modal(page).locator('.ag-total')).toHaveText('20 points total');
  });

  test('Each preset arrives pre-filled and describes itself', async ({ page }) => {
    await open(page);
    await addCheck(page, CHECK_RUN);
    await addCheck(page, CHECK_IO);
    await addCheck(page, CHECK_PYTHON);

    const rows = modal(page).locator('.ag-table tbody tr').filter({ has: page.locator('.ag-id') });
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Command must succeed');
    await expect(rows.nth(1)).toContainText('Input → expected output');
    await expect(rows.nth(2)).toContainText('Python script');

    await expect(page.getByLabel('Check 1 command')).toHaveValue('make test');
    await expect(page.getByLabel('Check 2 command')).toHaveValue('./greet');
    // toHaveValue, not toContainText: v-model sets the DOM value property, and
    // a textarea's text node stays empty.
    await expect(page.getByLabel('Check 3 Python script')).toHaveValue(/subprocess/);
  });

  test('Type-specific fields sit under the row they belong to, labelled', async ({ page }) => {
    await open(page);
    await addCheck(page, CHECK_IO);
    await expect(modal(page)).toContainText('Input (stdin)');
    await expect(modal(page)).toContainText('Expected output');
    await expect(page.getByLabel('Check 1 stdin')).toHaveValue('Alice\n');
    await expect(page.getByLabel('Check 1 expected output')).toHaveValue('Hello Alice\n');
  });

  test('A modal is its own view, so it has exactly one solid button', async ({ page }) => {
    // DESIGN.md §1.2.
    await open(page);
    await addCheck(page, CHECK_RUN);
    const primaries = await page.evaluate(() =>
      [...document.querySelectorAll('.modal-overlay .btn-primary')]
        .filter((b) => b.offsetParent !== null)
        .map((b) => b.textContent.trim()),
    );
    expect(primaries).toEqual(['Save checks']);
  });

  test('Cancel leaves the assignment exactly as it was', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await saveChecks(page).click();
    await expect(summaryText(page)).toHaveText('1 check · run on your machine');

    await openAutogradeModal(page);
    await addCheck(page, CHECK_IO);
    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await modal(page).getByRole('button', { name: 'Cancel' }).click();

    await expect(summaryText(page)).toHaveText('1 check · run on your machine');
  });

  test('Reopening shows what was saved', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_PYTHON);
    await page.getByLabel('Check 1 ID').fill('validator');
    await saveChecks(page).click();

    await openAutogradeModal(page);
    await expect(page.getByLabel('Check 1 ID')).toHaveValue('validator');
    await expect(page.getByLabel('Check 1 Python script')).toHaveValue(/subprocess/);
  });
});

// ================================================ §6.3 unsaveable states

test.describe('35 - §6.3 The modal cannot produce a document the schema rejects', () => {
  async function open(page, opts = {}) {
    await openNewForm(page, opts);
    await openAutogradeModal(page);
  }

  test('Zero checks cannot be saved - that is what turning it off is for', async ({ page }) => {
    await open(page);
    await expect(saveChecks(page)).toBeDisabled();
    await addCheck(page, CHECK_RUN);
    await expect(saveChecks(page)).toBeEnabled();
  });

  test('Closing with nothing configured leaves it Off, not enabled-and-empty', async ({ page }) => {
    await open(page);
    await modal(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(summaryText(page)).toHaveText('Off');
    await expect(saveDraft(page)).toBeDisabled(); // still missing a title
  });

  test('An incomplete row blocks Save and says why, on the row', async ({ page }) => {
    await open(page);
    await addCheck(page, CHECK_RUN);
    await page.getByLabel('Check 1 ID').fill('Task 1');

    await expect(rowErrors(page)).toContainText('lowercase letters, numbers and dashes');
    await expect(saveChecks(page)).toBeDisabled();

    await page.getByLabel('Check 1 ID').fill('task-1');
    await expect(rowErrors(page)).toHaveCount(0);
    await expect(saveChecks(page)).toBeEnabled();
  });

  test('An empty command is refused, not silently saved as a check that passes', async ({ page }) => {
    await open(page);
    await addCheck(page, CHECK_RUN);
    await page.getByLabel('Check 1 command').fill('');
    await expect(rowErrors(page)).toContainText('command to run');
    await expect(saveChecks(page)).toBeDisabled();
  });

  test('Two checks with the same ID are refused, because they collide in the workflow', async ({ page }) => {
    await open(page);
    await addCheck(page, CHECK_RUN);
    await addCheck(page, CHECK_IO);
    await page.getByLabel('Check 2 ID').fill('builds');

    await expect(rowErrors(page).first()).toContainText('share this ID');
    await expect(saveChecks(page)).toBeDisabled();
  });

  test('Removing the last check leaves Save disabled rather than saving nothing', async ({ page }) => {
    await open(page);
    await addCheck(page, CHECK_RUN);
    await expect(saveChecks(page)).toBeEnabled();
    await modal(page).getByRole('button', { name: /Remove check/ }).click();
    await expect(saveChecks(page)).toBeDisabled();
    await expect(modal(page)).toContainText('No checks yet');
  });
});

// ================================================ the round trip

test.describe('35 - What the lecturer configured is what the YAML says', () => {
  test('Three checks, in student repos, hidden - through the form to the document', async ({ page }) => {
    const contentWrites = [];
    await openNewForm(page, { contentWrites });
    await fillMinimum(page, 'Checks Lab');

    await openAutogradeModal(page);
    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await addCheck(page, CHECK_RUN);
    await addCheck(page, CHECK_IO);
    await addCheck(page, CHECK_PYTHON);
    await saveChecks(page).click();
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'checks-lab'), { timeout: 10000 }).toBeTruthy();
    const doc = committed(contentWrites, 'checks-lab');

    expect(doc.autograde.enabled).toBe(true);
    expect(doc.autograde.execution_environment).toBe('github_actions');
    expect(doc.autograde.visibility).toBe('private');
    expect(doc.autograde.tests.map((t) => t.id)).toEqual(['builds', 'output', 'script']);
    expect(doc.autograde.tests.map((t) => t.type)).toEqual(['run', 'io', 'python']);

    const { valid, errors } = validateAgainst('assignment', doc);
    expect(valid, JSON.stringify(errors)).toBe(true);
  });

  test('Turning it off writes no autograde block at all', async ({ page }) => {
    const contentWrites = [];
    await openNewForm(page, { contentWrites });
    await fillMinimum(page, 'Off Lab');

    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await saveChecks(page).click();
    await page.locator('.autograde-summary-row button', { hasText: 'Remove' }).click();
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'off-lab'), { timeout: 10000 }).toBeTruthy();
    expect(committed(contentWrites, 'off-lab')).not.toHaveProperty('autograde');
  });

  test('"Turn off automated checks" inside the modal does the same', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await saveChecks(page).click();
    await expect(summaryText(page)).toHaveText('1 check · run on your machine');

    await openAutogradeModal(page);
    await modal(page).getByRole('button', { name: /Turn off automated checks/ }).click();
    await expect(summaryText(page)).toHaveText('Off');
  });

  test('An existing configuration loads back into the modal and re-saves unchanged', async ({ page }) => {
    const contentWrites = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      contentWrites,
      assignments: {
        'lab': {
          schema_version: 1,
          id: 'lab',
          title: 'Lab',
          organization: ORG,
          template: { owner: ORG, repository: 'starter-template' },
          repository_name_pattern: 'lab-{github_login}',
          opens_at: new Date(Date.now() - 86400000).toISOString(),
          deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
          state: 'draft',
          assignment_type: 'individual',
          autograde: {
            enabled: true,
            execution_environment: 'github_actions',
            visibility: 'public',
            tests: [{ id: 'compiles', type: 'run', command: 'make', points: 20 }],
          },
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=lab`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Lab', { timeout: 10000 });

    await expect(summaryText(page)).toHaveText('1 check · run in student repos, visible');

    await openAutogradeModal(page);
    await expect(page.getByLabel('Check 1 ID')).toHaveValue('compiles');
    await expect(page.getByLabel('Check 1 command')).toHaveValue('make');
    await expect(modal(page).locator('.ag-total')).toHaveText('20 points total');
    await expect(page.locator('input[value="public"]')).toBeChecked();
    await saveChecks(page).click();

    await saveDraft(page).click();
    await expect.poll(() => committed(contentWrites, 'lab'), { timeout: 10000 }).toBeTruthy();
    expect(committed(contentWrites, 'lab').autograde).toEqual({
      enabled: true,
      execution_environment: 'github_actions',
      visibility: 'public',
      tests: [{ id: 'compiles', type: 'run', command: 'make', points: 20 }],
    });
  });
});
