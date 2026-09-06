// 63 - Identifying a roster row that arrived with a login and nothing else.
//
// "Add students who accepted" writes a row carrying `github_login` and
// `source: promoted`. NOTHING fills it in afterwards, and that is by design in
// two separate places: planPromotion skips a login it has already seen (Rule 1,
// so a second press cannot half-overwrite a number and a name it knows nothing
// about), and planClaimPromotion joins a claim to an entry BY EMAIL - which a
// row with no email can never match. So the lecturer read "Not yet identified"
// six times with no route that did not begin with typing.
//
// Two halves, and they have DIFFERENT rules:
//
//   SHOWN. Everything the reports know, minus what merely repeats the login.
//   `rayane.waddah@student.pxl` has a domain that does not exist and is still
//   the string that names the student - hiding it would throw away the only
//   useful thing on that row.
//
//   WRITTEN. Only an address whose domain is allowed, because `email` is the
//   join key for claims. A wrong one there means a real claim never matches and
//   the student is rejected at acceptance: worse than none.
//
// And everything is editable in place, because the gap between those two rules
// is exactly two characters of somebody's typo.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
// Imported, never spelled: the first draft of this file invented `source:
// "promoted"`, which is not the constant - so every row fell into the schema's
// `else` branch and required a student number and a full name it does not have.
// A fixture must be the shape the app actually writes.
import { PROMOTED_SOURCE } from '../../lib/roster-entries.mjs';

// The six rows PXL-Automation-II actually held on 2026-09-06, and the exam
// report that knows something about each. Real rather than invented: every rule
// below exists because of one of them.
const LIVE = [
  { login: 'afx42', commits: 1, name: 'maarten', email: null },
  { login: 'IlkayDuranPXL', commits: 25, name: 'ilkay', email: 'IlkayDuranPXL@github.com' },
  { login: 'LowieSerneelsPXL', commits: 49, name: 'LowieSerneelsPXL', email: 'lowie.serneels@student.pxl.be' },
  { login: 'rayaneW', commits: 48, name: 'rayaneW', email: 'rayane.waddah@student.pxl' },
  { login: 'tomccargo', commits: 2, name: 'Tom Cool', email: null },
  { login: 'tomcoolpxl', commits: 2, name: 'Tom Cool', email: null },
];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const EXAM = '2526-examen-aut2-ek2';

const examReport = (students = LIVE) => ({
  schema_version: 1,
  assignment_id: EXAM,
  students: students.map((s) => ({
    github_login: s.login,
    commit_count: s.commits,
    author_name: s.name,
    author_email: s.email,
  })),
});

/**
 * Open the Roster tab with the promoted rows and the reports staged.
 *
 * Routes registered AFTER setupStandardMockRoutes win: Playwright matches
 * most-recently-added first.
 */
async function openRoster(page, {
  roster = LIVE.map((s) => ({ github_login: s.login, source: PROMOTED_SOURCE })),
  reportFiles = [
    { name: `${EXAM}.json`, type: 'file' },
    { name: 'dashboard.json', type: 'file' },
    { name: 'usage-2026-W36.json', type: 'file' },
  ],
  report = examReport(),
  reportsStatus = 200,
} = {}) {
  const contentWrites = [];
  const reads = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, roster, contentWrites });

  await page.route('**/contents/reports', (route) => {
    reads.push('reports/');
    return reportsStatus === 200
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reportFiles) })
      : route.fulfill({ status: reportsStatus, contentType: 'application/json', body: JSON.stringify({ message: 'nope' }) });
  });
  for (const f of reportFiles) {
    await page.route(`**/contents/reports/${f.name}*`, (route) => {
      reads.push(f.name);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: b64(f.name === `${EXAM}.json` ? report : {}), encoding: 'base64' }),
      });
    });
  }

  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();
  await expect(page.locator('.roster-table')).toBeVisible({ timeout: 15000 });
  return { contentWrites, reads };
}

const row = (page, login) => page.locator('.roster-table tr', { hasText: login });
const hint = (page, login) => row(page, login).locator('.harvest-hint');
const fillButton = (page) => page.getByRole('button', { name: /Fill in \d+ emails? from assignments/ });
const rosterWrite = (writes) => writes.filter((w) => w.path === 'students/roster.yml').at(-1);

// ---------------------------------------------------------------------------

