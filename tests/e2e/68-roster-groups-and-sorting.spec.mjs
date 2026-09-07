// 68 - Putting students in a class group without doing it one cell at a time.
//
// Reported by the lecturer running this: "extremely slow and annoying... I have
// to click the group each time, fill it in. It takes a significant time for it
// to write." Two separate costs sitting on top of each other. The clicking is
// one, and the writing is the other and the worse one: a cell edit is a commit
// to roster.yml, so twenty students is twenty commits to one file seconds
// apart - which is how GitHub's Contents API came to answer with a stale sha on
// PXL-Automation-II, the same failure RosterStudentModal exists to avoid.
//
// So the fix is a selection and ONE write, not a faster cell editor.
//
// Two smaller things came with it. Nothing on this tab sorted, so "which of my
// students are in 3A" meant reading the whole list. And `student_number` is no
// longer required of an imported row - most institutions hand a lecturer
// addresses - so on those rosters the Number column is a permanently empty
// prompt for a value nobody has.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
import { parse as parseYaml } from 'yaml';

/** Nobody here has a student number: the ordinary shape under roster_mode claim. */
const NO_NUMBERS = [
  { full_name: 'Cara Janssens', email: 'cara@student.pxl.be' },
  { full_name: 'Alice Example', email: 'alice@student.pxl.be', github_login: 'alice-dev' },
  { full_name: 'Bram Peeters', email: 'bram@student.pxl.be', class_group: '3B' },
];

const WITH_NUMBER = [
  ...NO_NUMBERS,
  { full_name: 'Dries Coppens', student_number: '0123456', email: 'dries@student.pxl.be' },
];

async function openRoster(page, roster = NO_NUMBERS) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, roster, contentWrites });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();
  await expect(page.locator('.roster-table')).toBeVisible({ timeout: 15000 });
  return { contentWrites };
}

const row = (page, who) => page.locator('.roster-table tbody tr', { hasText: who });
const tick = (page, who) => row(page, who).locator('input[type="checkbox"]');
const bar = (page) => page.locator('.bulk-bar');
const rosterWrites = (w) => w.filter((x) => x.path === 'students/roster.yml');
const header = (page, name) => page.locator('.roster-table thead th', { hasText: name });

/** The names in the order the table currently shows them. */
const shownNames = (page) =>
  page.locator('.roster-table tbody tr td:nth-child(2)').allTextContents();

