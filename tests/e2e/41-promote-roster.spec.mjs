// 41 - Turning an open assignment's acceptances into roster entries
//
// Under roster_mode: open nobody had to be on the roster to accept, so the
// cohort exists only as GitHub logins in acceptances/<id>/<login>.json. That
// went nowhere: students/roster.yml was written only by a CSV import, so the
// next assignment started from the same blank roster.
//
// These tests care about the seams the unit tests cannot reach - what the
// lecturer is offered, what the modal says before they commit, and what bytes
// actually land in the control repo.

import { test, expect } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'exam-2026';

function assignment(over = {}) {
  return {
    schema_version: 1,
    id: ID,
    title: 'Exam 2026',
    organization: ORG,
    repository_name_pattern: `${ID}-{github_login}`,
    opens_at: new Date(Date.now() - 86400000).toISOString(),
    deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
    state: 'published',
    assignment_type: 'individual',
    roster_mode: 'open',
    max_acceptances: 50,
    ...over,
  };
}

function acceptance(login, over = {}) {
  return {
    schema_version: 1,
    assignment_id: ID,
    github_login: login,
    github_id: 4000 + login.length,
    accepted_at: '2026-08-30T09:00:00.000Z',
    status: 'provisioned',
    ...over,
  };
}

// The report is what drives acceptedStudentsCount, which gates the menu item.
function report(logins) {
  return {
    schema_version: 1,
    assignment_id: ID,
    generated_at: new Date().toISOString(),
    students: logins.map((l) => ({
      github_login: l,
      repo_name: `${ID}-${l}`,
      acceptance_state: 'accepted',
      status: 'no-submission',
    })),
  };
}

async function openDetail(page, { a = assignment(), accepted = ['bob-pxl', 'carol'], roster = null, extra = {} } = {}) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: a },
    reports: { [ID]: report(accepted) },
    controlAcceptances: { [ID]: accepted.map((l) => (l === 'UNREADABLE' ? 'UNREADABLE' : acceptance(l))) },
    roster,
    contentWrites,
    ...extra,
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.getByRole('button', { name: /More/ })).toBeVisible({ timeout: 15000 });
  return contentWrites;
}

const menuItem = (page) => page.getByRole('menuitem', { name: /Add accepted students to roster/ });
const modal = (page) => page.locator('.promote-modal');

async function openModal(page) {
  await page.getByRole('button', { name: /More/ }).click();
  await menuItem(page).click();
  await expect(modal(page)).toBeVisible();
}

// ======================================================= the offer itself

test.describe('41 - the action is offered only where it does something', () => {
  test('an open assignment with acceptances offers it', async ({ page }) => {
    await openDetail(page);
    await page.getByRole('button', { name: /More/ }).click();
    await expect(menuItem(page)).toBeVisible();
  });

  test('an ENFORCED assignment does not - everyone who accepted was already on the roster', async ({ page }) => {
    await openDetail(page, { a: assignment({ roster_mode: 'enforced' }) });
    await page.getByRole('button', { name: /More/ }).click();
    await expect(menuItem(page)).toHaveCount(0);
  });

  test('an open assignment nobody has accepted does not offer it', async ({ page }) => {
    await openDetail(page, { accepted: [] });
    await page.getByRole('button', { name: /More/ }).click();
    await expect(menuItem(page)).toHaveCount(0);
  });
});

// ======================================================= what it says first

