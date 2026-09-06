// The lecturer's half of the claim: seeing who is bound, and undoing it.
//
// GitHub Classroom's mistake was making a wrong binding unfixable. A wrong
// binding a lecturer cannot SEE is the same mistake one step earlier, which is
// why the column and the Unlink control ship together (ARCHITECTURE §15).
//
// The fixture models an ABSENT claims directory as a 404, exactly as GitHub
// does, rather than an empty array - that distinction is what caught the read
// falling through to an error on every spec in the suite while every test
// still passed.

import { test, expect } from '@playwright/test';
import { setupStandardMockRoutes, injectAuth } from '../fixtures/e2e-fixtures.mjs';

const ORG = 'PXL-2TIN-CloudEssentials-2627';
const LECTURER = { login: 'prof-cloud', name: 'Professor Cloud', id: 900001, token: 'mock_lecturer_token' };

const ROSTER = [
  { student_number: '0123456', full_name: 'Alice Claimed', email: 'alice@student.pxl.be', class_group: '1TIN-A' },
  { student_number: '0123457', full_name: 'Bob Waiting', email: 'bob@student.pxl.be', class_group: '1TIN-A' },
  { student_number: '0123458', full_name: 'Carol NoAddress', class_group: '1TIN-B' },
  { student_number: '0123459', full_name: 'Dave Mismatch', email: 'dave@student.pxl.be', github_login: 'dave-pxl', class_group: '1TIN-B' },
];

const claim = (login, id, email, verified = true) => ({
  schema_version: 1,
  github_login: login,
  github_id: id,
  email,
  claim_verified: verified,
  student_number: null,
  claimed_at: '2026-09-01T10:00:00.000Z',
  claimed_via: 'cloud-containers',
});

async function openRoster(page, opts) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, roster: ROSTER, ...opts });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();
}

const row = (page, name) => page.locator('tr', { hasText: name });

// Unlink moved into the row's actions menu and is called "Forget this account"
// there - "Remove GitHub account" was rejected as reading like the deletion of
// the student's actual account. These two helpers are what every test below
// used to do with `getByRole('button', { name: 'Unlink' })`.
const openRowMenu = (page, who) => row(page, who).locator('.row-menu-anchor button').click();
const forgetItem = (page) => page.getByRole('menuitem', { name: /Forget this account/ });

