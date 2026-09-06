// 65 - The roster row's own actions, and the words this tab uses.
//
// Editing a roster row used to be discoverable only by clicking the "-" in an
// empty cell. Reported by the lecturer running it as "really, really
// confusing", and rightly: a dash reads as punctuation, not a control, and
// hover is not discoverable either - the same lesson the resting dotted
// underline was written for, applied to a cell that has no text to underline.
//
// So the row grew a menu. Clicking a cell still works and is still the fast way
// to fix one value, including the one that opens pre-filled with an address read
// off a student's commits; the menu is how you find out that you can.
//
// It also gave the OTHER two actions somewhere to live. Unlink was a bare red
// button that only appeared for a row with a claim, so most rows had an empty
// column and no actions at all, and removing one student was possible only by
// exporting a CSV, deleting a line and importing it back.
//
// The wording is tested here too. Ten terms were in use on this tab - linked,
// unlinked, pending linking, claimed, unclaimable, no address, conflict,
// unverified, promoted, from commits - for what are really two questions the
// column headings already ask: do we know their GitHub account, and do we have
// their email. Most of that vocabulary was the model's words leaking out.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
import { PROMOTED_SOURCE } from '../../lib/roster-entries.mjs';

// A promoted row that knows nothing, one the harvest has filled in, and an
// ordinary imported student. Enough for every branch the menu has.
const ROSTER = [
  { github_login: 'afx42', source: PROMOTED_SOURCE },
  {
    github_login: 'LowieSerneelsPXL',
    email: 'lowie.serneels@student.pxl.be',
    email_source: 'commit',
    source: PROMOTED_SOURCE,
  },
  { student_number: '0123456', full_name: 'Alice Example', email: 'alice@student.pxl.be', class_group: '3A' },
];

async function openRoster(page, { roster = ROSTER, claims = undefined, assignments = {} } = {}) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments, roster, contentWrites, claims });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();
  await expect(page.locator('.roster-table')).toBeVisible({ timeout: 15000 });
  return { contentWrites };
}

const row = (page, who) => page.locator('.roster-table tr', { hasText: who });
const menuFor = (page, who) => row(page, who).locator('.row-menu-anchor button');
const rosterWrites = (writes) => writes.filter((w) => w.path === 'students/roster.yml');
const item = (page, name) => page.getByRole('menuitem', { name });

// ============================================================== the menu

