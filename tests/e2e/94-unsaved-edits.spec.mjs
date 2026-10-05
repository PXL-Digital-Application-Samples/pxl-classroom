// 94 - Edits nobody has saved yet: said on screen, and never lost or written
// behind the lecturer's back.
//
// Asked 2026-10-03, when Settings became a tab of the assignment page: "if you
// move away from editing, I don't know what to do then. Is it saved? Is there
// an unsaved status?" Every way off the form was walked through. Three did the
// wrong thing: signing out cleared the sign-in BEFORE asking about the edits,
// so Cancel left the lecturer signed out over edits they could no longer save;
// a state change from the header saved the edits along with the state, behind
// a confirm that asked only about the state; and Regenerate link cleared the
// old link in the form, so an untouched form read as edited. And nothing on
// screen said whether what was there was saved.
//
// "Draft" is not the answer to that question: a draft is a SAVED assignment
// that students cannot open yet. Unsaved edits exist in this tab only.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, chooseState, inviteToken } from '../fixtures/e2e-fixtures.mjs';

const ID = 'pe-unsaved';
const TITLE = 'Unsaved Edits PE';

const assignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: TITLE,
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 100,
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 10 * 86400_000).toISOString(),
  template: { owner: ORG, repository: 'linux-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  invite_key: inviteToken(ORG, ID),
  invite_nonce: '0badc0de',
  ...over,
});

async function openSettings(page, asgn = assignment()) {
  const writes = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: asgn },
    userRepos: [{ name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}` }],
    contentWrites: writes,
  });
  await page.goto(`/dashboard/${ORG}/${ID}?tab=settings`);
  await expect(titleBox(page)).toHaveValue(TITLE, { timeout: 15000 });
  return writes;
}

const titleBox = (page) => page.getByPlaceholder('e.g. Linux Processes 2026');
const note = (page) => page.locator('.editor-action-bar [data-unsaved]');
const settingsTab = (page) => page.locator('.assignment-tabs .primer-tab', { hasText: 'Settings' });
const tabDot = (page) => settingsTab(page).locator('.status-dot');
const courseView = (page, name) =>
  page.getByRole('navigation', { name: 'Course views' }).getByRole('link', { name });
const assignmentWrites = (writes) => writes.filter((w) => w.path === `assignments/${ID}.yml`);

test.describe('94 - what the screen says about unsaved edits', () => {
  test('a saved form says nothing; an edit says so in the bar and on the tab', async ({ page }) => {
    await openSettings(page);
    await expect(note(page)).toHaveCount(0);
    await expect(tabDot(page)).toHaveCount(0);

    await titleBox(page).fill(`${TITLE} v2`);
    await expect(note(page)).toHaveText('Unsaved changes');
    await expect(tabDot(page)).toBeVisible();

    // Put back by hand is nothing to save.
    await titleBox(page).fill(TITLE);
    await expect(note(page)).toHaveCount(0);
    await expect(tabDot(page)).toHaveCount(0);
  });

  test('a look at Progress keeps the edit, and the dot says it is waiting', async ({ page }) => {
    await openSettings(page);
    await titleBox(page).fill(`${TITLE} v2`);

    await page.locator('.assignment-tabs .primer-tab', { hasText: 'Progress' }).click();
    await expect(page).toHaveURL(new RegExp(`/${ID}$`));
    await expect(tabDot(page), 'visible from the other tab').toBeVisible();

    await settingsTab(page).click();
    await expect(titleBox(page)).toHaveValue(`${TITLE} v2`);
  });

  test('Save clears it', async ({ page }) => {
    const writes = await openSettings(page);
    await titleBox(page).fill(`${TITLE} v2`);
    await page.locator('.editor-action-bar').getByRole('button', { name: /^Save$/ }).click();
    await expect.poll(() => assignmentWrites(writes).length, { timeout: 15000 }).toBeGreaterThan(0);
    await expect(note(page)).toHaveCount(0);
    await expect(tabDot(page)).toHaveCount(0);
  });

  test('Cancel asks, then puts the stored values back', async ({ page }) => {
    await openSettings(page);
    await titleBox(page).fill(`${TITLE} v2`);
    page.once('dialog', (d) => d.accept());
    await page.locator('.editor-action-bar').getByRole('button', { name: 'Cancel' }).click();
    await expect(titleBox(page)).toHaveValue(TITLE);
    await expect(note(page)).toHaveCount(0);
  });

  test('Regenerate link is not an edit', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: /Invite link/ }).click();
    await page.locator('.invite-menu .dropdown-item-title', { hasText: /^Regenerate link/ }).click();
    await page.getByRole('button', { name: 'Republish and retire the old link' }).click();
    await expect(page.locator('.toast', { hasText: /Regenerating/ })).toBeVisible({ timeout: 15000 });

    await expect(note(page)).toHaveCount(0);
    await expect(tabDot(page)).toHaveCount(0);
    // And leaving asks nothing, because there is nothing to discard.
    let asked = false;
    page.on('dialog', (d) => { asked = true; d.accept(); });
    await courseView(page, 'Roster').click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/roster`));
    expect(asked).toBe(false);
  });
});

