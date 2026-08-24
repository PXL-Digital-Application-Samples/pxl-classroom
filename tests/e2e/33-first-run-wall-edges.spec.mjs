// 33 - WS3 edge cases (UX_PLAN §5.1-§5.4)
//
// 32-first-run-wall.spec.mjs covers the happy shape of each of the four fixes.
// This file covers the states around them - the ones where an empty result, a
// failed request and a genuinely empty organization all look identical from the
// outside, and where the panel has to say which it is without guessing.
//
// Two real bugs came out of writing it, both the same shape as the roster one
// WS3 already fixed:
//
//   * `listOrgRepos` swallowed a failed page (`break` out of the pagination
//     loop, return what it had), so a 500 on BOTH template routes rendered
//     "This organization has no template repositories yet" - telling a lecturer
//     to create a template they may already have.
//   * `github_login` is the optional roster column and the only thing
//     `accept.mjs` matches on, so a roster imported before anyone handed in a
//     username let nobody accept while the form said "200 students on the
//     roster" in green.

import { test, expect } from '@playwright/test';
import { stringify as stringifyYaml } from 'yaml';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, openAutogradeModal } from '../fixtures/e2e-fixtures.mjs';

const rosterStatus = (page) => page.locator('.roster-status');
const templateEmpty = (page) => page.locator('.template-empty');
const templateError = (page) => page.locator('.text-danger', { hasText: 'Failed to load templates' });
const saveDraft = (page) => page.getByRole('button', { name: 'Save as draft' }).first();
const seedBtn = (page) => page.locator('button', { hasText: 'Seed teams from…' });
const summary = (page) => page.locator('.validation-errors');

const templateRepo = (name, isTemplate = true) => ({
  full_name: `${ORG}/${name}`,
  name,
  is_template: isTemplate,
});

/** Answer the `is:template` search. `null` items => the search itself fails. */
async function routeTemplateSearch(page, items, { status = 200, delayMs = 0 } = {}) {
  await page.route('**/search/repositories*', async (route) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (status !== 200) {
      await route.fulfill({ status, body: JSON.stringify({ message: 'nope' }) });
      return;
    }
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ total_count: items.length, items }),
    });
  });
}

/** Answer the REST fallback that runs only once the search has failed. */
async function routeOrgRepos(page, repos, { status = 200 } = {}) {
  await page.route(`**/orgs/${ORG}/repos*`, async (route) => {
    if (status !== 200) {
      await route.fulfill({ status, body: JSON.stringify({ message: 'nope' }) });
      return;
    }
    await route.fulfill({ status: 200, body: JSON.stringify(repos) });
  });
}

async function serveRoster(page, { students = null, status = 200, body = null } = {}) {
  await page.route('**/pxl-classroom-control/contents/students/roster.yml*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    if (status !== 200) {
      await route.fulfill({ status, body: JSON.stringify({ message: 'boom' }) });
      return;
    }
    const text = body ?? stringifyYaml({ schema_version: 1, students });
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ content: Buffer.from(text).toString('base64'), encoding: 'base64', sha: 'r1' }),
    });
  });
}

const student = (n, over = {}) => ({
  student_number: `S${n}`,
  full_name: `Student ${n}`,
  email: `s${n}@stud.pxl.be`,
  github_login: `student-${n}`,
  ...over,
});

async function openAdmin(page, opts = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, ...opts });
  await page.goto(`/dashboard/${ORG}/admin`);
  await expect(page.locator('.app-header-crumbs .app-header-heading')).toBeVisible({ timeout: 10000 });
}

async function openNewForm(page, opts = {}) {
  await openAdmin(page, opts);
  await page.locator('.new-btn').click();
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
}

async function fillMinimum(page, title) {
  await page.getByPlaceholder('e.g. Linux Processes 2026').fill(title);
  await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
}

const groupAssignment = (over = {}) => ({
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
  ...over,
});

// ================================================ §5.1 what "no templates" means