test.describe('68 - one write for a whole class group', () => {
  test('THE POINT: many students, ONE commit', async ({ page }) => {
    const { contentWrites } = await openRoster(page);
    await tick(page, 'Cara Janssens').check();
    await tick(page, 'Alice Example').check();

    await expect(bar(page)).toContainText('2 selected');
    await page.locator('#bulk-group').fill('3A');
    await bar(page).getByRole('button', { name: 'Apply' }).click();

    // ONE. Not two, which is what a cell edit apiece would have been.
    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);

    const doc = parseYaml(rosterWrites(contentWrites)[0].content);
    const byName = Object.fromEntries(doc.students.map((s) => [s.full_name, s]));
    expect(byName['Cara Janssens'].class_group).toBe('3A');
    expect(byName['Alice Example'].class_group).toBe('3A');
    // MERGE, NEVER REPLACE: the row that was not selected keeps its own group,
    // and a field this tab never rendered survives the write.
    expect(byName['Bram Peeters'].class_group).toBe('3B');
    expect(byName['Alice Example'].github_login).toBe('alice-dev');
  });

  test('the bar is not there until something is selected', async ({ page }) => {
    // A bar explaining what it would do if you had selected something is a
    // control that decides nothing.
    await openRoster(page);
    await expect(bar(page)).toHaveCount(0);
    await tick(page, 'Cara Janssens').check();
    await expect(bar(page)).toBeVisible();
  });

  test('Apply is refused while the group box is empty', async ({ page }) => {
    const { contentWrites } = await openRoster(page);
    await tick(page, 'Cara Janssens').check();
    await expect(bar(page).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(rosterWrites(contentWrites).length).toBe(0);
  });

  test('select all takes the FILTER, not the roster', async ({ page }) => {
    // The same rule the cohort picker follows. Two of these three have no
    // GitHub account.
    await openRoster(page);
    await page.locator('.chip-btn', { hasText: 'No account yet' }).click();
    await page.locator('.roster-table thead input[type="checkbox"]').check();
    await expect(bar(page)).toContainText('2 selected');
  });

  test('a selection survives changing the filter - "3A plus these two"', async ({ page }) => {
    // Assembling a group means moving between filters, so a selection that
    // emptied itself on every chip click would make the common case impossible.
    await openRoster(page);
    await tick(page, 'Alice Example').check();
    await page.locator('.chip-btn', { hasText: 'No account yet' }).click();
    await expect(bar(page)).toContainText('1 selected');
    await tick(page, 'Cara Janssens').check();
    await expect(bar(page)).toContainText('2 selected');
  });

  test('A SELECTION IS NEVER INVISIBLE: hidden rows are counted, and reachable', async ({ page }) => {
    // The sharpest defect the UX review found. Selecting two students and then
    // switching filters showed "2 selected" over two DIFFERENT rows - the ones
    // the filter admitted - so the rows on screen read as the ones about to
    // change, and Apply would have moved two students the lecturer could not
    // see. Neither half of this is decoration: the count says they exist, the
    // chip is how you look at them.
    await openRoster(page);
    await tick(page, 'Cara Janssens').check();   // no account
    await tick(page, 'Bram Peeters').check();    // no account
    await page.locator('.chip-btn', { hasText: 'Has account' }).click();

    await expect(bar(page)).toContainText('2 selected');
    await expect(bar(page)).toContainText('2 not shown by this filter');

    await page.locator('.chip-btn', { hasText: 'Selected (2)' }).click();
    expect(await shownNames(page)).toEqual(['Cara Janssens', 'Bram Peeters']);
    await expect(bar(page)).not.toContainText('not shown by this filter');
  });

  test('the header box is indeterminate when only some rows are ticked', async ({ page }) => {
    await openRoster(page);
    const head = page.locator('.roster-table thead input[type="checkbox"]');
    await expect(head).not.toBeChecked();

    await tick(page, 'Cara Janssens').check();
    expect(await head.evaluate((el) => el.indeterminate)).toBe(true);

    await page.locator('.roster-table thead input[type="checkbox"]').check();
    await expect(head).toBeChecked();
    expect(await head.evaluate((el) => el.indeterminate)).toBe(false);
  });

  test('clearing the selection does not strand the view on a chip that is gone', async ({ page }) => {
    // The Selected chip only exists while something is selected, so a filter
    // still pointing at it would be an empty table with no way back.
    await openRoster(page);
    await tick(page, 'Cara Janssens').check();
    await page.locator('.chip-btn', { hasText: 'Selected (1)' }).click();
    await bar(page).getByRole('button', { name: 'Clear selection' }).click();

    await expect(page.locator('.chip-btn', { hasText: 'Selected' })).toHaveCount(0);
    expect((await shownNames(page)).length).toBe(3);
  });

  test('one solid button on screen, before and after selecting', async ({ page }) => {
    // DESIGN.md 1.2. The bar takes the primary while it is up, so `+ Add
    // student` steps down rather than sitting beside it.
    await openRoster(page);
    await expect(page.getByRole('button', { name: '+ Add student' })).toHaveClass(/btn-primary/);

    await tick(page, 'Cara Janssens').check();
    await expect(page.getByRole('button', { name: '+ Add student' })).not.toHaveClass(/btn-primary/);
    await expect(bar(page).getByRole('button', { name: 'Apply' })).toHaveClass(/btn-primary/);
  });
});

