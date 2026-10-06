// 97 - Every confirmation is asked in the page, and the states a page question
// can reach that the browser's box could not are each safe.
//
// The browser's confirm() blocked the whole page, so it could never be left
// open behind a navigation, answered twice, or outlive the page that asked.
// The in-page question can (frontend/src/lib/confirm.js), and each of those is
// pinned here on a real flow: a destructive question left open across a Back,
// a leave guard answered both ways, a delete, and an action outside its window.
// The service's own states are tests/confirm-service.test.mjs.

import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  answerConfirm,
  chooseState,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'confirm-probe';
const TITLE = 'Confirm Probe';
const STUDENT = 'stud-one';

function assignment(over = {}) {
  return {
    schema_version: 1,
    id: ID,
    title: TITLE,
    organization: ORG,
    assignment_type: 'individual',
    roster_mode: 'enforced',
    state: 'published',
    template: { owner: ORG, repository: 'starter-template' },
    repository_name_pattern: `${ID}-{github_login}`,
    opens_at: '2026-08-01T08:00:00.000Z',
    deadline_at: '2026-12-31T22:00:00.000Z',
    max_acceptances: 50,
    ...over,
  };
}

const roster = [
  { student_number: '1', full_name: 'Ann Smets', github_login: STUDENT, email: 'ann@student.pxl.be' },
  { student_number: '2', full_name: 'Bo Peeters', github_login: 'stud-two', email: 'bo@student.pxl.be' },
];

async function open(page, opts = {}) {
  const contentWrites = [];
  const workflowDispatches = [];
  const deletes = [];
  page.on('request', (r) => { if (r.method() === 'DELETE') deletes.push(decodeURIComponent(r.url())); });
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, roster, contentWrites, workflowDispatches, ...opts });
  return { contentWrites, workflowDispatches, deletes };
}

const rosterWrites = (writes) => writes.filter((w) => w.path === 'students/roster.yml');