test.describe('33 - §5.1 An empty list, a failed request and an empty org are three different things', () => {
  test('When neither template route answers, the panel says so instead of claiming the org is empty', async ({ page }) => {
    // The regression this file was written to find. `listOrgTemplates` falls
    // back to `listOrgRepos` when the search fails, and that used to `break`
    // out of its pagination loop on a bad response and return []. The wall then
    // told a lecturer to go and create a template they may already have.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeTemplateSearch(page, [], { status: 500 });
    await routeOrgRepos(page, [], { status: 500 });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateError(page)).toBeVisible();
    await expect(templateEmpty(page)).toHaveCount(0);
  });

  test('The failure message names the failure, and the refresh button is still there', async ({ page }) => {
    // "Failed to load templates" with nothing after it is the same dead end in
    // a different costume: the lecturer needs to know it is worth retrying.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeTemplateSearch(page, [], { status: 500 });
    await routeOrgRepos(page, [], { status: 500 });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateError(page)).toContainText('HTTP 500');
    await expect(page.locator('.btn-refresh')).toBeEnabled();
  });

  test('When the search fails but the listing answers, an empty answer IS evidence', async ({ page }) => {
    // Search down, REST up, and the org really has no templates: the wall is
    // correct here and must still appear. Suppressing it on any search failure
    // would trade one wrong answer for another.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeTemplateSearch(page, [], { status: 403 });
    await routeOrgRepos(page, [templateRepo('notes', false), templateRepo('scratch', false)]);

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateEmpty(page)).toBeVisible();
    await expect(templateError(page)).toHaveCount(0);
  });

  test('An org full of repositories with the box unticked is the case the copy is written for', async ({ page }) => {
    // The most common real shape: plenty of repositories, none marked as a
    // template, so `is:template` returns nothing. The one sentence that
    // matters is the one about the checkbox.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeTemplateSearch(page, [templateRepo('starter', false), templateRepo('demo', false)]);

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateEmpty(page)).toBeVisible();
    await expect(templateEmpty(page)).toContainText('Template repository');
    await expect(templateEmpty(page)).toContainText('Settings');
  });

  test('A search still in flight shows the spinner, never a flash of the wall', async ({ page }) => {
    // The response is HELD until this test releases it, rather than delayed by
    // a timer: with a timer, the first assertion can itself outlast the delay
    // and the second one then runs after the load finished, so it passes
    // whatever the loading guard does. (It did. This test proved nothing until
    // a mutation said so.)
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.route('**/search/repositories*', async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ total_count: 1, items: [templateRepo('starter-template')] }),
      });
    });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    // Still loading, for as long as this test cares to look.
    await expect(page.locator('.loading-inline')).toBeVisible();
    await expect(templateEmpty(page)).toHaveCount(0);
    await expect(page.locator('.loading-inline')).toBeVisible();

    release();
    await expect(page.locator('text=Found 1 template repositories')).toBeVisible({ timeout: 5000 });
    await expect(templateEmpty(page)).toHaveCount(0);
  });

  test('Refresh keeps the promise the copy makes: the new template appears', async ({ page }) => {
    // "Come back and press refresh - it will appear in the list." A wall that
    // says that and then needs a page reload is a fifth dead end.
    let created = false;
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.route('**/search/repositories*', async (route) => {
      const items = created ? [templateRepo('brand-new-template')] : [];
      await route.fulfill({ status: 200, body: JSON.stringify({ total_count: items.length, items }) });
    });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await expect(templateEmpty(page)).toBeVisible();

    created = true; // the lecturer ticked the box in another tab
    await page.locator('.btn-refresh').click();

    await expect(templateEmpty(page)).toHaveCount(0);
    await expect(page.getByPlaceholder('Type or select a template repository')).toHaveValue(
      `${ORG}/brand-new-template`,
      { timeout: 5000 },
    );
  });

  test('Editing an assignment in a template-less org is not a dead end, and shows no wall', async ({ page }) => {
    // An org can lose its last template - untick the box, delete the repo -
    // long after an assignment was built from it. The editor pins the
    // assignment's OWN template into the list, so the search returning nothing
    // does not make the list empty and the wall correctly stays away: there is
    // a template on screen, and telling this lecturer to go and create one
    // would be the same false claim the wall exists to avoid.
    const contentWrites = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'solo-lab': groupAssignment({
          id: 'solo-lab',
          title: 'Solo Lab',
          assignment_type: 'individual',
          repository_name_pattern: 'solo-lab-{github_login}',
          group_config: undefined,
        }),
      },
      contentWrites,
    });
    await routeTemplateSearch(page, []);

    await page.goto(`/dashboard/${ORG}/admin?edit=solo-lab`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Solo Lab', { timeout: 10000 });

    await expect(templateEmpty(page)).toHaveCount(0);
    await expect(page.getByPlaceholder('Type or select a template repository')).toHaveValue(`${ORG}/starter-template`);

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Solo Lab renamed');
    await saveDraft(page).click();

    await expect
      .poll(() => contentWrites.find((w) => w.path === 'assignments/solo-lab.yml'), { timeout: 10000 })
      .toBeTruthy();
    const written = contentWrites.find((w) => w.path === 'assignments/solo-lab.yml').content;
    expect(written).toContain('repository: starter-template');
  });

  test('The wall is for the create form, where there is no template pinned in', async ({ page }) => {
    // The complement of the test above: same org, same empty search, but a new
    // assignment has nothing to pin, so the list really is empty and the wall
    // is the right answer.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeTemplateSearch(page, []);
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateEmpty(page)).toBeVisible();
  });

  test('The wall does not add a second primary button to the view', async ({ page }) => {
    // DESIGN.md §1.2 - the editor's one primary is Save & publish.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeTemplateSearch(page, []);
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateEmpty(page)).toBeVisible();
    await expect(templateEmpty(page).locator('.btn-primary')).toHaveCount(0);
    await expect(templateEmpty(page).locator('a.btn-secondary')).toHaveCount(1);
  });
});

