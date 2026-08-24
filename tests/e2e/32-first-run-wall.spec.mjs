// 32 - WS3: the first-run wall (UX_PLAN §5.1-§5.4)
//
// Four ways the Admin Panel stopped a lecturer on their first assignment and
// then declined to say what to do about it:
//
//   §5.1  zero template repositories - "Create one and mark it as a template in
//         repo Settings", which assumes you know what a template repository is
//         and buries the checkbox that is the actual reason the list is empty
//   §5.2  roster_mode: enforced makes students/roster.yml load-bearing, and the
//         form named a tab it did not link to and a count it did not show
//   §5.3  "Seed teams from…", permanently disabled on the create form,
//         explaining its own impossibility
//   §5.4  raw AJV: /autograde/tests/0/id must match pattern "^[a-z0-9]..."
//
// The roster count is the interesting one to test end to end: it is read by
// RosterTab (the next tab over) and rendered by AdminView, so a spec that
// mocked either half in isolation would prove nothing about the pair.

import { test, expect } from '@playwright/test';
import { stringify as stringifyYaml } from 'yaml';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const rosterStatus = (page) => page.locator('.roster-status');

// The roster status block only renders under the gate, and `enforced` stopped
// being the default on 2026-08-24 (signed invitations gate the broker now, so
// a lecturer no longer has to import a CSV before anyone can accept). What
// these tests are about - whether the form can answer "can anyone accept?" -
// is unchanged; reaching it now needs one dropdown.
const gateOn = async (page) =>
  page.locator('select').filter({ hasText: 'only students on the roster' }).first().selectOption('enforced');
const templateEmpty = (page) => page.locator('.template-empty');

async function openAdmin(page, opts = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, ...opts });
  await page.goto(`/dashboard/${ORG}/admin`);
  await expect(page.locator('.app-header-crumbs .app-header-heading')).toBeVisible({ timeout: 10000 });
}

async function openNewAssignmentForm(page, opts = {}) {
  await openAdmin(page, opts);
  await page.locator('.new-btn').click();
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
}

/** Serve students/roster.yml with the given students, or a failure. */
async function serveRoster(page, { students = null, status = 200 } = {}) {
  await page.route('**/pxl-classroom-control/contents/students/roster.yml*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    if (status !== 200) {
      await route.fulfill({ status, body: JSON.stringify({ message: 'boom' }) });
      return;
    }
    const yaml = stringifyYaml({ schema_version: 1, students });
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ content: Buffer.from(yaml).toString('base64'), encoding: 'base64', sha: 'r1' }),
    });
  });
}

const student = (n) => ({
  student_number: `S${n}`,
  full_name: `Student ${n}`,
  email: `s${n}@stud.pxl.be`,
  github_login: `student-${n}`,
});

// =========================================================== §5.1 templates

test.describe('32 - §5.1 An organization with no template repositories', () => {
  // The org search returns nothing when the org has no `is:template` repos.
  async function noTemplates(page) {
    await page.route('**/search/repositories*', async (route) => {
      await route.fulfill({ status: 200, body: JSON.stringify({ total_count: 0, items: [] }) });
    });
  }

  test('The empty state says what a template is, and where the checkbox lives', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await noTemplates(page);
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    const empty = templateEmpty(page);
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('This organization has no template repositories yet');
    // What a template IS - the old copy assumed the reader knew.
    await expect(empty).toContainText('an ordinary repository');
    await expect(empty).toContainText('Every student gets their own copy of it');
    // The one non-obvious step, which is why the list is empty for most people.
    await expect(empty).toContainText('Template repository');
    await expect(empty).toContainText('press refresh');
  });

  test('It links to the right page on GitHub, in a new tab, without leaking the referrer', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await noTemplates(page);
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    const link = templateEmpty(page).getByRole('link', { name: /Create one on GitHub/i });
    await expect(link).toHaveAttribute('href', `https://github.com/organizations/${ORG}/repositories/new`);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('The combobox stays, because typing owner/repo is the only route to a template the search cannot see', async ({ page }) => {
    // Deliberate deviation from the plan's "in place of the combobox": a
    // cross-org template is named by hand and probed live, and an org with
    // none of its own is exactly when someone reaches for one.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await noTemplates(page);
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    const input = page.getByPlaceholder('Type or select a template repository');
    await expect(input).toBeVisible();
    await input.fill('OtherOrg/shared-template');

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Cross Org Lab');
    await expect(page.getByRole('button', { name: 'Save as draft' }).first()).toBeEnabled();
  });

  test('With templates present, the wall is not shown', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.route('**/search/repositories*', async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({
          total_count: 2,
          items: [
            { full_name: `${ORG}/starter-template`, is_template: true },
            { full_name: `${ORG}/lab-template`, is_template: true },
          ],
        }),
      });
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(page.locator('text=Found 2 template repositories')).toBeVisible();
    await expect(templateEmpty(page)).toHaveCount(0);
  });
});

