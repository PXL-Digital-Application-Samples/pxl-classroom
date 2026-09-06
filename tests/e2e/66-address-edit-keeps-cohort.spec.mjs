// 66 - Correcting a typo must not take the student out of the assignment.
//
// A student number and a GitHub login are handed to this system. An address is
// TYPED - and once a roster row can be identified by one (which it can, since
// `student_number` stopped being required of an imported row), a row carrying
// only an address is identified BY that address. So fixing a typo in it
// re-identifies the row, and every cohort naming the old spelling stops
// matching.
//
// That is a removal from a published cohort by the back door. The picker is
// add-only once an assignment is published, precisely so a lecturer cannot drop
// a student who already holds a repository - and an edit made on the Roster tab
// walked straight past it, because neither half knew about the other.
//
// The dialog is not a warning. It carries the cohorts over.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
// The screen's word for a state, taken from the module that owns it. Spelling
// "Published" here would assert against the schema's vocabulary, which is the
// exact thing that map exists to keep off the screen - the label is "Accepting".
import { assignmentStateLabel } from '../../frontend/src/lib/status-labels.js';

/**
 * Nina has no student number and no GitHub account, which is the ordinary
 * shape under roster_mode 'claim' - the mode built for a lecturer who is handed
 * addresses. Alice has a number, so her address is not her identity and editing
 * it must stay silent.
 */
const ROSTER = [
  { full_name: 'Nina Peeters', email: 'nina@student.pxl.be' },
  { full_name: 'Alice Example', student_number: '0123456', email: 'alice@student.pxl.be' },
];

const assignment = (over = {}) => ({
  schema_version: 1,
  id: 'lab-3',
  title: 'Lab 3',
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: 'lab-3-{github_login}',
  opens_at: '2026-09-01T08:00:00Z',
  deadline_at: '2026-12-30T20:00:00Z',
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'enforced',
  cohort: ['num:0123456', 'email:nina@student.pxl.be'],
  ...over,
});

async function openRoster(page, { roster = ROSTER, assignments } = {}) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    roster,
    contentWrites,
    assignments: assignments ?? { 'lab-3': assignment() },
  });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();
  await expect(page.locator('.roster-table')).toBeVisible({ timeout: 15000 });
  return { contentWrites };
}

/**
 * The confirm, scoped.
 *
 * Edit details stays open BEHIND it - deliberately, so cancelling keeps what
 * the lecturer typed - and it has a Cancel of its own, disabled while it saves.
 * An unscoped `getByRole('button', { name: 'Cancel' })` finds that one.
 */
const confirmDialog = (page) =>
  page.locator('.modal-overlay', { hasText: 'Change the email address' });

const row = (page, who) => page.locator('.roster-table tr', { hasText: who });
const menuFor = (page, who) => row(page, who).locator('.row-menu-anchor button');
const writesTo = (writes, path) => writes.filter((w) => w.path === path);
const rosterWrites = (w) => writesTo(w, 'students/roster.yml');
const assignmentWrites = (w) => writesTo(w, 'assignments/lab-3.yml');

/** Correct Nina's address through the Edit details dialog. */
async function editNinasAddress(page, to = 'nino@student.pxl.be') {
  await menuFor(page, 'Nina Peeters').click();
  await page.getByRole('menuitem', { name: /Edit details/ }).click();
  await expect(page.locator('.modal')).toBeVisible({ timeout: 10000 });
  await page.getByLabel('Email address').fill(to);
  await page.getByRole('button', { name: 'Save' }).click();
}