// ============================================== §5.2 what the roster count means

test.describe('33 - §5.2 The roster count answers "can anyone accept?"', () => {
  test('Importing a roster updates the count on the form, with no reload', async ({ page }) => {
    // The count crosses a component boundary: RosterTab reads the file,
    // AdminView renders the number. Nothing but an end-to-end run exercises
    // the pair, and re-reading the file in AdminView would have been a second
    // request and a second answer.
    await openNewForm(page);
    await expect(rosterStatus(page)).toContainText('nobody can accept');

    await page.locator('.primer-tab', { hasText: 'Roster' }).click();
    await page.locator('textarea').first().fill(
      'student_number,full_name,email,github_login\n' +
        '0001,Alice Example,alice@stud.pxl.be,alice-test\n' +
        '0002,Bob Example,bob@stud.pxl.be,bob-test\n',
    );
    const commit = page.getByRole('button', { name: /Commit roster/i });
    await expect(commit).toBeEnabled({ timeout: 10000 });
    await commit.click();
    await expect(page.locator('.toast', { hasText: /Roster committed/i })).toBeVisible({ timeout: 10000 });

    await page.locator('.primer-tab', { hasText: 'Assignments' }).click();
    await expect(rosterStatus(page)).toContainText('2 students on the roster');
    await expect(rosterStatus(page).locator('.status-dot.dot-success')).toBeVisible();
  });

  test('A roster that will not parse is not an empty roster', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await serveRoster(page, { body: 'students: { unterminated\n' });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(rosterStatus(page)).toContainText('Students must appear in');
    await expect(rosterStatus(page)).not.toContainText('No students imported yet');
    await expect(rosterStatus(page).locator('.status-dot')).toHaveCount(0);
  });

  test('A roster file with no students key is a known zero', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await serveRoster(page, { body: 'schema_version: 1\n' });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(rosterStatus(page)).toContainText('No students imported yet - nobody can accept');
  });

  test('A roster nobody has linked to GitHub yet stops every acceptance, and says so', async ({ page }) => {
    // `github_login` is optional in the CSV and is the only field accept.mjs
    // matches on. "200 students on the roster" is true and answers the wrong
    // question.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await serveRoster(page, {
      students: [1, 2, 3].map((n) => student(n, { github_login: null })),
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(rosterStatus(page)).toContainText('3 students on the roster');
    await expect(rosterStatus(page)).toContainText('none has a GitHub username yet - nobody can accept');
    await expect(rosterStatus(page).locator('.status-dot.dot-warning')).toBeVisible();
  });

  test('A partly linked roster counts the stragglers without crying wolf', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await serveRoster(page, {
      students: [student(1), student(2), student(3, { github_login: '' }), student(4, { github_login: null })],
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    // Some students CAN accept, so this is not a warning.
    await expect(rosterStatus(page).locator('.status-dot.dot-success')).toBeVisible();
    await expect(rosterStatus(page)).toContainText('4 students on the roster');
    await expect(rosterStatus(page)).toContainText('2 without a GitHub username yet');
  });

  test('A fully linked roster says nothing about usernames', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await serveRoster(page, { students: [student(1), student(2)] });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(rosterStatus(page)).toContainText('2 students on the roster.');
    await expect(rosterStatus(page)).not.toContainText('without a GitHub username');
  });

  test('The count is on the editor for an existing assignment too', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { 'group-lab': groupAssignment({ roster_mode: 'enforced' }) },
    });
    await serveRoster(page, { students: [student(1), student(2), student(3)] });

    await page.goto(`/dashboard/${ORG}/admin?edit=group-lab`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Group Lab', { timeout: 10000 });
    await expect(rosterStatus(page)).toContainText('3 students on the roster');
  });

  test('Switching to open and back restores the gate and its status', async ({ page }) => {
    await openNewForm(page);
    const select = page.locator('select').filter({ hasText: 'only students on the roster' });

    await expect(rosterStatus(page)).toBeVisible();
    await select.selectOption('open');
    await expect(rosterStatus(page)).toHaveCount(0);
    await select.selectOption('enforced');
    await expect(rosterStatus(page)).toContainText('nobody can accept');
  });
});