test.describe('what the reports know', () => {
  test('THE LIVE SIX: every row says something, and none of it is the login again', async ({ page }) => {
    await openRoster(page);
    await expect(page.locator('.harvest-hint')).toHaveCount(6);

    await expect(hint(page, 'afx42')).toContainText('maarten');
    await expect(hint(page, 'IlkayDuranPXL')).toContainText('ilkay');
    await expect(hint(page, 'LowieSerneelsPXL')).toContainText('lowie.serneels@student.pxl.be');
    await expect(hint(page, 'rayaneW')).toContainText('rayane.waddah@student.pxl');
    await expect(hint(page, 'tomccargo')).toContainText('Tom Cool');
    await expect(hint(page, 'tomcoolpxl')).toContainText('Tom Cool');
  });

  test('a value that just repeats the login is not shown', async ({ page }) => {
    // `IlkayDuranPXL@github.com` beside `@IlkayDuranPXL` is the login twice,
    // and an author_name of `rayaneW` is what a student who never set
    // `git config user.name` produces.
    await openRoster(page);
    await expect(hint(page, 'IlkayDuranPXL')).not.toContainText('github.com');
    await expect(hint(page, 'rayaneW')).not.toContainText('commits as rayaneW');
    await expect(hint(page, 'LowieSerneelsPXL')).not.toContainText('commits as LowieSerneelsPXL');
  });

  test('a typo\'d domain is SHOWN and flagged, never hidden', async ({ page }) => {
    // It is the string that names the student. Suppressing it because
    // `student.pxl` does not resolve would discard the whole point of the row.
    await openRoster(page);
    const r = hint(page, 'rayaneW');
    await expect(r).toContainText('rayane.waddah@student.pxl');
    await expect(r).toContainText('domain not allowed');
    // And the one that IS allowed carries no such flag.
    await expect(hint(page, 'LowieSerneelsPXL')).not.toContainText('domain not allowed');
  });

  test('dashboard.json and the usage counters are not harvested', async ({ page }) => {
    // An aggregate with no student rows and a set of billing counters. Asserted
    // behaviourally rather than by counting reads: other parts of the panel
    // read dashboard.json for their own reasons, so a request counter would be
    // measuring them, not this.
    await openRoster(page, {
      reportFiles: [
        { name: 'dashboard.json', type: 'file' },
        { name: 'usage-2026-W36.json', type: 'file' },
      ],
      // Student-shaped, so ONLY the filename can be what excludes it.
      report: examReport(),
    });
    await expect(page.locator('.harvest-hint')).toHaveCount(0);
    await expect(fillButton(page)).toHaveCount(0);
  });

  test('an org whose reports cannot be read still shows its roster', async ({ page }) => {
    // The hints are an extra. A failed read of them must not take the tab down,
    // the rule the acceptance card learned when one rejected lookup replaced a
    // loaded assignment with an error.
    await openRoster(page, { reportsStatus: 500 });
    await expect(page.locator('.roster-table tr')).toHaveCount(7); // header + six
    await expect(page.locator('.harvest-hint')).toHaveCount(0);
    await expect(fillButton(page)).toHaveCount(0);
  });

  test('a row that already has a name and an address is left alone', async ({ page }) => {
    // A value a lecturer typed or a CSV imported outranks a git config field.
    await openRoster(page, {
      roster: [{
        student_number: '0123456',
        full_name: 'Lowie Serneels',
        email: 'l.serneels@pxl.be',
        github_login: 'LowieSerneelsPXL',
      }],
    });
    await expect(page.locator('.harvest-hint')).toHaveCount(0);
    await expect(fillButton(page)).toHaveCount(0);
  });
});