test.describe('66 - an address edit that would drop somebody', () => {
  test('IT ASKS, AND IT NAMES THE ASSIGNMENT', async ({ page }) => {
    await openRoster(page);
    await editNinasAddress(page);

    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible({ timeout: 10000 });
    // The assignment by its TITLE and its state, not its id - a lecturer picks
    // the assignment out of this list, and `lab-3` is the filename.
    await expect(dialog).toContainText('Lab 3');
    await expect(dialog).toContainText(assignmentStateLabel('published'));
    // Both spellings, so the change being approved is the change on screen.
    await expect(dialog).toContainText('nina@student.pxl.be');
    await expect(dialog).toContainText('nino@student.pxl.be');
    // And no roster:-prefixed identity leaks into the sentence.
    await expect(dialog).not.toContainText('email:');
  });

  test('SAYING YES CARRIES THE COHORT OVER, so she is still in it', async ({ page }) => {
    const { contentWrites } = await openRoster(page);
    await editNinasAddress(page);
    await confirmDialog(page).getByRole('button', { name: /Change it and update/ }).click();

    await expect.poll(() => assignmentWrites(contentWrites).length, { timeout: 15000 }).toBe(1);
    const written = assignmentWrites(contentWrites)[0].content;

    expect(written).toContain('email:nino@student.pxl.be');
    expect(written).not.toContain('email:nina@student.pxl.be');
    // THE OTHER STUDENT IS UNTOUCHED. A cohort rebuilt from what one screen
    // knows is how somebody nobody was thinking about disappears.
    expect(written).toContain('num:0123456');
    // And the rest of the document survives - merge, never replace.
    expect(written).toContain('repository_name_pattern');
    expect(written).toContain('deadline_at');

    expect(rosterWrites(contentWrites).length).toBe(1);
    expect(rosterWrites(contentWrites)[0].content).toContain('nino@student.pxl.be');
  });

  test('SAYING NO WRITES NOTHING AT ALL, not even the roster', async ({ page }) => {
    const { contentWrites } = await openRoster(page);
    await editNinasAddress(page);
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();

    // The question is asked BEFORE the roster write, so cancelling leaves the
    // student exactly as she was rather than half-moved.
    await page.waitForTimeout(500);
    expect(rosterWrites(contentWrites).length).toBe(0);
    expect(assignmentWrites(contentWrites).length).toBe(0);
  });

  test('a row with a student number is not re-identified, and is not asked about',
    async ({ page }) => {
      // The commonest edit by far. Alice keeps `num:0123456` whatever her
      // address says, so no cohort could have named her by the address and a
      // dialog here would be a question about nothing.
      const { contentWrites } = await openRoster(page);
      await menuFor(page, 'Alice Example').click();
      await page.getByRole('menuitem', { name: /Edit details/ }).click();
      await page.getByLabel('Email address').fill('alice.example@student.pxl.be');
      await page.getByRole('button', { name: 'Save' }).click();

      await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
      await expect(confirmDialog(page)).toHaveCount(0);
      expect(assignmentWrites(contentWrites).length).toBe(0);
    });

  test('an assignment with NO cohort is left open, never narrowed', async ({ page }) => {
    // An empty cohort means every student on the roster. Writing one onto this
    // assignment would turn "the whole course" into "the two people the roster
    // happens to hold today", which is the opposite of preserving the choice.
    const { contentWrites } = await openRoster(page, {
      assignments: { 'lab-3': assignment({ cohort: [] }) },
    });
    await editNinasAddress(page);

    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
    expect(assignmentWrites(contentWrites).length).toBe(0);
  });

  test('a DRAFT assignment is carried too - it is a cohort either way', async ({ page }) => {
    const { contentWrites } = await openRoster(page, {
      assignments: { 'lab-3': assignment({ state: 'draft' }) },
    });
    await editNinasAddress(page);
    await expect(confirmDialog(page))
      .toContainText(assignmentStateLabel('draft'), { timeout: 10000 });
    await confirmDialog(page).getByRole('button', { name: /Change it and update/ }).click();

    await expect.poll(() => assignmentWrites(contentWrites).length, { timeout: 15000 }).toBe(1);
    expect(assignmentWrites(contentWrites)[0].content).toContain('email:nino@student.pxl.be');
  });
});