test.describe('65 - the row menu', () => {
  test('EDITING HAS SOMEWHERE TO BE FOUND, which a dash was not', async ({ page }) => {
    await openRoster(page);
    await menuFor(page, 'afx42').click();
    await expect(item(page, /Edit details/)).toBeVisible();
    await expect(item(page, /Remove from roster/)).toBeVisible();
  });

  test('every action says what it does, under its own name', async ({ page }) => {
    // A destructive action a lecturer has to guess at is how somebody removes
    // the wrong thing.
    await openRoster(page);
    await menuFor(page, 'afx42').click();
    const menu = page.locator('.row-menu');
    await expect(menu).toContainText('saved in one go');
    await expect(menu).toContainText('repository and their work are untouched');
  });

  test('the menu is NOT clipped by the table scroller', async ({ page }) => {
    // `.roster-table-wrapper` is `overflow-x: auto`, and a box that is not
    // `visible` on one axis computes to `auto` on the other - so it clips
    // vertically as well, and an absolutely positioned panel inside it was cut
    // off after its first item. Measured, because it was invisible until a
    // screenshot showed the third item missing.
    await openRoster(page);
    await menuFor(page, 'afx42').click();
    const menu = page.locator('.row-menu');
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    const wrapper = await page.locator('.roster-table-wrapper').boundingBox();
    expect(
      box.y + box.height,
      'the menu is taller than the scroller can show, so it must escape it',
    ).toBeGreaterThan(wrapper.y + wrapper.height - 1);
    expect(box.y + box.height, 'and it still has to be on screen').toBeLessThanOrEqual(
      page.viewportSize().height,
    );
  });

  test('only one row menu is open at a time', async ({ page }) => {
    // An open menu covers the rows under it, which is what a dropdown does - so
    // a real user dismisses it before opening another, and that is the sequence
    // tested. Clicking straight through would be testing Playwright's ability
    // to reach a covered element, not the app.
    await openRoster(page);
    await menuFor(page, 'afx42').click();
    await expect(page.locator('.row-menu')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await menuFor(page, 'Alice Example').click();
    await expect(page.locator('.row-menu')).toHaveCount(1);
  });

  test('Escape closes it', async ({ page }) => {
    await openRoster(page);
    await menuFor(page, 'afx42').click();
    await expect(page.locator('.row-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.row-menu')).toHaveCount(0);
  });

  test('opening it closes an open cell edit', async ({ page }) => {
    // Two editors over one row, each built by spreading the roster as it was
    // when it opened, is a lost update waiting to happen.
    await openRoster(page);
    await row(page, 'afx42').locator('.cell-full_name').click();
    await expect(page.locator('.cell-edit')).toBeVisible();
    await menuFor(page, 'afx42').click();
    await item(page, /Edit details/).click();
    await expect(page.locator('.cell-edit')).toHaveCount(0);
  });

  test('FORGET THIS ACCOUNT appears only where there is a link to forget', async ({ page }) => {
    // A menu item that cannot act is worse than an absent one. None of these
    // rows carries a claim, so none of them offers it.
    await openRoster(page);
    await menuFor(page, 'afx42').click();
    await expect(item(page, /Forget this account/)).toHaveCount(0);
  });

  test('...and it never says "remove GitHub account"', async ({ page }) => {
    // Which reads as deleting the student's actual GitHub account. It deletes
    // our record of which account they are, and nothing else - the difference
    // between a shrug and a heart attack.
    await openRoster(page);
    await menuFor(page, 'afx42').click();
    await expect(page.locator('.row-menu')).not.toContainText(/remove .*github account/i);
  });
});

// ============================================================= the dialog

test.describe('65 - editing a student in one go', () => {
  async function openDialog(page, who = 'afx42', opts) {
    const ctx = await openRoster(page, opts);
    await menuFor(page, who).click();
    await item(page, /Edit details/).click();
    await expect(page.locator('.modal')).toBeVisible({ timeout: 10000 });
    return ctx;
  }

  test('THE DIALOG WRITES ONCE, where four cells wrote four times', async ({ page }) => {
    // Identifying a promoted row is a number, a name and an address. Cell by
    // cell that is three commits to roster.yml within seconds of each other -
    // and GitHub's Contents API answered the second of those with a stale sha
    // on PXL-Automation-II, refusing the write with two hashes and no verb.
    const { contentWrites } = await openDialog(page);

    await page.getByLabel('Student number').fill('0123456');
    await page.getByLabel('Name').fill('Maarten Example');
    await page.getByLabel('Email address').fill('maarten@student.pxl.be');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
    const yaml = rosterWrites(contentWrites)[0].content;
    expect(yaml).toContain('0123456');
    expect(yaml).toContain('Maarten Example');
    expect(yaml).toContain('maarten@student.pxl.be');
    // Two of the three rows carry a login; Alice was imported from a CSV and
    // has none. The count is what catches a merge that drops or duplicates a row.
    expect((yaml.match(/github_login/g) || []).length).toBe(2, 'no row lost, none duplicated');
    expect((yaml.match(/- /g) || []).length).toBeGreaterThanOrEqual(3);
  });

  test('it opens on what is stored, not on blanks', async ({ page }) => {
    await openDialog(page, 'Alice Example');
    await expect(page.getByLabel('Student number')).toHaveValue('0123456');
    await expect(page.getByLabel('Name')).toHaveValue('Alice Example');
    await expect(page.getByLabel('Email address')).toHaveValue('alice@student.pxl.be');
    await expect(page.getByLabel('Class group')).toHaveValue('3A');
  });

  test('Save is refused until something differs', async ({ page }) => {
    // Otherwise it writes a commit that changes nothing and reports success.
    await openDialog(page);
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await page.getByLabel('Name').fill('Anything');
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  test('CANCEL LEAVES THE ROW EXACTLY AS IT WAS', async ({ page }) => {
    // The dialog edits a local copy. Writing through to the row would change
    // the rendered roster before anything was committed, so cancelling would
    // leave the table showing an edit that never happened.
    const { contentWrites } = await openDialog(page);
    await page.getByLabel('Name').fill('Never Saved');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(400);
    expect(rosterWrites(contentWrites)).toHaveLength(0);
    await expect(row(page, 'afx42')).not.toContainText('Never Saved');
  });

  test('emptying a field removes it rather than storing an empty string', async ({ page }) => {
    // student_number and full_name declare minLength: 1, so "" is a document
    // the schema rejects.
    const { contentWrites } = await openDialog(page, 'Alice Example');
    await page.getByLabel('Class group').fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
    expect(rosterWrites(contentWrites)[0].content).not.toContain('class_group');
  });

  test('changing the address clears the provenance marker', async ({ page }) => {
    // `email_source` describes the address beside it. A person typing here
    // outranks a claim and a commit, so a stale marker would be confidently
    // wrong about where the new value came from.
    const { contentWrites } = await openDialog(page, 'LowieSerneelsPXL');
    await page.getByLabel('Email address').fill('lowie@student.pxl.be');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
    expect(rosterWrites(contentWrites)[0].content).not.toContain('email_source');
  });

  test('THE DIALOG OFFERS THE SAME SUGGESTION THE CELL DOES', async ({ page }) => {
    // The cell has opened pre-filled since the harvest shipped: click the Email
    // cell for a student whose commits carry a typo'd address and it is there,
    // two characters from correct. The dialog was added BECAUSE clicking a dash
    // was not discoverable - so the route somebody finds offering less than the
    // route nobody could find was exactly the wrong way round.
    const REPORT = {
      schema_version: 1,
      assignment_id: 'exam',
      students: [
        { github_login: 'afx42', commit_count: 1, author_name: 'maarten', author_email: null },
        { github_login: 'rayaneW', commit_count: 4, author_name: 'rayaneW', author_email: 'rayane.waddah@student.pxl' },
      ],
    };
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
      roster: [
        { github_login: 'afx42', source: PROMOTED_SOURCE },
        { github_login: 'rayaneW', source: PROMOTED_SOURCE },
      ],
    });
    await page.route('**/contents/reports', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ name: 'exam.json', type: 'file' }]) }));
    await page.route('**/contents/reports/exam.json*', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: b64(REPORT), encoding: 'base64' }) }));
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();
    await expect(page.locator('.harvest-hint').first()).toBeVisible({ timeout: 15000 });

    await menuFor(page, 'rayaneW').click();
    await item(page, /Edit details/).click();
    await expect(page.getByLabel('Email address')).toHaveValue('rayane.waddah@student.pxl');
    // Flagged, because nobody has vouched for it - the same treatment the cell
    // gives it, so the two routes do not disagree about what it is.
    await expect(page.getByLabel('Email address')).toHaveClass(/suggested/);
    await expect(page.locator('.modal')).toContainText('Nobody has confirmed it');

    // A NAME, on the row whose commits carry one and no address.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await menuFor(page, 'afx42').click();
    await item(page, /Edit details/).click();
    await expect(page.getByLabel('Name')).toHaveValue('maarten');
    await expect(page.getByLabel('Email address')).toHaveValue('');
  });

  test('...but a stored value is never replaced by one', async ({ page }) => {
    await openDialog(page, 'LowieSerneelsPXL');
    await expect(page.getByLabel('Email address')).toHaveValue('lowie.serneels@student.pxl.be');
    await expect(page.getByLabel('Email address')).not.toHaveClass(/suggested/);
  });

  test('it says the account is not typed here, rather than hiding it', async ({ page }) => {
    // Leaving the field out silently sends a lecturer hunting for it.
    await openDialog(page);
    await expect(page.locator('.modal')).toContainText('never typed here');
  });
});