test.describe('filling them in', () => {
  test('only the allowed domain is offered, and the button counts it', async ({ page }) => {
    await openRoster(page);
    await expect(fillButton(page)).toHaveText(/Fill in 1 email from assignments/);
  });

  test('the button is ABSENT when there is nothing to write, not disabled', async ({ page }) => {
    // A control for a thing this organization has never needed invites a hunt
    // for it - DESIGN.md 1.5, and the class-group picker's own lesson. The
    // hints still appear, which is the half that is useful either way.
    await openRoster(page, {
      report: examReport(LIVE.map((s) => ({ ...s, email: s.email === 'lowie.serneels@student.pxl.be' ? null : s.email }))),
    });
    await expect(fillButton(page)).toHaveCount(0);
    await expect(page.locator('.harvest-hint').first()).toBeVisible();
  });

  test('it writes ONLY the allowed address, and merges rather than rebuilds', async ({ page }) => {
    const { contentWrites } = await openRoster(page);
    page.on('dialog', (d) => d.accept());
    await fillButton(page).click();

    await expect.poll(() => rosterWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const yaml = rosterWrite(contentWrites).content;
    expect(yaml).toContain('lowie.serneels@student.pxl.be');
    expect(yaml, 'the typo\'d domain must not be written').not.toContain('rayane.waddah');
    expect(yaml, 'nor the login-shaped address').not.toContain('IlkayDuranPXL@github.com');
    // Every row survives, and provenance with it.
    for (const s of LIVE) expect(yaml).toContain(s.login);
    expect((yaml.match(/source: accepted/g) || []).length).toBe(6);
  });

  test('it names what it will write before writing it', async ({ page }) => {
    // A git author email is whatever the student typed into `git config`. The
    // domain check makes it plausible, never proven, so it is confirmed.
    const { contentWrites } = await openRoster(page);
    const messages = [];
    page.on('dialog', (d) => { messages.push(d.message()); d.dismiss(); });
    await fillButton(page).click();

    await expect.poll(() => messages.length, { timeout: 10000 }).toBe(1);
    expect(messages[0]).toContain('@LowieSerneelsPXL');
    expect(messages[0]).toContain('lowie.serneels@student.pxl.be');
    expect(messages[0]).toMatch(/not verified/i);
    await page.waitForTimeout(300);
    expect(rosterWrite(contentWrites), 'dismissing writes nothing').toBeUndefined();
  });
});

test.describe('editing a row in place', () => {
  const cell = (page, login, field) => row(page, login).locator(`.cell-${field}`);

  test('all four fields are editable, and the account is not', async ({ page }) => {
    await openRoster(page);
    for (const field of ['student_number', 'full_name', 'email', 'class_group']) {
      await expect(cell(page, 'afx42', field)).toHaveCount(1);
    }
    // The account a student accepts with is established by a claim or by
    // provisioning, never by a person typing it into a table.
    await expect(row(page, 'afx42').locator('.cell-github_login')).toHaveCount(0);
  });

  test('typing an address into a row writes it, merged', async ({ page }) => {
    const { contentWrites } = await openRoster(page);
    await cell(page, 'rayaneW', 'email').click();
    await page.locator('.cell-edit').fill('rayane.waddah@student.pxl.be');
    await page.locator('.cell-edit').press('Enter');

    await expect.poll(() => rosterWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const yaml = rosterWrite(contentWrites).content;
    expect(yaml).toContain('rayane.waddah@student.pxl.be');
    expect((yaml.match(/github_login/g) || []).length).toBe(6);
  });

  test('the number can be set on a promoted row, which changes its own key', async ({ page }) => {
    // The row is keyed `login:` until it gains a number and `num:` after, so
    // the save has to match on the key as it was BEFORE the edit.
    const { contentWrites } = await openRoster(page);
    await cell(page, 'afx42', 'student_number').click();
    await page.locator('.cell-edit').fill('0123456');
    await page.locator('.cell-edit').press('Enter');

    await expect.poll(() => rosterWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const yaml = rosterWrite(contentWrites).content;
    expect(yaml).toContain('0123456');
    expect((yaml.match(/github_login/g) || []).length).toBe(6, 'no row lost, none duplicated');
  });

  test('Escape abandons the edit, and the blur behind it writes nothing', async ({ page }) => {
    // Cancelling unmounts the input, which fires blur - and blur saves. So
    // Escape cleared the draft and the blur behind it wrote the cleared value.
    const { contentWrites } = await openRoster(page);
    await cell(page, 'afx42', 'full_name').click();
    await page.locator('.cell-edit').fill('Somebody Else');
    await page.locator('.cell-edit').press('Escape');
    await page.waitForTimeout(400);
    expect(rosterWrite(contentWrites)).toBeUndefined();
  });

  test('an unchanged value writes nothing either', async ({ page }) => {
    const { contentWrites } = await openRoster(page, {
      roster: [{ github_login: 'afx42', full_name: 'Maarten Example', source: PROMOTED_SOURCE }],
    });
    await cell(page, 'afx42', 'full_name').click();
    await page.locator('.cell-edit').press('Enter');
    await page.waitForTimeout(400);
    expect(rosterWrite(contentWrites)).toBeUndefined();
  });

  test('emptying a field removes it rather than storing an empty string', async ({ page }) => {
    // student_number and full_name declare minLength: 1, so "" is not merely
    // odd - it is a document the schema rejects.
    const { contentWrites } = await openRoster(page, {
      roster: [{ github_login: 'afx42', full_name: 'Maarten Example', source: PROMOTED_SOURCE }],
    });
    await cell(page, 'afx42', 'full_name').click();
    await page.locator('.cell-edit').fill('');
    await page.locator('.cell-edit').press('Enter');

    await expect.poll(() => rosterWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    expect(rosterWrite(contentWrites).content).not.toContain('full_name');
  });

  test('only one cell is open at a time', async ({ page }) => {
    // The state lives in the parent for this reason: two open cells means the
    // second save is built on a roster the first has already changed.
    await openRoster(page);
    await cell(page, 'afx42', 'full_name').click();
    await expect(page.locator('.cell-edit')).toHaveCount(1);
    await cell(page, 'tomccargo', 'email').click();
    await expect(page.locator('.cell-edit')).toHaveCount(1);
  });

  test('the cell is a real control, reachable by keyboard', async ({ page }) => {
    await openRoster(page);
    expect(await cell(page, 'afx42', 'email').evaluate((el) => el.tagName)).toBe('BUTTON');
    await cell(page, 'afx42', 'email').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cell-edit')).toBeVisible();
  });

  test('the email placeholder comes from the deployment, not a literal', async ({ page }) => {
    // A fork that shows a PXL address in its own placeholder is the defect
    // tests/institution-name.test.mjs exists to catch.
    await openRoster(page);
    await cell(page, 'afx42', 'email').click();
    await expect(page.locator('.cell-edit')).toHaveAttribute('placeholder', /@student\.pxl\.be$/);
  });
});

test.describe('importing a CSV over a promoted row', () => {
  const NL = String.fromCharCode(10);
  const csv = (rows) =>
    ['student_number,full_name,email,github_login', ...rows.map((r) => r.join(','))].join(NL);

  async function paste(page, text) {
    await page.locator('textarea').first().fill(text);
    await expect(page.locator('.diff-pane')).toBeVisible();
  }

  test('THE DEFECT: it merges onto the row instead of adding and removing', async ({ page }) => {
    // rosterKey prefers `num:`, so a CSV row keyed num:0123456 could never meet
    // the promoted row keyed login:lowieserneelspxl. The import added one and
    // removed the other: two rows for one student.
    const { contentWrites } = await openRoster(page);
    await paste(page, csv([
      ['0123456', 'Lowie Serneels', 'lowie.serneels@student.pxl.be', 'LowieSerneelsPXL'],
    ]));

    // Nothing added, one UPDATED, and five removed - the students the CSV does
    // not name. Before this the counts were +1 / -6.
    const pane = page.locator('.diff-pane');
    await expect(pane).toContainText('0 added', { timeout: 10000 });
    await expect(pane).toContainText('1 updated');
    await expect(pane).toContainText('5 removed');
    // The changed fields are exactly the columns the CSV carried - the login
    // is not among them, because it was already there and was kept.
    await expect(pane).toContainText('[student_number, full_name, email]');
    await expect(pane.locator('text=Removed (5)').locator('..'))
      .not.toContainText('LowieSerneelsPXL');

    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /Commit/i }).first().click();
    await expect.poll(() => rosterWrite(contentWrites), { timeout: 10000 }).toBeTruthy();

    const yaml = rosterWrite(contentWrites).content;
    expect((yaml.match(/LowieSerneelsPXL/gi) || []).length, 'one row, not two').toBe(1);
    expect(yaml).toContain('0123456');
    expect(yaml).toContain('Lowie Serneels');
  });

  test('the login survives a CSV that has no github_login column', async ({ page }) => {
    // The worst version: the CSV names the student by number alone, so the
    // login - the one fact the promoted row held - was simply gone.
    const { contentWrites } = await openRoster(page, {
      roster: [{ github_login: 'alice-dev', student_number: '0123456', source: PROMOTED_SOURCE }],
    });
    await paste(page, ['student_number,full_name', '0123456,Alice Example'].join(NL));

    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /Commit/i }).first().click();
    await expect.poll(() => rosterWrite(contentWrites), { timeout: 10000 }).toBeTruthy();

    const yaml = rosterWrite(contentWrites).content;
    expect(yaml, 'the login must not be dropped').toContain('alice-dev');
    expect(yaml).toContain('Alice Example');
  });

  test('what the preview describes is what gets written', async ({ page }) => {
    // The previous shape was: preview here, build your own document there,
    // which is exactly how a diff and a write come to disagree.
    const { contentWrites } = await openRoster(page, {
      roster: [{ github_login: 'alice-dev', source: PROMOTED_SOURCE, class_group: '3A' }],
    });
    await paste(page, csv([['0123456', 'Alice Example', 'a@student.pxl.be', 'alice-dev']]));

    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /Commit/i }).first().click();
    await expect.poll(() => rosterWrite(contentWrites), { timeout: 10000 }).toBeTruthy();

    const yaml = rosterWrite(contentWrites).content;
    // Everything the CSV carried, plus everything it did not mention.
    expect(yaml).toContain('0123456');
    expect(yaml).toContain('alice-dev');
    expect(yaml, 'a group set in the table survives an import').toContain('3A');
    expect(yaml, 'and so does the provenance').toContain('source: accepted');
  });

  test('a CSV naming one student twice by login is refused outright', async ({ page }) => {
    await openRoster(page);
    await paste(page, csv([
      ['0123456', 'Alice One', 'a@student.pxl.be', 'alice-dev'],
      ['0999999', 'Alice Two', 'b@student.pxl.be', 'Alice-Dev'],
    ]));
    await expect(page.locator('.validation-errors')).toContainText(/duplicate github_login/i);
  });
});