test.describe('41 - the modal shows the plan before anything is written', () => {
  test('it lists the students it would add, and the counts', async ({ page }) => {
    await openDetail(page);
    await openModal(page);

    await expect(modal(page)).toContainText('@bob-pxl');
    await expect(modal(page)).toContainText('@carol');
    await expect(modal(page).locator('.promote-stat')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Add 2 students' })).toBeEnabled();
  });

  test('it says out loud that the entries carry a login and nothing else', async ({ page }) => {
    // The lecturer is about to add rows with no name and no student number. If
    // the modal does not say so, the roster silently grows a second class of
    // entry that looks like a broken import.
    await openDetail(page);
    await openModal(page);
    await expect(modal(page)).toContainText('GitHub never tells us a name or a student number');
    await expect(modal(page)).toContainText('source: accepted');
  });

  test('a student already on the roster is counted, not re-added', async ({ page }) => {
    await openDetail(page, {
      roster: [{ student_number: '0123456', full_name: 'Bob Example', github_login: 'bob-pxl' }],
    });
    await openModal(page);

    await expect(page.getByRole('button', { name: 'Add 1 student' })).toBeEnabled();
    await expect(modal(page).locator('.promote-preview-list')).not.toContainText('@bob-pxl');
    await expect(modal(page)).toContainText('already on the roster');
  });

  test('nothing to add disables the button rather than committing an empty change', async ({ page }) => {
    await openDetail(page, {
      roster: [
        { student_number: '1', full_name: 'Bob', github_login: 'bob-pxl' },
        { student_number: '2', full_name: 'Carol', github_login: 'carol' },
      ],
    });
    await openModal(page);
    await expect(page.getByRole('button', { name: 'Nothing to add' })).toBeDisabled();
  });

  test('a case-different login on the roster is the same student', async ({ page }) => {
    await openDetail(page, {
      roster: [{ student_number: '1', full_name: 'Bob', github_login: 'BOB-PXL' }],
    });
    await openModal(page);
    await expect(page.getByRole('button', { name: 'Add 1 student' })).toBeEnabled();
  });
});

// ======================================================= refusing to guess

test.describe('41 - it refuses rather than reporting a number it cannot stand behind', () => {
  test('an unreadable acceptance record BLOCKS the promotion', async ({ page }) => {
    // Promoting anyway would leave that student off the roster and still say
    // "1 student added" - a short read rounded down into a confident number.
    await openDetail(page, { accepted: ['bob-pxl', 'UNREADABLE'] });
    await openModal(page);

    await expect(modal(page)).toContainText('could not be read');
    await expect(modal(page)).toContainText('quietly leave those students off the roster');
    await expect(page.getByRole('button', { name: /^Add / })).toHaveCount(0);
  });

  test('an array-shaped roster is refused with an explanation, not overwritten', async ({ page }) => {
    // It parses, but accept.mjs reads roster.students and so sees nobody - this
    // roster is already letting nobody accept and the lecturer has to know.
    await openDetail(page, { roster: '- student_number: "1"\n  full_name: Bob\n' });
    await openModal(page);

    await expect(modal(page)).toContainText('Nothing was added');
    await expect(modal(page)).toContainText('not a document with a "students:" key');
    await expect(page.getByRole('button', { name: 'Nothing to add' })).toBeDisabled();
  });
});

// ======================================================= what actually lands

test.describe('41 - the bytes written to the control repo', () => {
  test('promoting writes a roster the acceptance gate would admit', async ({ page }) => {
    const writes = await openDetail(page);
    await openModal(page);
    await page.getByRole('button', { name: 'Add 2 students' }).click();

    await expect(modal(page)).toHaveCount(0, { timeout: 15000 });
    const write = writes.find((w) => w.path === 'students/roster.yml');
    expect(write, 'the roster must be committed').toBeTruthy();

    const doc = parseYaml(write.content);
    expect(doc.schema_version).toBe(2);
    expect(doc.students.map((s) => s.github_login).sort()).toEqual(['bob-pxl', 'carol']);

    // The rule accept.mjs actually applies.
    const admits = (login) =>
      doc.students.some((s) => s.github_login?.toLowerCase() === login.toLowerCase());
    expect(admits('bob-pxl')).toBe(true);
    expect(admits('CAROL')).toBe(true);
    expect(admits('stranger')).toBe(false);
  });

  test('promoted entries carry provenance and NO invented identity', async ({ page }) => {
    const writes = await openDetail(page, { accepted: ['bob-pxl'] });
    await openModal(page);
    await page.getByRole('button', { name: 'Add 1 student' }).click();
    await expect(modal(page)).toHaveCount(0, { timeout: 15000 });

    const doc = parseYaml(writes.find((w) => w.path === 'students/roster.yml').content);
    const entry = doc.students[0];
    expect(entry.source).toBe('accepted');
    expect(entry.github_id).toBe(4007);
    expect(entry.promoted_from.assignment_id).toBe(ID);
    expect(entry.promoted_from.accepted_at).toBe('2026-08-30T09:00:00.000Z');
    for (const invented of ['full_name', 'student_number', 'email', 'class_group']) {
      expect(entry[invented], `${invented} must not be invented`).toBeUndefined();
    }
  });

  test('an existing student is written back unchanged', async ({ page }) => {
    const existing = {
      student_number: '0123456',
      full_name: 'Bob Example',
      email: 'bob@student.pxl.be',
      class_group: '3A',
      github_login: 'bob-pxl',
    };
    const writes = await openDetail(page, { roster: [existing] });
    await openModal(page);
    await page.getByRole('button', { name: 'Add 1 student' }).click();
    await expect(modal(page)).toHaveCount(0, { timeout: 15000 });

    const doc = parseYaml(writes.find((w) => w.path === 'students/roster.yml').content);
    const bob = doc.students.find((s) => s.github_login === 'bob-pxl');
    expect(bob).toEqual(existing);
  });
});