// ============================================================== §5.2 roster

test.describe('32 - §5.2 The roster gate says whether anyone can accept', () => {
  test('No roster file at all is "nobody can accept", with a way to fix it', async ({ page }) => {
    // The fixture 404s students/roster.yml unless one is passed, which is the
    // state of every freshly scaffolded control repo.
    await openNewAssignmentForm(page);

    await gateOn(page);
    await expect(rosterStatus(page)).toContainText('No students imported yet - nobody can accept');
    await expect(rosterStatus(page).locator('.status-dot.dot-warning')).toBeVisible();

    await rosterStatus(page).getByRole('button', { name: /Import roster/ }).click();
    await expect(page.locator('.roster-tab')).toBeVisible();
  });

  test('A roster with students shows the count and links to manage it', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await serveRoster(page, { students: [student(1), student(2), student(3)] });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await gateOn(page);
    await expect(rosterStatus(page)).toContainText('3 students on the roster');
    await expect(rosterStatus(page).locator('.status-dot.dot-success')).toBeVisible();

    await rosterStatus(page).getByRole('button', { name: /Manage/ }).click();
    await expect(page.locator('.roster-tab')).toBeVisible();
  });

  test('One student is one student, not "1 students"', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await serveRoster(page, { students: [student(1)] });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await gateOn(page);
    await expect(rosterStatus(page)).toContainText('1 student on the roster');
    await expect(rosterStatus(page)).not.toContainText('1 students');
  });

  test('An empty students list is a known zero, not an unknown', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await serveRoster(page, { students: [] });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await gateOn(page);
    await expect(rosterStatus(page)).toContainText('nobody can accept');
  });

  test('A roster that cannot be read is not reported as an empty one', async ({ page }) => {
    // "There is no roster" and "the roster could not be read" are different
    // facts. Claiming the first because of an expired token would send a
    // lecturer to import students they already have.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await serveRoster(page, { status: 500 });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    // The neutral copy still explains that an empty roster blocks acceptance -
    // what it must not do is assert this org's roster IS empty.
    await gateOn(page);
    await expect(rosterStatus(page)).toContainText('Students must appear in');
    await expect(rosterStatus(page)).not.toContainText('No students imported yet');
    await expect(rosterStatus(page).locator('.status-dot')).toHaveCount(0);
  });

  test('Open enrollment does not talk about a roster it has switched off', async ({ page }) => {
    await openNewAssignmentForm(page);
    await gateOn(page);
    await expect(rosterStatus(page)).toBeVisible();

    await page.locator('select').filter({ hasText: 'only students on the roster' }).selectOption('open');
    await expect(rosterStatus(page)).toHaveCount(0);
    // It says what open enrolment means instead of going quiet.
    await expect(page.locator('text=Students need the link')).toBeVisible();
  });
});

// ========================================================== §5.3 seed teams

