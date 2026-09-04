// 36 - WS4 edge cases (ARCHITECTURE §11.6)
//
// 35-autograding covers the happy shape of each fix. This covers the states
// around them: what happens to a field the modal does not show, what a blank
// number means, what removing a row in the middle does to the rows around it,
// and every way out of a dialog.
//
// Two gaps came out of writing it, both about a control quietly deciding
// something on the lecturer's behalf:
//
//   * Escape did not close the modal. Every other modal in the app closes on
//     it; a dialog you can only leave by finding the right button is a trap.
//   * A blank points field was `Number('') === 0`, so `cleanChecks` wrote
//     `points: 0` for a row nobody had filled in - a score the system chose.

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
const idInputs = (page) => page.locator('.autograde-setup-modal .ag-id');

function committed(contentWrites, id) {
  const write = [...contentWrites].reverse().find((w) => w.path === `assignments/${id}.yml`);
  return write ? parseYaml(write.content) : null;
}

const assignment = (over = {}) => ({
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
  ...over,
});

async function openNewForm(page, opts = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, ...opts });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('.new-btn').click();
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible({ timeout: 10000 });
}

async function openEditorFor(page, a, opts = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [a.id]: a }, ...opts });
  await page.goto(`/dashboard/${ORG}/admin?edit=${a.id}`);
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue(a.title, { timeout: 10000 });
}

async function fillMinimum(page, title) {
  await page.getByPlaceholder('e.g. Linux Processes 2026').fill(title);
  await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
}

// ======================================= every way out of the dialog

test.describe('36 - Leaving the modal', () => {
  test('Escape closes it without saving', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);

    await page.keyboard.press('Escape');
    await expect(modal(page)).toHaveCount(0);
    await expect(summaryText(page)).toHaveText('Off');
  });

  test('Clicking the backdrop closes it without saving', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);

    await page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(modal(page)).toHaveCount(0);
    await expect(summaryText(page)).toHaveText('Off');
  });

  test('The × button closes it without saving', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);

    await modal(page).locator('.modal-close').click();
    await expect(modal(page)).toHaveCount(0);
    await expect(summaryText(page)).toHaveText('Off');
  });

  test('Escape does not discard what was already saved', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await saveChecks(page).click();

    await openAutogradeModal(page);
    await addCheck(page, CHECK_IO);
    await page.keyboard.press('Escape');

    // The modal must actually have CLOSED. Asserting only the summary passes
    // just as well when Escape does nothing at all, which is what it did.
    await expect(modal(page)).toHaveCount(0);
    await expect(summaryText(page)).toHaveText('1 check · run on your machine');
  });
});

// ======================================= the rows

test.describe('36 - Rows keep their own values', () => {
  test('Removing the middle check leaves the other two intact', async ({ page }) => {
    // The rows are rendered by index, so removing one re-indexes every row
    // after it. A row that kept the value of its old position would silently
    // rewrite a lecturer's check.
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await addCheck(page, CHECK_IO);
    await addCheck(page, CHECK_PYTHON);

    await page.getByLabel('Check 1 ID').fill('first');
    await page.getByLabel('Check 2 ID').fill('second');
    await page.getByLabel('Check 3 ID').fill('third');

    await modal(page).getByRole('button', { name: 'Remove check second' }).click();

    await expect(idInputs(page)).toHaveCount(2);
    await expect(page.getByLabel('Check 1 ID')).toHaveValue('first');
    await expect(page.getByLabel('Check 2 ID')).toHaveValue('third');
    // And the type-specific fields moved with their row: `third` is the python
    // one, so there is no stdin box left over from the io check that was in
    // that position.
    await expect(page.getByLabel('Check 2 Python script')).toHaveValue(/subprocess/);
    await expect(page.getByLabel('Check 2 stdin')).toHaveCount(0);
  });

  test('The row error points at the row it belongs to', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await addCheck(page, CHECK_IO);
    await page.getByLabel('Check 2 command').fill('');

    await expect(rowErrors(page)).toHaveCount(1);
    await expect(rowErrors(page)).toContainText('command to run');

    // Fixing the second does not leave the first flagged, and vice versa.
    await page.getByLabel('Check 2 command').fill('./greet');
    await expect(rowErrors(page)).toHaveCount(0);
    await page.getByLabel('Check 1 command').fill('');
    await expect(rowErrors(page)).toHaveCount(1);
  });

  test('Two bad rows both block, and fixing one is not fixing both', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await addCheck(page, CHECK_IO);
    await page.getByLabel('Check 1 ID').fill('Bad One');
    await page.getByLabel('Check 2 ID').fill('Bad Two');

    await expect(rowErrors(page)).toHaveCount(2);
    await page.getByLabel('Check 1 ID').fill('good-one');
    await expect(rowErrors(page)).toHaveCount(1);
    await expect(saveChecks(page)).toBeDisabled();

    await page.getByLabel('Check 2 ID').fill('good-two');
    await expect(saveChecks(page)).toBeEnabled();
  });

  test('A fourth check of the same kind keeps numbering, rather than colliding', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    for (let i = 0; i < 4; i++) await addCheck(page, CHECK_RUN);

    await expect(idInputs(page)).toHaveCount(4);
    for (const [i, id] of ['builds', 'builds-2', 'builds-3', 'builds-4'].entries()) {
      await expect(page.getByLabel(`Check ${i + 1} ID`)).toHaveValue(id);
    }
    await expect(rowErrors(page)).toHaveCount(0);
    await expect(saveChecks(page)).toBeEnabled();
  });
});

