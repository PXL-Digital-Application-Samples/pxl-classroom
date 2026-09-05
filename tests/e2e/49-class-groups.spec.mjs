// 49 - Who an assignment is for.
//
// The roster is org-wide: one `students/roster.yml`, and every assignment gated
// on it sees the same list. An assignment used to narrow that with a RULE -
// `class_groups: ["3A"]`, re-evaluated at every acceptance against each
// student's own `class_group`. Two things were wrong with it. The answer was
// never written down, so it could change under a lecturer when the roster
// changed; and it could only slice one way, so a resit for "3A plus these four"
// had no expression at all.
//
// The assignment stores the students now, picked from the roster when it was
// created. Class groups stay on the roster as what they were always described
// as: a filter for finding people. They gate nothing.
//
// What this file holds is the part a unit test cannot see - that the control
// appears only where it MEANS something, that the empty state cannot be
// mistaken for "nobody", and that the consequences are stated before the save
// rather than at the accept button.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// Two sections and one student nobody grouped - who used to be refused by the
// rule and is now just another row you can tick.
const ROSTER = [
  { student_number: '0001', full_name: 'Alice Example', github_login: 'alice', class_group: '3A', active: true },
  { student_number: '0002', full_name: 'Bram Example', github_login: 'bram', class_group: '3A', active: true },
  { student_number: '0003', full_name: 'Cara Example', github_login: 'cara', class_group: '3B', active: true },
  { student_number: '0004', full_name: 'Dries Example', github_login: 'dries', class_group: '3B', active: true },
  { student_number: '0005', full_name: 'Eva Example', github_login: 'eva', active: true },
];

// The same five with the column stripped, for an org that has never used groups.
const UNGROUPED = ROSTER.map((s) => {
  const copy = { ...s };
  delete copy.class_group;
  return copy;
});

const guardrails = (page) =>
  page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) });

const row = (page, name) => page.locator('.cohort-row', { hasText: name });

async function newAssignment(page, { roster = ROSTER } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, roster });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('button', { hasText: 'New assignment' }).first().click();
  await expect(guardrails(page)).toBeVisible({ timeout: 15000 });
}

/** Put the roster back in charge of who may accept. */
async function gateOnRoster(page) {
  await guardrails(page).locator('select').first().selectOption('enforced');
}