test.describe('32 - §5.3 A control that cannot work is not on the screen', () => {
  test('Seed teams is absent from the create form and present on a saved one', async ({ page }) => {
    const saved = {
      schema_version: 1,
      id: 'group-lab',
      title: 'Group Lab',
      organization: ORG,
      template: { owner: ORG, repository: 'starter-template' },
      repository_name_pattern: 'group-lab-{team_slug}',
      opens_at: new Date(Date.now() - 86400000).toISOString(),
      deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      state: 'draft',
      assignment_type: 'group',
      group_config: { max_team_size: 3, min_team_size: 2, formation_mode: 'self-service' },
    };

    await openNewAssignmentForm(page);
    await page.locator('input[type="radio"][value="group"]').check();
    await expect(page.locator('text=Starting teams')).toHaveCount(0);
    await expect(page.locator('button', { hasText: 'Seed teams from…' })).toHaveCount(0);

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { 'group-lab': saved } });
    await page.goto(`/dashboard/${ORG}/admin?edit=group-lab`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Group Lab', { timeout: 10000 });

    await expect(page.locator('button', { hasText: 'Seed teams from…' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Seed teams from…' })).toBeEnabled();
  });
});

// ========================================================== §5.4 validation

test.describe('32 - §5.4 Validation speaks to lecturers', () => {
  // The modal refuses a bad check id before it can be saved (UX_PLAN §6.3), so
  // this state now only arrives from a YAML someone edited by hand. That is
  // exactly when the raw AJV mattered most: there is no control to point at.
  test('A bad check id from a hand-written YAML is explained, not printed as a JSON Pointer and a regex', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'hand-edited': {
          schema_version: 1,
          id: 'hand-edited',
          title: 'Hand Edited',
          organization: ORG,
          template: { owner: ORG, repository: 'starter-template' },
          repository_name_pattern: 'hand-edited-{github_login}',
          opens_at: new Date(Date.now() - 86400000).toISOString(),
          deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
          state: 'draft',
          assignment_type: 'individual',
          autograde: {
            enabled: true,
            execution_environment: 'lecturer_local',
            tests: [{ id: 'Task 1', type: 'run', command: 'make', points: 5 }],
          },
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=hand-edited`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Hand Edited', { timeout: 10000 });

    await page.getByRole('button', { name: 'Save as draft' }).first().click();

    const errors = page.locator('.validation-errors');
    await expect(errors).toBeVisible();
    await expect(errors).toContainText('Test "Task 1"');
    await expect(errors).toContainText('lowercase letters, numbers and dashes');
    await expect(errors).not.toContainText('must match pattern');
    await expect(errors).not.toContainText('/autograde/tests/0/id');
  });

  // "Autograding is on but no checks are defined" is no longer reachable from
  // the UI at all: the modal cannot save an empty configuration, and loading
  // one from a hand-edited YAML turns the flag off rather than preserving a
  // state whose only outcome is a failed save. The message stays for anything
  // that does reach the validator, covered against the real schema in
  // tests/assignment-validation-messages.test.mjs.
  test('An empty autograde block loads as off rather than as an unsaveable state', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'empty-ag': {
          schema_version: 1,
          id: 'empty-ag',
          title: 'Empty Autograde',
          organization: ORG,
          template: { owner: ORG, repository: 'starter-template' },
          repository_name_pattern: 'empty-ag-{github_login}',
          opens_at: new Date(Date.now() - 86400000).toISOString(),
          deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
          state: 'draft',
          assignment_type: 'individual',
          autograde: { enabled: true, execution_environment: 'lecturer_local', tests: [] },
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=empty-ag`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Empty Autograde', { timeout: 10000 });

    await expect(page.locator('.autograde-summary-text')).toHaveText('Off');
    await expect(page.getByRole('button', { name: 'Save as draft' }).first()).toBeEnabled();
    await page.getByRole('button', { name: 'Save as draft' }).first().click();
    await expect(page.locator('.toast', { hasText: /Saved empty-ag/i })).toBeVisible({ timeout: 10000 });
  });
});