// ================================================== §5.3 the seed control

test.describe('33 - §5.3 The seed control appears exactly when it can work', () => {
  test('Saving a new group assignment brings it in, without a reload', async ({ page }) => {
    await openNewForm(page);
    await page.locator('input[type="radio"][value="group"]').check();
    await expect(seedBtn(page)).toHaveCount(0);

    await fillMinimum(page, 'Fresh Group Lab');
    await saveDraft(page).click();
    await expect(page.locator('.toast', { hasText: /Saved fresh-group-lab/i })).toBeVisible({ timeout: 10000 });

    // The assignment now has an id, so teams have somewhere to live.
    await expect(seedBtn(page)).toBeVisible();
    await expect(seedBtn(page)).toBeEnabled();
  });

  test('Unsaved edits disable it and say why, rather than seeding a stale team size', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { 'group-lab': groupAssignment() } });
    await page.goto(`/dashboard/${ORG}/admin?edit=group-lab`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Group Lab', { timeout: 10000 });

    await expect(seedBtn(page)).toBeEnabled();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Group Lab edited');
    await expect(seedBtn(page)).toBeDisabled();
    await expect(page.locator('text=Save your changes first')).toBeVisible();
  });

  test('An individual assignment never offers it at all', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'solo-lab': groupAssignment({
          id: 'solo-lab',
          title: 'Solo Lab',
          assignment_type: 'individual',
          repository_name_pattern: 'solo-lab-{github_login}',
          group_config: undefined,
        }),
      },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=solo-lab`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Solo Lab', { timeout: 10000 });

    await expect(seedBtn(page)).toHaveCount(0);
    await expect(page.locator('text=Starting teams')).toHaveCount(0);
  });
});

// ================================================ §5.4 validation messages

test.describe('33 - §5.4 Nothing in the summary is addressed to a schema author', () => {
  // The modal refuses every one of these before Save (UX_PLAN §6.3), so they
  // arrive from a YAML someone edited by hand - which is exactly when raw AJV
  // was worst: there is no control on screen to point the JSON Pointer at.
  async function autogradeWith(page, tests, opts = {}) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'edge-lab': groupAssignment({
          id: 'edge-lab',
          title: 'Validation Edge Lab',
          assignment_type: 'individual',
          repository_name_pattern: 'edge-lab-{github_login}',
          group_config: undefined,
          autograde: { enabled: true, execution_environment: 'lecturer_local', tests },
        }),
      },
      ...opts,
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=edge-lab`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Validation Edge Lab', {
      timeout: 10000,
    });
  }

  test('Several bad checks are all translated, and no JSON Pointer survives', async ({ page }) => {
    await autogradeWith(page, [
      { id: 'Task 1', type: 'run', command: 'make' },
      { id: 'second_check', type: 'run', command: 'make' },
    ]);
    await saveDraft(page).click();

    await expect(summary(page)).toBeVisible();
    await expect(summary(page)).toContainText('Test "Task 1"');
    await expect(summary(page)).toContainText('Test "second_check"');
    for (const raw of ['must match pattern', '/autograde/tests', '(root)', '^[a-z0-9]']) {
      await expect(summary(page)).not.toContainText(raw);
    }
  });

  test('A check with no id at all is asked for by position, not quoted as an empty name', async ({ page }) => {
    // `Test ""` is not a name. The id is the one field whose invalid value is
    // worth quoting back - unless there isn't one.
    await autogradeWith(page, [{ id: '', type: 'run', command: 'make' }]);
    await saveDraft(page).click();

    await expect(summary(page)).toContainText('Test 1: give it an ID');
    await expect(summary(page)).not.toContainText('Test ""');
  });

  test('Negative points are refused in words, and the check is named by its id', async ({ page }) => {
    await autogradeWith(page, [{ id: 'compile', type: 'run', command: 'make', points: -3 }]);
    await saveDraft(page).click();

    await expect(summary(page)).toContainText('Test "compile": points must be a number and cannot be negative');
    await expect(summary(page)).not.toContainText('minimum');
  });

  test('A team size below the floor quotes the floor from the schema', async ({ page }) => {
    await openNewForm(page);
    await fillMinimum(page, 'Tiny Team Lab');
    await page.locator('input[type="radio"][value="group"]').check();
    await page.locator('input[type="number"][min="2"]').first().fill('1');
    await saveDraft(page).click();

    await expect(summary(page)).toContainText('Maximum team size must be at least 2.');
    await expect(summary(page)).not.toContainText('/group_config');
  });

  test('Fixing the error in the modal clears the summary and the save goes through', async ({ page }) => {
    const contentWrites = [];
    await autogradeWith(page, [{ id: 'Task 1', type: 'run', command: 'make', points: 5 }], { contentWrites });
    await saveDraft(page).click();
    await expect(summary(page)).toBeVisible();

    // The repair happens where the check lives.
    await openAutogradeModal(page);
    await page.getByLabel('Check 1 ID').fill('task-1');
    await page.getByRole('button', { name: 'Save checks' }).click();
    await saveDraft(page).click();

    await expect(page.locator('.toast', { hasText: /Saved edge-lab/i })).toBeVisible({ timeout: 10000 });
    await expect(summary(page)).toHaveCount(0);
    expect(contentWrites.some((w) => w.path === 'assignments/edge-lab.yml')).toBe(true);
  });

  test('A field-level error is reported once, beside its field, not twice', async ({ page }) => {
    // A scriptless python check is refused by fieldErrors before validate() can
    // run, so the summary block must stay empty rather than repeating it in
    // schema language further down the form.
    await autogradeWith(page, [{ id: 'validator', type: 'python', points: 5 }]);

    await expect(page.locator('.autograde-summary .field-error-msg')).toContainText('needs a script');
    await expect(summary(page)).toHaveCount(0);
    await expect(saveDraft(page)).toBeDisabled();
  });
});