test.describe('97 - a question left open never acts on a page that is gone', () => {
  test('Back while "Remove from roster?" is open: answered no, and nothing is removed', async ({ page }) => {
    const { contentWrites } = await open(page, { assignments: {} });
    // History inside the app: the assignment list, then the Roster page.
    await page.goto(`/dashboard/${ORG}`);
    await page.getByRole('navigation', { name: 'Course views' }).getByRole('link', { name: 'Roster', exact: true }).click();
    await expect(page.locator('.roster-table')).toBeVisible({ timeout: 15000 });

    await page.locator('tr', { hasText: 'Ann Smets' }).locator('.row-menu-anchor button').click();
    await page.getByRole('menuitem', { name: /Remove from roster/ }).click();
    const ask = page.locator('.confirm-dialog');
    await expect(ask).toContainText('Remove Ann Smets from the roster?');
    await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}$`));
    await expect(ask).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(rosterWrites(contentWrites), 'the abandoned question removed nobody').toEqual([]);

    // And coming forward again does not bring the question back.
    await page.goForward();
    await expect(page.locator('.roster-table')).toBeVisible({ timeout: 15000 });
    await expect(ask).toHaveCount(0);
  });

  test('the habitual Enter on a destructive question is Cancel', async ({ page }) => {
    const { contentWrites } = await open(page, { assignments: {} });
    await page.goto(`/dashboard/${ORG}/roster`);
    await expect(page.locator('.roster-table')).toBeVisible({ timeout: 15000 });
    await page.locator('tr', { hasText: 'Ann Smets' }).locator('.row-menu-anchor button').click();
    await page.getByRole('menuitem', { name: /Remove from roster/ }).click();
    await expect(page.locator('.confirm-dialog')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.confirm-dialog')).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(rosterWrites(contentWrites)).toEqual([]);

    // Escape is Cancel too; the button that names the action is what removes.
    await page.locator('tr', { hasText: 'Ann Smets' }).locator('.row-menu-anchor button').click();
    await page.getByRole('menuitem', { name: /Remove from roster/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.confirm-dialog')).toHaveCount(0);
    await page.locator('tr', { hasText: 'Ann Smets' }).locator('.row-menu-anchor button').click();
    await page.getByRole('menuitem', { name: /Remove from roster/ }).click();
    await page.locator('.confirm-dialog').getByRole('button', { name: 'Remove from roster' }).click();
    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
    expect(rosterWrites(contentWrites)[0].content).not.toContain('Ann Smets');
  });
});

test.describe('97 - leaving unsaved work behind asks, in one wording', () => {
  test('the Roster page with a pasted import: Cancel stays with it, Discard changes leaves', async ({ page }) => {
    await open(page, { assignments: {} });
    await page.goto(`/dashboard/${ORG}/roster`);
    await expect(page.locator('.roster-table')).toBeVisible({ timeout: 15000 });
    await page.locator('.roster-tab textarea').first().fill(
      'student_number,full_name,email\n3,Cas Wouters,cas@student.pxl.be',
    );
    await expect(page.locator('.diff-badge.added')).toContainText('+ 1 added');

    const assignmentsTab = page.getByRole('navigation', { name: 'Course views' }).getByRole('link', { name: 'Assignments', exact: true });
    await assignmentsTab.click();
    const ask = page.locator('.confirm-dialog');
    await expect(ask).toContainText('Discard unsaved changes?');
    await expect(ask).toContainText('The roster import you pasted has not been committed.');
    await answerConfirm(page, { accept: false });
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/roster$`));
    await expect(page.locator('.roster-tab textarea').first()).toHaveValue(/Cas Wouters/);

    await assignmentsTab.click();
    await expect(ask.getByRole('button', { name: 'Discard changes' })).toBeVisible();
    await answerConfirm(page);
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}$`));
  });
});

test.describe('97 - a delete and an action outside its window ask, and No does nothing', () => {
  test('Delete draft: named by title, red, Cancel deletes nothing, the action deletes', async ({ page }) => {
    const { deletes } = await open(page, { assignments: { [ID]: assignment({ state: 'draft' }) } });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await chooseState(page, 'Delete draft');
    const ask = page.locator('.confirm-dialog');
    await expect(ask).toContainText(`Delete the draft "${TITLE}"?`);
    await expect(ask).not.toContainText(/control repo|\.yml/);
    await expect(ask.getByRole('button', { name: 'Delete draft' })).toHaveClass(/btn-danger/);
    await answerConfirm(page, { accept: false });
    await page.waitForTimeout(500);
    expect(deletes.filter((d) => d.includes(`assignments/${ID}.yml`))).toEqual([]);

    await chooseState(page, 'Delete draft');
    await answerConfirm(page);
    await expect.poll(() => deletes.filter((d) => d.includes(`assignments/${ID}.yml`)).length, { timeout: 10000 }).toBe(1);
  });

  test('Retry past the deadline says the window is closed; No dispatches nothing, Retry anyway does', async ({ page }) => {
    const { workflowDispatches } = await open(page, {
      assignments: { [ID]: assignment({ deadline_at: '2026-01-31T22:00:00.000Z' }) },
      reports: {
        [ID]: {
          schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(),
          students: [{ github_login: STUDENT, acceptance_state: 'accepted', submission_status: 'no-submission' }],
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    const retries = () => workflowDispatches.filter((d) => d.workflow === 'retry-acceptance.yml');

    await page.getByRole('button', { name: `Actions for ${STUDENT}` }).first().click();
    await page.locator('.modal-overlay .modal').getByRole('button', { name: /Retry acceptance/ }).click();
    const ask = page.locator('.confirm-dialog');
    await expect(ask).toContainText(`Retry @${STUDENT}'s acceptance outside the assignment's window?`);
    await expect(ask).toContainText(/Its deadline passed/);
    // Asked over the student's own dialog, not behind it.
    await expect(ask.getByRole('button', { name: 'Retry anyway' })).toBeInViewport({ ratio: 1 });
    await answerConfirm(page, { accept: false });
    await page.waitForTimeout(500);
    expect(retries()).toEqual([]);

    await page.locator('.modal-overlay .modal').getByRole('button', { name: /Retry acceptance/ }).click();
    await answerConfirm(page);
    await expect.poll(() => retries().length, { timeout: 10000 }).toBe(1);
    expect(retries()[0].inputs.bypass_window).toBe('true');
  });
});