test.describe('94 - leaving with unsaved edits', () => {
  test('to another view of the organization: asked, and No stays with the edit', async ({ page }) => {
    await openSettings(page);
    await titleBox(page).fill(`${TITLE} v2`);

    page.once('dialog', (d) => d.dismiss());
    await courseView(page, 'Roster').click();
    await expect(page).toHaveURL(new RegExp(`/${ID}\\?tab=settings$`));
    await expect(titleBox(page)).toHaveValue(`${TITLE} v2`);

    page.once('dialog', (d) => d.accept());
    await courseView(page, 'Roster').click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/roster`));
  });

  test('signing out: asked FIRST, and No leaves the lecturer signed in with the edit', async ({ page }) => {
    await openSettings(page);
    await titleBox(page).fill(`${TITLE} v2`);

    page.once('dialog', (d) => d.dismiss());
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' }), 'still signed in').toBeVisible();
    await expect(titleBox(page)).toHaveValue(`${TITLE} v2`);
    expect(await page.evaluate(() => !!localStorage.getItem('pxl_auth')), 'the sign-in is still stored').toBe(true);

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: /Sign in with GitHub/i })).toBeVisible({ timeout: 15000 });
  });

  test('a state change refuses rather than saving the edits with it', async ({ page }) => {
    const writes = await openSettings(page);
    await titleBox(page).fill(`${TITLE} v2`);

    let asked = false;
    page.on('dialog', (d) => { asked = true; d.accept(); });
    await chooseState(page, 'Stop accepting');
    await expect(page.locator('.toast', { hasText: 'You have unsaved changes in Settings' })).toBeVisible({ timeout: 15000 });
    expect(asked, 'not asked about closing: nothing is going to happen').toBe(false);
    expect(assignmentWrites(writes)).toHaveLength(0);
    await expect(titleBox(page)).toHaveValue(`${TITLE} v2`);
    await expect(page.locator('[data-state-menu]')).toContainText('Accepting');
  });

  test('from Progress, the same: it lands on Settings and says why nothing happened', async ({ page }) => {
    const writes = await openSettings(page);
    await titleBox(page).fill(`${TITLE} v2`);
    await page.locator('.assignment-tabs .primer-tab', { hasText: 'Progress' }).click();

    await chooseState(page, 'Stop accepting');
    await expect(page.locator('.toast', { hasText: 'You have unsaved changes in Settings' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.assignment-tabs [aria-current="page"]')).toContainText('Settings');
    expect(assignmentWrites(writes)).toHaveLength(0);
  });

  test('with nothing edited, a state change goes ahead as before', async ({ page }) => {
    const writes = await openSettings(page);
    page.once('dialog', (d) => d.accept());
    await chooseState(page, 'Stop accepting');
    await expect.poll(() => assignmentWrites(writes).length, { timeout: 15000 }).toBeGreaterThan(0);
  });
});

test.describe('94 - a new assignment', () => {
  test('says it is not saved yet, and leaving with something typed asks', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}/new`);
    await expect(titleBox(page)).toBeVisible({ timeout: 15000 });
    await expect(note(page)).toHaveText('Not saved yet');

    await titleBox(page).fill('Half-typed');
    page.once('dialog', (d) => d.dismiss());
    await courseView(page, 'Roster').click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/new`));
    await expect(titleBox(page)).toHaveValue('Half-typed');
  });
});