// ===================================================== a template that is a fork

test.describe('33 - A forked template is still a template', () => {
  /**
   * GitHub's repository search, faithfully: forks are omitted unless the query
   * says `fork:true`. The route reads the real query string rather than being
   * told the answer, so it fails if the qualifier is dropped again.
   */
  async function routeSearchLikeGitHub(page, { forks = [], plain = [] } = {}) {
    await page.route('**/search/repositories*', async (route) => {
      const q = decodeURIComponent(new URL(route.request().url()).searchParams.get('q') || '');
      const items = /\bfork:true\b/.test(q) ? [...plain, ...forks] : [...plain];
      await route.fulfill({ status: 200, body: JSON.stringify({ total_count: items.length, items }) });
    });
  }

  test('A template that is a fork appears in the picker', async ({ page }) => {
    // Reported live 2026-08-24: a colleague made PXL-2TIN-NetAdv-26-27, forked
    // a public template into it, and it never showed up - no error anywhere,
    // `is_template: true` on the repository, and the wall telling them the org
    // had no templates. GitHub search hides forks by default, and the REST
    // fallback that would have found it only runs when the search FAILS. This
    // search succeeded; it just answered a question nobody meant to ask.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeSearchLikeGitHub(page, { forks: [templateRepo('Guts-DotNetAdvanced-2627')] });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateEmpty(page), 'the org has a template - the wall is a false claim').toHaveCount(0);
    await expect(page.getByPlaceholder('Type or select a template repository')).toHaveValue(
      `${ORG}/Guts-DotNetAdvanced-2627`,
      { timeout: 5000 },
    );
  });

  test('An org whose only templates are forks is not told it has none', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeSearchLikeGitHub(page, { forks: [templateRepo('forked-a'), templateRepo('forked-b')] });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await expect(page.locator('text=Found 2 template repositories')).toBeVisible({ timeout: 5000 });
  });

  test('Forks come in ADDITION to the rest, not instead of them', async ({ page }) => {
    // `fork:true` includes forks alongside non-forks; `fork:only` would have
    // swapped one blind spot for the opposite one.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeSearchLikeGitHub(page, {
      plain: [templateRepo('made-here')],
      forks: [templateRepo('forked-in')],
    });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await expect(page.locator('text=Found 2 template repositories')).toBeVisible({ timeout: 5000 });
  });
});

// ============================================================== cross-cutting

test.describe('33 - Both walls at once', () => {
  test('A brand new organization gets the template wall and the roster warning together', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeTemplateSearch(page, []);
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateEmpty(page)).toBeVisible();
    await expect(rosterStatus(page)).toContainText('nobody can accept');
    // Neither is a modal or an overlay: both are answerable in place.
    await expect(page.getByPlaceholder('Type or select a template repository')).toBeVisible();
    await expect(page.locator('select').filter({ hasText: 'only students on the roster' })).toBeVisible();
  });
});