// ======================================= points

test.describe('36 - Points are a number the lecturer chose', () => {
  test('A blank points field is refused, not silently taken as zero', async ({ page }) => {
    // Number('') is 0, so this used to save a score nobody had entered.
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await page.getByLabel('Check 1 points').fill('');

    await expect(rowErrors(page)).toContainText('points value');
    await expect(saveChecks(page)).toBeDisabled();
  });

  test('Zero points is a legitimate choice, and stays zero', async ({ page }) => {
    // A setup step that must succeed but is worth nothing is a real check.
    const contentWrites = [];
    await openNewForm(page, { contentWrites });
    await fillMinimum(page, 'Zero Points Lab');
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await page.getByLabel('Check 1 points').fill('0');

    await expect(rowErrors(page)).toHaveCount(0);
    await expect(modal(page).locator('.ag-total')).toHaveText('0 points total');
    await saveChecks(page).click();
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'zero-points-lab'), { timeout: 10000 }).toBeTruthy();
    expect(committed(contentWrites, 'zero-points-lab').autograde.tests[0].points).toBe(0);
  });

  test('Negative points are refused', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await page.getByLabel('Check 1 points').fill('-5');

    await expect(rowErrors(page)).toContainText('0 or more');
    await expect(saveChecks(page)).toBeDisabled();
  });

  test('Fractional points survive to the document, because the schema allows them', async ({ page }) => {
    const contentWrites = [];
    await openNewForm(page, { contentWrites });
    await fillMinimum(page, 'Half Points Lab');
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await page.getByLabel('Check 1 points').fill('2.5');
    await expect(modal(page).locator('.ag-total')).toHaveText('2.5 points total');
    await saveChecks(page).click();
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'half-points-lab'), { timeout: 10000 }).toBeTruthy();
    const doc = committed(contentWrites, 'half-points-lab');
    expect(doc.autograde.tests[0].points).toBe(2.5);
    expect(validateAgainst('assignment', doc).valid).toBe(true);
  });

  test('The total is the sum on screen, not a stale one', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await addCheck(page, CHECK_IO);
    await expect(modal(page).locator('.ag-total')).toHaveText('20 points total');

    await page.getByLabel('Check 1 points').fill('30');
    await expect(modal(page).locator('.ag-total')).toHaveText('40 points total');

    await modal(page).getByRole('button', { name: 'Remove check output' }).click();
    await expect(modal(page).locator('.ag-total')).toHaveText('30 points total');
  });
});

// ======================================= what the modal does not show

test.describe('36 - A field the modal does not show is not a field it may delete', () => {
  test('timeout_s survives an edit that never touches it', async ({ page }) => {
    // The modal has no timeout control, and it rebuilds the checks it saves -
    // which is exactly how buildDoc used to delete invitation tokens.
    const contentWrites = [];
    await openEditorFor(
      page,
      assignment({
        autograde: {
          enabled: true,
          execution_environment: 'lecturer_local',
          tests: [{ id: 'slow', type: 'run', command: 'make', points: 10, timeout_s: 120 }],
        },
      }),
      { contentWrites },
    );

    await openAutogradeModal(page);
    await page.getByLabel('Check 1 points').fill('15');
    await saveChecks(page).click();
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'lab'), { timeout: 10000 }).toBeTruthy();
    const [check] = committed(contentWrites, 'lab').autograde.tests;
    expect(check.points).toBe(15);
    expect(check.timeout_s, 'a field with no control is still a field').toBe(120);
  });

  test('stdin and expected output survive the round trip verbatim', async ({ page }) => {
    const contentWrites = [];
    await openNewForm(page, { contentWrites });
    await fillMinimum(page, 'Io Lab');
    await openAutogradeModal(page);
    await addCheck(page, CHECK_IO);
    await page.getByLabel('Check 1 stdin').fill('3 4\n');
    await page.getByLabel('Check 1 expected output').fill('Sum: 7\n');
    await saveChecks(page).click();
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'io-lab'), { timeout: 10000 }).toBeTruthy();
    const [check] = committed(contentWrites, 'io-lab').autograde.tests;
    expect(check.stdin).toBe('3 4\n');
    expect(check.expected_stdout).toBe('Sum: 7\n');
    expect(check).not.toHaveProperty('script');
  });
});

// ======================================= where they run