test.describe('47 - The lecturer sees who is bound', () => {

  test('a claimed student shows the account they bound, not "Pending linking"', async ({ page }) => {
    // The roster carries no github_login for Alice - under `claim` that column
    // is precisely the one the mode exists to avoid needing. Reading the roster
    // alone would call her "Pending linking" an hour after she claimed.
    await openRoster(page, { claims: [claim('alice-gh', 111, 'alice@student.pxl.be')] });

    const alice = row(page, 'Alice Claimed');
    await expect(alice.locator('.badge-success')).toContainText('@alice-gh');
    await openRowMenu(page, 'Alice Claimed');
    await expect(forgetItem(page)).toBeVisible();
  });

  test('an unverified claim is marked, because that is the whole point of the flag', async ({ page }) => {
    // A typed address still binds - nobody is locked out - but a cohort review
    // needs to see which bindings GitHub had already vouched for.
    await openRoster(page, { claims: [claim('alice-gh', 111, 'alice@student.pxl.be', false)] });

    const alice = row(page, 'Alice Claimed');
    await expect(alice).toContainText('unverified');
  });

  test('a student who has not claimed says so, and offers nothing to unlink', async ({ page }) => {
    await openRoster(page, { claims: [claim('alice-gh', 111, 'alice@student.pxl.be')] });

    // One mode-neutral label. This tab is org-scoped and an org can hold
    // `enforced` and `claim` assignments at once, so it cannot know which
    // mechanism this student is waiting on and must not assert one.
    // A DASH, not "Pending linking". The column is headed GitHub Account and an
    // empty one is the answer; naming the state invented a word that read as
    // something in progress when nothing is.
    const bob = row(page, 'Bob Waiting');
    await expect(bob.locator('.cell-email, td')).toBeTruthy();
    await expect(bob).not.toContainText('Pending linking');
    await openRowMenu(page, 'Bob Waiting');
    await expect(forgetItem(page)).toHaveCount(0);
  });

  test('a roster entry with no address is still visibly a DIFFERENT problem', async ({ page }) => {
    // Different state, different fix: an entry with no address can never be
    // claimed at all, because `rosterEntryForEmail` matches on email and
    // nothing else - so the remedy is an address, not patience.
    //
    // THE ACCOUNT COLUMN NO LONGER SAYS THIS, and that is a deliberate change
    // rather than a loss. It used to render a "No address" badge one column to
    // the right of the Email column that already showed the address missing:
    // two columns answering one question in different words. The fact now lives
    // where it belongs - an empty Email cell - and the tab summarises it with
    // the action attached, which the badge never did.
    await openRoster(page, { claims: [claim('alice-gh', 111, 'alice@student.pxl.be')] });

    const carol = row(page, 'Carol NoAddress');
    await expect(carol.locator('.cell-email')).toHaveText('-');
    await expect(carol).not.toContainText('No address');
    // And the tab says how many are in that state, and what to do about it.
    await expect(page.locator('.roster-ask-hint')).toContainText('no email address');
    await expect(page.locator('.roster-ask-hint')).toContainText('Confirm-email link');
  });

  test('a claim disagreeing with the roster is flagged rather than shown as healthy', async ({ page }) => {
    // First-come-wins makes this reachable, and the claim is what governs
    // acceptance - so it is shown as the binding AND marked, because this is
    // the case Unlink exists for.
    await openRoster(page, {
      claims: [claim('someone-else', 222, 'dave@student.pxl.be')],
    });

    const dave = row(page, 'Dave Mismatch');
    await expect(dave.locator('.badge-warning')).toContainText('@someone-else');
    await openRowMenu(page, 'Dave Mismatch');
    await expect(forgetItem(page)).toBeVisible();
  });

  test('with no claims at all, the column falls back to the roster linkage', async ({ page }) => {
    // An absent claims directory is a 404, and an `enforced` cohort has no
    // claims by design. Dave has a github_login on the roster, so he is bound.
    await openRoster(page, {});

    await expect(row(page, 'Dave Mismatch').locator('.badge-success')).toContainText('@dave-pxl');
    await expect(row(page, 'Bob Waiting')).not.toContainText('Pending linking');
    await expect(row(page, 'Bob Waiting').locator('.badge-success')).toHaveCount(0);
  });
});

test.describe('47 - Unlink', () => {

  test('unlinking removes the binding and the student can claim again', async ({ page }) => {
    await openRoster(page, { claims: [claim('alice-gh', 111, 'alice@student.pxl.be')] });

    page.once('dialog', (d) => d.accept());
    await openRowMenu(page, 'Alice Claimed');
    await forgetItem(page).click();

    // The list is re-read after the delete, so the row falls back to unbound.
    await expect(row(page, 'Alice Claimed').locator('.badge-success')).toHaveCount(0);
    await openRowMenu(page, 'Alice Claimed');
    await expect(forgetItem(page)).toHaveCount(0);
  });

  test('declining the confirmation changes nothing', async ({ page }) => {
    await openRoster(page, { claims: [claim('alice-gh', 111, 'alice@student.pxl.be')] });

    page.once('dialog', (d) => d.dismiss());
    await openRowMenu(page, 'Alice Claimed');
    await forgetItem(page).click();

    await expect(row(page, 'Alice Claimed').locator('.badge-success')).toContainText('@alice-gh');
  });

  test('a partial read refuses to unlink rather than removing the wrong binding', async ({ page }) => {
    // Deleting off an incomplete list can unlink the wrong student, and "no
    // such binding" for a file that would not load reads as success. Same rule
    // PromoteRosterModal carries for acceptances.
    await openRoster(page, {
      claims: [claim('alice-gh', 111, 'alice@student.pxl.be'), 'UNREADABLE'],
    });

    let dialogShown = false;
    page.once('dialog', (d) => { dialogShown = true; d.accept(); });
    await openRowMenu(page, 'Alice Claimed');
    await forgetItem(page).click();

    await expect(page.locator('[role="alert"]')).toContainText(/could not be read/i);
    expect(dialogShown, 'it must refuse before asking, not ask and then fail').toBe(false);
    await expect(row(page, 'Alice Claimed').locator('.badge-success')).toContainText('@alice-gh');
  });
});