test.describe('49 - picking who an assignment is for', () => {
  test('the roster is the list, and the chips are filters over it', async ({ page }) => {
    await newAssignment(page);
    await gateOnRoster(page);

    // Every student, not every group: the list is what you pick from.
    await expect(page.locator('.cohort-row')).toHaveCount(5);

    // Chips carry counts, because a bare "3A" never answered the question being
    // asked at that moment - how many people am I about to admit.
    const chips = await page.locator('.cohort-filters .chip-btn').allInnerTexts();
    expect(chips).toEqual(['All 5', '3A · 2', '3B · 2', 'No group · 1']);
  });

  test('filtering narrows the list without deciding anything', async ({ page }) => {
    await newAssignment(page);
    await gateOnRoster(page);

    await page.locator('.chip-btn', { hasText: '3A · 2' }).click();
    await expect(page.locator('.cohort-row')).toHaveCount(2);
    // Filtering is not selecting. Nothing has been chosen yet.
    await expect(guardrails(page)).toContainText('Every student on the roster may accept');

    // "No group" is a filter of its own, so the student the old rule refused
    // outright is visible and tickable like anybody else.
    await page.locator('.chip-btn', { hasText: 'No group · 1' }).click();
    await expect(page.locator('.cohort-row')).toHaveCount(1);
    await expect(page.locator('.cohort-row')).toContainText('Eva Example');
  });

  test('search finds a student by name, number or username', async ({ page }) => {
    await newAssignment(page);
    await gateOnRoster(page);

    await guardrails(page).getByPlaceholder('Search name, number or username').fill('dries');
    await expect(page.locator('.cohort-row')).toHaveCount(1);

    await guardrails(page).getByPlaceholder('Search name, number or username').fill('0003');
    await expect(page.locator('.cohort-row')).toContainText('Cara Example');
  });

  test('nothing ticked means everyone, and says so', async ({ page }) => {
    // THE EMPTY STATE IS A TRAP UNLESS IT SAYS SO. Nothing ticked stores
    // nothing, and nothing stored means every student on the roster - so a
    // lecturer who unticks their way to zero must be told, not left to find out
    // when the whole course accepts.
    await newAssignment(page);
    await gateOnRoster(page);

    await expect(guardrails(page)).toContainText('Nobody selected');
    await expect(guardrails(page)).toContainText('Every student on the roster may accept');
  });

  test('select all shown takes the filter, and the count is the truth', async ({ page }) => {
    await newAssignment(page);
    await gateOnRoster(page);

    await page.locator('.chip-btn', { hasText: '3A · 2' }).click();
    await guardrails(page).getByRole('button', { name: /Select all shown/ }).click();

    await expect(guardrails(page)).toContainText('2 of 5 selected');
    await expect(guardrails(page)).toContainText('Only these 2 may accept');

    // And a mixed cohort is just more ticking - the case that had no expression
    // under a group rule, because a student is in one group at most.
    await page.locator('.chip-btn', { hasText: 'No group · 1' }).click();
    await row(page, 'Eva Example').locator('input[type=checkbox]').check();
    await expect(guardrails(page)).toContainText('3 of 5 selected');
  });

  test('clearing the selection returns to everyone, not to nobody', async ({ page }) => {
    await newAssignment(page);
    await gateOnRoster(page);

    await row(page, 'Alice Example').locator('input[type=checkbox]').check();
    await expect(guardrails(page)).toContainText('1 of 5 selected');

    await guardrails(page).getByRole('button', { name: 'Clear selection' }).click();
    await expect(guardrails(page)).toContainText('Every student on the roster may accept');
  });

  test('picking more students than the cap warns before the save', async ({ page }) => {
    // Under a group rule the cohort size was never known at save time, so this
    // could not be checked at all; the refusals arrived at the accept button.
    await newAssignment(page);
    await gateOnRoster(page);
    await guardrails(page).locator('input[type=number]').fill('2');

    await guardrails(page).getByRole('button', { name: /Select all shown/ }).click();
    await expect(guardrails(page)).toContainText('more than the cap of 2');
    await expect(guardrails(page)).toContainText('Raise');
  });

  test('an org with no class groups still gets the picker', async ({ page }) => {
    // THE FEATURE ONLY APPEARED TO SOMEONE WHO HAD ALREADY USED IT. Its
    // predecessor was hidden until the roster had groups, and measured on
    // 2026-09-05 not one student in any live organization carried one - so the
    // control had never rendered anywhere, and a lecturer asking how to split
    // their classes had nothing on screen to find. Groups are only the filter
    // now, so their absence costs the picker nothing.
    await newAssignment(page, { roster: UNGROUPED });
    await gateOnRoster(page);

    await expect(page.locator('.cohort-row')).toHaveCount(5);
    // No group chips to offer, so only "All" - and nothing invites the lecturer
    // to look for sections this organization has never made.
    const chips = await page.locator('.cohort-filters .chip-btn').allInnerTexts();
    expect(chips).toEqual(['All 5']);
  });

  test('the picker is absent under open enrolment', async ({ page }) => {
    // Under `open` the roster does not decide who may accept, so a cohort there
    // would be a control that decides nothing - DESIGN.md §1.5. A new
    // assignment defaults to open, so this is the state it opens in.
    await newAssignment(page);

    // Positive first: the fieldset really is on screen, so a count of zero
    // below is an absence rather than a page that had not rendered.
    await expect(guardrails(page)).toContainText('Who may accept');
    await expect(page.locator('.cohort-list')).toHaveCount(0);
  });

  test('an empty roster is not offered a list to pick from', async ({ page }) => {
    // `enforced` with nobody imported already says "nobody can accept" on the
    // mode itself. An empty picker underneath buries the line that matters.
    await newAssignment(page, { roster: [] });
    await gateOnRoster(page);

    await expect(guardrails(page)).toContainText('nobody can accept');
    await expect(page.locator('.cohort-list')).toHaveCount(0);
  });

  test('a published assignment adds students, and cannot drop them', async ({ page }) => {
    // ADD ONLY, and not out of caution. Taking a student out of a live cohort
    // does not un-provision their repository, un-invite them or delete their
    // work - so a control that looked like it removed them would describe
    // behaviour the system does not have (DESIGN.md §1.5).
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      roster: ROSTER,
      assignments: {
        'lab-3': {
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
          cohort: ['num:0001', 'num:0002'],
          cohort_groups: ['3A'],
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=lab-3`);
    // A published assignment leads with its cohort card and keeps the settings
    // behind a disclosure - the picker is inside it.
    await page.locator(".settings-disclosure > summary").click();
    await expect(guardrails(page)).toBeVisible({ timeout: 15000 });

    // The two already in it are ticked and not yours to untick.
    await expect(row(page, 'Alice Example').locator('input[type=checkbox]')).toBeChecked();
    await expect(row(page, 'Alice Example').locator('input[type=checkbox]')).toBeDisabled();
    await expect(guardrails(page)).toContainText("cannot be removed");

    // THE SILENT OMISSION, NAMED. A snapshot leaves a late enroller simply
    // absent, and without this nothing says so until they cannot accept.
    await expect(guardrails(page)).toContainText("3 student(s) on the roster are not in this assignment");

    // Adding works, and the count moves.
    await row(page, 'Eva Example').locator('input[type=checkbox]').check();
    await expect(guardrails(page)).toContainText('3 of 5 selected');

    // Clear returns to the published cohort, never to "everyone" - which is
    // what an empty cohort would mean on a live assignment.
    await guardrails(page).getByRole('button', { name: 'Clear selection' }).click();
    await expect(guardrails(page)).toContainText('2 of 5 selected');
    await expect(guardrails(page)).not.toContainText('Every student on the roster may accept');
  });

  test('Add students opens the picker from the cohort card', async ({ page }) => {
    // THE CAPABILITY EXISTED AND NOTHING POINTED AT IT. A published assignment
    // leads with its cohort card and keeps the settings shut, so adding a late
    // enroller meant knowing to open "Edit settings" first - and MANUAL.md told
    // lecturers to use an "Add students" action that did not exist.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      roster: ROSTER,
      assignments: {
        'lab-3': {
          schema_version: 1, id: 'lab-3', title: 'Lab 3', organization: ORG,
          template: { owner: ORG, repository: 'starter-template' },
          repository_name_pattern: 'lab-3-{github_login}',
          opens_at: '2026-09-01T08:00:00Z', deadline_at: '2026-12-30T20:00:00Z',
          state: 'published', assignment_type: 'individual', roster_mode: 'enforced',
          cohort: ['num:0001', 'num:0002'],
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=lab-3`);

    const add = page.getByRole('button', { name: 'Add students' });
    await expect(add).toBeVisible({ timeout: 15000 });
    // Reachable without opening anything first: the picker is shut behind the
    // disclosure until this is pressed. Not COUNT - a closed <details> keeps its
    // contents in the DOM and merely hides them, so the question is visibility.
    await expect(page.locator('.cohort-list')).not.toBeVisible();

    await add.click();
    await expect(page.locator('.cohort-list')).toBeVisible();
    await expect(guardrails(page)).toContainText('2 of 5 selected');
    // It lands where you type, because the reason to open it is to find someone.
    await expect(guardrails(page).getByPlaceholder('Search name, number or username')).toBeFocused();

    await row(page, 'Eva Example').locator('input[type=checkbox]').check();
    await expect(guardrails(page)).toContainText('3 of 5 selected');
  });

  test('Add students is not offered where it would do nothing', async ({ page }) => {
    // An assignment that admits everyone has nothing to add to, and its own
    // empty state already says so. A control that cannot change anything is
    // worse than no control (DESIGN.md §1.5).
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      roster: ROSTER,
      assignments: {
        'lab-3': {
          schema_version: 1, id: 'lab-3', title: 'Lab 3', organization: ORG,
          template: { owner: ORG, repository: 'starter-template' },
          repository_name_pattern: 'lab-3-{github_login}',
          opens_at: '2026-09-01T08:00:00Z', deadline_at: '2026-12-30T20:00:00Z',
          state: 'published', assignment_type: 'individual', roster_mode: 'enforced',
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=lab-3`);
    // Positive first, so a count of zero is an absence and not an unrendered page.
    await expect(page.getByRole('link', { name: /Track roster/ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Add students' })).toHaveCount(0);
  });

  test('a draft has nothing locked - the selection is still the lecturer\'s', async ({ page }) => {
    await newAssignment(page);
    await gateOnRoster(page);

    await row(page, 'Alice Example').locator('input[type=checkbox]').check();
    await expect(row(page, 'Alice Example').locator('input[type=checkbox]')).toBeEnabled();
    await expect(guardrails(page)).not.toContainText("cannot be removed");

    // And unticking really does untick, back to "everyone".
    await row(page, 'Alice Example').locator('input[type=checkbox]').uncheck();
    await expect(guardrails(page)).toContainText('Every student on the roster may accept');
  });

  // The wire format is NOT tested here. `buildAssignmentDoc` is importable, so
  // driving a whole form to observe what it emits would be the wrong level and
  // a slower way to learn less - tests/assignment-doc-cohort.test.mjs calls it
  // directly. What belongs in this file is what only a browser can show: that
  // ticking a row changes the count on screen, which the tests above assert.

  test('the round trip the class-group help names actually carries the column', async ({ page }) => {
    // The manual tells a lecturer to export the roster, fill `class_group` in
    // and import it back, so the filter has something to filter by. That is a
    // promise about two features: Export CSV had no test over its CONTENT at
    // all, and quick add typed a group and asserted only the name. If the
    // export dropped the column, the instruction would send someone to build a
    // file that silently un-groups their whole roster on the way back in.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, roster: ROSTER });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const csv = readFileSync(await download.path(), 'utf8');

    // `trim()` strips the BOM as well as the whitespace: downloadBlob prefixes
    // a UTF-8 one so Excel decodes accented names, and U+FEFF is WhiteSpace, so
    // it goes with the newline. Spelling it as a literal in a regex is both
    // invisible in a diff and an eslint error (no-irregular-whitespace).
    const [header, ...rows] = csv.trim().split('\n');
    const columns = header.split(',');
    expect(columns, 'the header must offer the column the help names').toContain('class_group');

    // Every group survives the trip in the lecturer's own spelling - and the
    // student who has none comes back with none rather than a guess.
    const at = columns.indexOf('class_group');
    expect(rows.map((r) => r.split(',')[at])).toEqual(['3A', '3A', '3B', '3B', '']);
  });
});

test.describe('49 - setting a class group without a CSV', () => {
  // It took a full round trip - export, spreadsheet, import, confirm a diff -
  // to move one student between sections. Fine once a year for a cohort,
  // absurd for the late enroller who turns up in week three, and the group is
  // what the assignment picker filters by.
  async function rosterTab(page, contentWrites) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, roster: ROSTER, contentWrites });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();
    await expect(page.locator('.roster-table')).toBeVisible({ timeout: 15000 });
  }

  const cell = (page, name) =>
    page.locator('.roster-table tr', { hasText: name }).locator('.group-cell');

  test('a group is set in place, and only that student changes', async ({ page }) => {
    // MERGE, NEVER REPLACE. This table shows five of the nine columns an entry
    // can carry, so a roster rebuilt from what it renders would drop the rest.
    const contentWrites = [];
    await rosterTab(page, contentWrites);

    await cell(page, 'Eva Example').click();
    await page.locator('.group-edit').fill('3B');
    await page.locator('.group-edit').press('Enter');

    await expect
      .poll(() => contentWrites.find((w) => w.path === 'students/roster.yml'), { timeout: 10000 })
      .toBeTruthy();
    const doc = yamlParse(contentWrites.find((w) => w.path === 'students/roster.yml').content);

    const eva = doc.students.find((s) => s.student_number === '0005');
    expect(eva.class_group).toBe('3B');
    // Everything else about her survives.
    expect(eva.github_login).toBe('eva');
    expect(eva.full_name).toBe('Eva Example');
    // And nobody else moved.
    expect(doc.students.find((s) => s.student_number === '0001').class_group).toBe('3A');
    expect(doc.students).toHaveLength(5);
  });

  test('emptying it removes the field rather than storing an empty group', async ({ page }) => {
    // The roster schema distinguishes absent from empty, and "" is a group
    // whose name is nothing - it would show up as a section in the picker.
    const contentWrites = [];
    await rosterTab(page, contentWrites);

    await cell(page, 'Alice Example').click();
    await page.locator('.group-edit').fill('');
    await page.locator('.group-edit').press('Enter');

    await expect
      .poll(() => contentWrites.find((w) => w.path === 'students/roster.yml'), { timeout: 10000 })
      .toBeTruthy();
    const doc = yamlParse(contentWrites.find((w) => w.path === 'students/roster.yml').content);
    const alice = doc.students.find((s) => s.student_number === '0001');
    expect('class_group' in alice).toBe(false);
  });

  test('Escape abandons the edit, and an unchanged value writes nothing', async ({ page }) => {
    const contentWrites = [];
    await rosterTab(page, contentWrites);

    await cell(page, 'Alice Example').click();
    await page.locator('.group-edit').fill('9Z');
    await page.locator('.group-edit').press('Escape');
    await expect(cell(page, 'Alice Example')).toHaveText('3A');

    // Opening and closing on the same value is not a commit - a roster history
    // full of no-op commits is a history nobody reads.
    await cell(page, 'Alice Example').click();
    await page.locator('.group-edit').press('Enter');
    await page.waitForTimeout(300);
    expect(contentWrites.filter((w) => w.path === 'students/roster.yml')).toHaveLength(0);
  });

  test('the groups already in use are offered, so a section is not split in two', async ({ page }) => {
    // "3a" typed beside an existing "3A" is one section rendered as two chips
    // in the picker. A datalist suggests without preventing a new group.
    await rosterTab(page, []);
    await cell(page, 'Eva Example').click();

    const options = await page.locator('#roster-class-groups option').evaluateAll(
      (els) => els.map((e) => e.value),
    );
    expect(options).toEqual(['3A', '3B']);
    await expect(page.locator('.group-edit')).toHaveAttribute('list', 'roster-class-groups');
  });

  test('the cell is a real control, reachable by keyboard', async ({ page }) => {
    // A span with a click handler is invisible to a keyboard and announced as
    // nothing. This is a button because that is what it is.
    await rosterTab(page, []);
    expect(await cell(page, 'Alice Example').evaluate((el) => el.tagName)).toBe('BUTTON');
    await cell(page, 'Alice Example').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.group-edit')).toBeVisible();
  });
});

// ===========================================================================
// A real course, not five students.
//
// Everything above runs on a roster small enough to see at once, which is
// exactly the size at which a picker cannot go wrong. The failures worth having
// a test for only appear when the list is longer than the box: a "select all"
// that quietly takes the whole roster instead of the filter, a count that drifts
// from what is ticked, and a list that pushes the page sideways instead of
// scrolling inside itself.
//
// 200 is a first-year cohort at PXL. Four class groups, two students nobody has
// grouped yet, and a third of them with no GitHub username - the shape of a
// roster imported from the registrar before anybody has accepted anything.
// ===========================================================================

const FIRST = ['Alice', 'Bram', 'Cara', 'Dries', 'Eva', 'Finn', 'Gitte', 'Hanne', 'Ilse', 'Jonas'];
const LAST = ['Vermeulen', 'Peeters', 'Janssens', 'Maes', 'Willems', 'Claes', 'Goossens', 'Wouters'];
const GROUPS = ['1TIN-A', '1TIN-B', '1TIN-C', '2TIN-A'];

const BIG = Array.from({ length: 200 }, (_, i) => ({
  student_number: String(1230000 + i).padStart(7, '0'),
  full_name: `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}${i > 79 ? ` ${Math.floor(i / 80)}` : ''}`,
  email: `s${i}@student.pxl.be`,
  ...(i < 198 ? { class_group: GROUPS[i % GROUPS.length] } : {}),
  ...(i % 3 === 0 ? {} : { github_login: `student-${i}` }),
  active: true,
}));

test.describe('49 - the picker at a real course size', () => {
  async function bigPicker(page) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, roster: BIG });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('button', { hasText: 'New assignment' }).first().click();
    await expect(guardrails(page)).toBeVisible({ timeout: 20000 });
    await gateOnRoster(page);
    await expect(page.locator('.cohort-row')).toHaveCount(200, { timeout: 20000 });
  }

  test('every student is offered, and the chips add up to the roster', async ({ page }) => {
    await bigPicker(page);

    const chips = await page.locator('.cohort-filters .chip-btn').allInnerTexts();
    expect(chips[0]).toBe('All 200');
    // The counts have to partition the roster: a chip that over- or under-counts
    // sends a lecturer to select a section that is not the section.
    const counted = chips.slice(1).map((c) => Number(c.split('·')[1].trim()));
    expect(counted.reduce((a, b) => a + b, 0)).toBe(200);
    // Four groups plus the two nobody grouped.
    expect(chips.slice(1, 5).map((c) => c.split('·')[0].trim())).toEqual(GROUPS);
    expect(chips[5]).toBe('No group · 2');
  });

  test('select all shown takes the FILTER, not the roster', async ({ page }) => {
    // The failure this whole describe exists for. With five students on screen
    // a "select all" that ignored the filter looks identical to one that
    // honours it; with 200 it is the difference between 50 students and a
    // course.
    await bigPicker(page);

    await page.locator('.chip-btn', { hasText: '1TIN-A' }).click();
    await expect(page.locator('.cohort-row')).toHaveCount(50);
    await guardrails(page).getByRole('button', { name: /Select all shown/ }).click();
    await expect(guardrails(page)).toContainText('50 of 200 selected');

    // Adding a second section adds to the selection rather than replacing it.
    await page.locator('.chip-btn', { hasText: '1TIN-B' }).click();
    await guardrails(page).getByRole('button', { name: /Select all shown/ }).click();
    await expect(guardrails(page)).toContainText('100 of 200 selected');
  });

  test('search narrows the list, and select all respects it', async ({ page }) => {
    await bigPicker(page);
    const search = guardrails(page).getByPlaceholder('Search name, number or username');

    await search.fill('Vermeulen');
    const shown = await page.locator('.cohort-row').count();
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(200);

    await guardrails(page).getByRole('button', { name: /Select all shown/ }).click();
    await expect(guardrails(page)).toContainText(`${shown} of 200 selected`);

    // Clearing the search does not clear the selection - the filter is a view.
    await search.fill('');
    await expect(page.locator('.cohort-row')).toHaveCount(200);
    await expect(guardrails(page)).toContainText(`${shown} of 200 selected`);
  });

  test('the count stays exact when one row is toggled among 200', async ({ page }) => {
    await bigPicker(page);

    await guardrails(page).getByRole('button', { name: /Select all shown/ }).click();
    await expect(guardrails(page)).toContainText('200 of 200 selected');

    await page.locator('.cohort-row').first().locator('input[type=checkbox]').uncheck();
    await expect(guardrails(page)).toContainText('199 of 200 selected');
    // And the honest line about who is left out appears only once something is
    // published, so on a draft it must not - the lecturer is still choosing.
    await expect(guardrails(page)).not.toContainText('not in this assignment');
  });

  test('a student number is text, not a box that reads as an input', async ({ page }) => {
    // COMPUTED, NOT EYEBALLED. `.field code` in this view is (0,2,1) once Vue
    // adds its scope attribute and a bare `.cohort-num` is (0,2,0), so the
    // plain class lost and every number kept the filled `code` background - a
    // column of things that look editable, down 200 rows. It survived a
    // screenshot review because at a glance a faint fill reads as a table
    // stripe; only asking the browser found it.
    await bigPicker(page);
    const bg = await page.locator('.cohort-num').first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, 'the number must not carry a fill').toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test('the list scrolls inside itself and never pushes the page sideways', async ({ page }) => {
    // A 200-row list that grows the form is a page you cannot reach Save on,
    // and a row that will not ellipsise scrolls the whole document sideways -
    // the failure DESIGN.md §7 exists for, invisible at five rows.
    await bigPicker(page);

    const geom = await page.locator('.cohort-list').evaluate((el) => ({
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
      pageScrollW: document.documentElement.scrollWidth,
      pageClientW: document.documentElement.clientWidth,
    }));

    expect(geom.scrollH, '200 rows must overflow the box').toBeGreaterThan(geom.clientH);
    expect(geom.clientH, 'and the box must stay a box, not grow to fit them').toBeLessThan(600);
    expect(geom.pageScrollW, 'no sideways scroll').toBeLessThanOrEqual(geom.pageClientW + 1);
  });

  test('it survives a phone, where the columns fall away', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await bigPicker(page);

    const geom = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    expect(geom.scrollW, 'no sideways scroll at 375px').toBeLessThanOrEqual(geom.clientW + 1);

    // Ticking still works when the number and account columns are hidden.
    await page.locator('.cohort-row').first().locator('input[type=checkbox]').check();
    await expect(guardrails(page)).toContainText('1 of 200 selected');
  });
});