test.describe('36 - Where they run, and what that changes', () => {
  test('Switching back to your machine keeps the visibility choice for next time', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);

    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await page.locator('input[value="public"]').check();
    await page.getByRole('radio', { name: /On your machine/ }).check();
    await expect(modal(page)).not.toContainText('Can students read the checks?');

    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await expect(page.locator('input[value="public"]')).toBeChecked();
  });

  test('Hidden is the default, because it is the safer answer', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await page.getByRole('radio', { name: /In each student's repo/ }).check();

    await expect(page.locator('input[value="private"]')).toBeChecked();
  });

  test('Changing where they run updates the document, not just the screen', async ({ page }) => {
    const contentWrites = [];
    await openEditorFor(
      page,
      assignment({
        autograde: {
          enabled: true,
          execution_environment: 'lecturer_local',
          visibility: 'private',
          tests: [{ id: 'builds', type: 'run', command: 'make', points: 10 }],
        },
      }),
      { contentWrites },
    );

    await openAutogradeModal(page);
    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await page.locator('input[value="public"]').check();
    await saveChecks(page).click();
    await expect(summaryText(page)).toHaveText('1 check · run in student repos, visible');

    await saveDraft(page).click();
    await expect.poll(() => committed(contentWrites, 'lab'), { timeout: 10000 }).toBeTruthy();
    const { autograde } = committed(contentWrites, 'lab');
    expect(autograde.execution_environment).toBe('github_actions');
    expect(autograde.visibility).toBe('public');
  });

  test('The CLI hint appears only when the checks run on your machine, with this slug in it', async ({ page }) => {
    await openNewForm(page);
    await fillMinimum(page, 'Hint Lab');
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await saveChecks(page).click();

    const hint = page.locator('.autograde-summary small');
    await expect(hint).toContainText('pxl-classroom grade');
    await expect(hint).toContainText('--assignment hint-lab');

    await openAutogradeModal(page);
    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await saveChecks(page).click();
    await expect(hint).toHaveCount(0);
  });
});

// ======================================= removing, and what is left

test.describe('36 - Removing the configuration removes all of it', () => {
  test('Remove clears the checks, not just the flag', async ({ page }) => {
    await openNewForm(page);
    await openAutogradeModal(page);
    await addCheck(page, CHECK_RUN);
    await addCheck(page, CHECK_IO);
    await saveChecks(page).click();

    await page.locator('.autograde-summary-row button', { hasText: 'Remove' }).click();
    await expect(summaryText(page)).toHaveText('Off');

    // Reopening starts empty - a left-behind list would come back on the next
    // Set up as checks the lecturer thought they had deleted. With nothing
    // configured the modal opens on the template branch now, so the branch
    // that HELD the list has to be asked for before its emptiness means
    // anything.
    await openAutogradeModal(page);
    await page.getByRole('radio', { name: /I define them here/ }).check();
    await expect(modal(page)).toContainText('No checks yet');
    await expect(idInputs(page)).toHaveCount(0);
  });

  test('An existing assignment can have its checks removed, and the block leaves the YAML', async ({ page }) => {
    const contentWrites = [];
    await openEditorFor(
      page,
      assignment({
        autograde: {
          enabled: true,
          execution_environment: 'lecturer_local',
          tests: [{ id: 'builds', type: 'run', command: 'make', points: 10 }],
        },
      }),
      { contentWrites },
    );
    await expect(summaryText(page)).toHaveText('1 check · run on your machine');

    await page.locator('.autograde-summary-row button', { hasText: 'Remove' }).click();
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'lab'), { timeout: 10000 }).toBeTruthy();
    expect(committed(contentWrites, 'lab')).not.toHaveProperty('autograde');
  });
});

// ======================================= hand-written YAML

test.describe('36 - A configuration the modal did not write', () => {
  test('An unknown check type loads without crashing the modal', async ({ page }) => {
    // The schema forbids it, but a YAML can carry it, and the editor is where
    // a lecturer would go to fix it.
    await openEditorFor(
      page,
      assignment({
        autograde: {
          enabled: true,
          execution_environment: 'lecturer_local',
          tests: [{ id: 'weird', type: 'quantum', command: 'make', points: 5 }],
        },
      }),
    );
    await expect(summaryText(page)).toHaveText('1 check · run on your machine');

    await openAutogradeModal(page);
    await expect(page.getByLabel('Check 1 ID')).toHaveValue('weird');
    // Anything that is not io or python is described as a command check, which
    // is what the generator does with it too.
    await expect(modal(page).locator('.ag-table tbody tr').first()).toContainText('Command must succeed');
  });

  test('A check with no points at all is flagged rather than defaulted', async ({ page }) => {
    await openEditorFor(
      page,
      assignment({
        autograde: {
          enabled: true,
          execution_environment: 'lecturer_local',
          tests: [{ id: 'nopoints', type: 'run', command: 'make' }],
        },
      }),
    );

    await openAutogradeModal(page);
    await expect(rowErrors(page)).toContainText('points value');
    await expect(saveChecks(page)).toBeDisabled();
  });
});