// =========================================================== the wording

test.describe('65 - what this tab calls things', () => {
  test('THE ACCOUNT COLUMN ANSWERS ITS OWN QUESTION, and invents no noun', async ({ page }) => {
    // "Pending linking" read as something in progress when nothing is, and
    // "No address" answered the Email column's question one column to its left.
    // The heading already asks; an empty cell is the answer.
    await openRoster(page);
    const table = page.locator('.roster-table');
    await expect(table).not.toContainText('Pending linking');
    await expect(table).not.toContainText('No address');
  });

  test('the filters ask whether we know the account, in those words', async ({ page }) => {
    await openRoster(page);
    await expect(page.getByRole('button', { name: /Has account/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /No account yet/ })).toBeVisible();
    await expect(page.locator('.chip-btn', { hasText: /^Unlinked/ })).toHaveCount(0);
  });

  test('and so does the copy button', async ({ page }) => {
    await openRoster(page);
    await expect(page.getByRole('button', { name: /Copy emails with no account/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Copy unlinked emails/ })).toHaveCount(0);
  });
});

test.describe('65 - the hint under the table tells the truth', () => {
  test('with an assignment published, it points at the link', async ({ page }) => {
    await openRoster(page, {
      assignments: {
        live: { id: 'live', title: 'Live', organization: ORG, state: 'published', assignment_type: 'individual' },
      },
    });
    await expect(page.locator('.roster-ask-hint')).toContainText('every published assignment has a');
  });

  test('WITH NOTHING PUBLISHED IT DOES NOT NAME A CONTROL THAT IS NOT THERE', async ({ page }) => {
    // The confirm-email link is minted per assignment, so an organization with
    // nothing published has none to copy - and "every published assignment has
    // a Confirm-email link" then sends a lecturer hunting for a control that
    // does not exist. DESIGN.md 1.5, from the direction where the sentence is
    // true of the system in general and false of the screen in front of them.
    await openRoster(page, { assignments: {} });
    const hint = page.locator('.roster-ask-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('publish an assignment');
    await expect(hint).not.toContainText('every published assignment has a');
  });

  test('a draft does not count as published', async ({ page }) => {
    await openRoster(page, {
      assignments: {
        d: { id: 'd', title: 'Draft', organization: ORG, state: 'draft', assignment_type: 'individual' },
      },
    });
    await expect(page.locator('.roster-ask-hint')).toContainText('publish an assignment');
  });
});