test.describe('68 - the flow the whole thing exists for', () => {
  const MIXED = [
    { full_name: 'Alice Example', email: 'a@x.be', class_group: '3A' },
    { full_name: 'Bram Peeters', email: 'b@x.be', class_group: '3A' },
    { full_name: 'Cara Janssens', email: 'c@x.be' },
    { full_name: 'Dries Coppens', email: 'd@x.be' },
  ];

  test('EVERYONE WITH NO GROUP, IN FOUR CLICKS', async ({ page }) => {
    // The flow the bulk bar exists for, and the one it could not do until the
    // chips landed: sorting clustered the ungrouped at the bottom, but
    // select-all-shown takes the FILTER, so it took the whole roster. Forty
    // students meant forty ticks.
    const { contentWrites } = await openRoster(page, MIXED);
    await page.locator('.chip-btn', { hasText: 'No group (2)' }).click();
    await page.locator('.roster-table thead input[type="checkbox"]').check();
    await expect(bar(page)).toContainText('2 selected');

    await page.locator('#bulk-group').fill('3B');
    await bar(page).getByRole('button', { name: 'Apply' }).click();

    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
    const doc = parseYaml(rosterWrites(contentWrites)[0].content);
    const byName = Object.fromEntries(doc.students.map((s) => [s.full_name, s]));
    expect(byName['Cara Janssens'].class_group).toBe('3B');
    expect(byName['Dries Coppens'].class_group).toBe('3B');
    // And the class that was already grouped is untouched.
    expect(byName['Alice Example'].class_group).toBe('3A');
  });

  test('a whole class moves to another group the same way', async ({ page }) => {
    const { contentWrites } = await openRoster(page, MIXED);
    await page.locator('.chip-btn', { hasText: '3A (2)' }).click();
    await page.locator('.roster-table thead input[type="checkbox"]').check();
    await page.locator('#bulk-group').fill('3C');
    await bar(page).getByRole('button', { name: 'Apply' }).click();

    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
    const doc = parseYaml(rosterWrites(contentWrites)[0].content);
    expect(doc.students.filter((s) => s.class_group === '3C')).toHaveLength(2);
  });

  test('REMOVE FROM GROUP deletes the key, and is its own button', async ({ page }) => {
    // Never "leave the box empty and press Apply": a mistyped-then-deleted
    // group would silently wipe the group off everyone selected, and the two
    // gestures read identically right up until they happen.
    const { contentWrites } = await openRoster(page, MIXED);
    await tick(page, 'Alice Example').check();
    await bar(page).getByRole('button', { name: 'Remove from group' }).click();

    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
    const doc = parseYaml(rosterWrites(contentWrites)[0].content);
    const alice = doc.students.find((s) => s.full_name === 'Alice Example');
    // ABSENT, not "". The schema distinguishes them everywhere else, and an
    // empty spelling would be offered to rosterClassGroups to deduplicate.
    expect('class_group' in alice).toBe(false);
    expect(doc.students.find((s) => s.full_name === 'Bram Peeters').class_group).toBe('3A');
  });

  test('an empty box still does nothing - Apply stays disabled', async ({ page }) => {
    const { contentWrites } = await openRoster(page, MIXED);
    await tick(page, 'Alice Example').check();
    await page.locator('#bulk-group').fill('   ');
    await expect(bar(page).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(rosterWrites(contentWrites).length).toBe(0);
  });

  test('a filter may not outlive its chip', async ({ page }) => {
    // Filter to 3A, move everyone out of it, and the chip is gone while the
    // filter still names it: an empty table with nothing highlighted and no way
    // back except guessing.
    await openRoster(page, MIXED);
    await page.locator('.chip-btn', { hasText: '3A (2)' }).click();
    await page.locator('.roster-table thead input[type="checkbox"]').check();
    await page.locator('#bulk-group').fill('3C');
    await bar(page).getByRole('button', { name: 'Apply' }).click();

    await expect(page.locator('.chip-btn', { hasText: '3C (2)' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.chip-btn', { hasText: '3A' })).toHaveCount(0);
    // Fell back to All rather than sitting on a filter nothing matches.
    await expect(page.locator('.chip-btn', { hasText: 'All' })).toHaveClass(/active/);
    expect((await shownNames(page)).length).toBe(4);
  });

  test('no chips at all until the org uses groups', async ({ page }) => {
    // A roster with no groups would otherwise get a lone "No group (3)" beside
    // "All (3)" - two controls filtering to the same set. "All" IS the filter
    // for picking everybody into the first group.
    await openRoster(page, [
      { full_name: 'Cara Janssens', email: 'c@x.be' },
      { full_name: 'Dries Coppens', email: 'd@x.be' },
    ]);
    await expect(page.locator('.chip-btn', { hasText: 'No group' })).toHaveCount(0);
    await expect(page.locator('.chip-btn', { hasText: 'All (2)' })).toBeVisible();

    // And "All" genuinely does the job for the first group.
    await page.locator('.roster-table thead input[type="checkbox"]').check();
    await expect(bar(page)).toContainText('2 selected');
  });
});

test.describe('68 - sorting, which nothing on this tab did', () => {
  test('clicking Group orders by it, and again reverses', async ({ page }) => {
    await openRoster(page, [
      { full_name: 'Cara Janssens', email: 'c@x.be', class_group: '3B' },
      { full_name: 'Alice Example', email: 'a@x.be', class_group: '3A' },
      { full_name: 'Bram Peeters', email: 'b@x.be', class_group: '12A' },
    ]);
    await header(page, 'Group').click();
    // `numeric` collation, so 3A sorts before 12A rather than after it.
    expect(await shownNames(page)).toEqual(['Alice Example', 'Cara Janssens', 'Bram Peeters']);
    await header(page, 'Group').click();
    expect(await shownNames(page)).toEqual(['Bram Peeters', 'Cara Janssens', 'Alice Example']);
  });

  test('students with no group sort LAST in both directions', async ({ page }) => {
    // "The ones with no group" is a group of its own and belongs at the end,
    // not interleaved at the top of a descending sort - it is the population a
    // lecturer is looking for when they sort by group at all.
    // Exactly ONE student without a group, so "last" has a single answer.
    await openRoster(page, [
      { full_name: 'Cara Janssens', email: 'c@x.be' },
      { full_name: 'Alice Example', email: 'a@x.be', class_group: '3A' },
      { full_name: 'Bram Peeters', email: 'b@x.be', class_group: '3B' },
    ]);
    await header(page, 'Group').click();
    expect(await shownNames(page)).toEqual(['Alice Example', 'Bram Peeters', 'Cara Janssens']);
    await header(page, 'Group').click();
    expect(await shownNames(page)).toEqual(['Bram Peeters', 'Alice Example', 'Cara Janssens']);
  });

  test('sorting is a VIEW: it never rewrites the stored order', async ({ page }) => {
    // `students` in roster.yml is the order the file was written in, and every
    // diff and import reads it. A sort that reordered the document would be a
    // view control silently committing.
    const { contentWrites } = await openRoster(page);
    await header(page, 'Name').click();
    await header(page, 'Email').click();
    expect(rosterWrites(contentWrites).length).toBe(0);

    // And a write made after sorting still carries the stored order.
    await tick(page, 'Cara Janssens').check();
    await page.locator('#bulk-group').fill('3A');
    await bar(page).getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => rosterWrites(contentWrites).length, { timeout: 10000 }).toBe(1);
    const doc = parseYaml(rosterWrites(contentWrites)[0].content);
    expect(doc.students.map((s) => s.full_name))
      .toEqual(['Cara Janssens', 'Alice Example', 'Bram Peeters']);
  });

  test('the sorted column says so, for a screen reader too', async ({ page }) => {
    await openRoster(page);
    await expect(header(page, 'Group')).toHaveAttribute('aria-sort', 'none');
    await header(page, 'Group').click();
    await expect(header(page, 'Group')).toHaveAttribute('aria-sort', 'ascending');
    await header(page, 'Group').click();
    await expect(header(page, 'Group')).toHaveAttribute('aria-sort', 'descending');
    // And only one column is ever the sorted one.
    await expect(header(page, 'Name')).toHaveAttribute('aria-sort', 'none');
  });
});

test.describe('68 - the Number column', () => {
  test('is gone when nobody has a number', async ({ page }) => {
    await openRoster(page);
    await expect(page.locator('.roster-table thead th', { hasText: 'Number' })).toHaveCount(0);
  });

  test('is back the moment one student has one', async ({ page }) => {
    await openRoster(page, WITH_NUMBER);
    await expect(page.locator('.roster-table thead th', { hasText: 'Number' })).toHaveCount(1);
    await expect(row(page, 'Dries Coppens')).toContainText('0123456');
  });

  test('the Group column stays even when it is empty', async ({ page }) => {
    // DESIGN.md 1 records the Class groups picker rendering only once a
    // class_group existed, so the feature was invisible to everyone who had not
    // already used it. Hiding this column would put that back, for the lecturer
    // who is trying to start using groups.
    await openRoster(page, [{ full_name: 'Cara Janssens', email: 'cara@student.pxl.be' }]);
    await expect(page.locator('.roster-table thead th', { hasText: 'Group' })).toHaveCount(1);
  });

  test('the empty state spans the table, whichever columns are showing', async ({ page }) => {
    // NOT GUARDED ON THE ROW EXISTING. `if (await empty.count())` would skip
    // the only assertion here the moment the fixture stopped producing an
    // empty state, and pass over nothing - which is the defect this whole file
    // is about, one level up.
    //
    // Nobody in either roster has a GitHub account, so "Has account" is empty
    // by construction; the only difference between the two is the number.
    const noAccounts = [{ full_name: 'Cara Janssens', email: 'cara@student.pxl.be' }];
    const withNumber = [{ full_name: 'Dries Coppens', student_number: '0123456', email: 'd@x.be' }];

    for (const [roster, expected] of [[noAccounts, '6'], [withNumber, '7']]) {
      await openRoster(page, roster);
      await page.locator('.chip-btn', { hasText: 'Has account' }).click();
      const empty = page.locator('.roster-table tbody td[colspan]');
      await expect(empty).toHaveCount(1);
      await expect(empty).toHaveAttribute('colspan', expected);
    }
  });
});
