// 31 - WS1: the controls stop claiming things that are not true
// (UX_PLAN §3.1, §3.3, §3.4, §3.5)
//
// These run edge to edge rather than against the component alone: the lecturer
// fills the real form, the SPA commits real YAML through the Contents API, and
// the spec then parses those exact bytes, validates them against the shipped
// schema, and - for autograding - feeds them to the real
// `buildAutogradingWorkflow`. That seam is where the bugs lived. Every one of
// them was a form and a backend that agreed on a field name and disagreed on
// what it meant, which no test of either half alone can see.

import { test, expect } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import {
  ORG,
  LECTURER,
  STUDENT_1,
  injectAuth,
  setupStandardMockRoutes,
  inviteUrl,
  openAutogradeModal,
  addCheck,
  CHECK_RUN,
  CHECK_PYTHON,
} from '../fixtures/e2e-fixtures.mjs';
import { validateAgainst } from '../../lib/validate.mjs';
import { buildAutogradingWorkflow } from '../../provisioning/provision.mjs';

// ---------------------------------------------------------------- helpers

const rosterSelect = (page) => page.locator('select').filter({ hasText: 'only students on the roster' });
const capInput = (page) => page.locator('input[type="number"][min="1"]').first();
const saveDraft = (page) => page.getByRole('button', { name: 'Save as draft' }).first();
const advanced = (page) => page.locator('details.advanced');

/** The most recent commit of assignments/<id>.yml, parsed. */
function committed(contentWrites, id) {
  const write = [...contentWrites].reverse().find((w) => w.path === `assignments/${id}.yml`);
  return write ? parseYaml(write.content) : null;
}

/** Fill the minimum a new assignment needs before Save is enabled. */
async function fillMinimum(page, title) {
  await page.getByPlaceholder('e.g. Linux Processes 2026').fill(title);
  await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
}

async function openNewAssignmentForm(page, opts = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, ...opts });
  await page.goto(`/dashboard/${ORG}/admin`);
  await expect(page.locator('.app-header-crumbs .app-header-heading')).toBeVisible({ timeout: 10000 });
  await page.locator('.new-btn').click();
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
}

async function openEditorFor(page, assignment, opts = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [assignment.id]: assignment },
    ...opts,
  });
  await page.goto(`/dashboard/${ORG}/admin?edit=${assignment.id}`);
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue(assignment.title, {
    timeout: 10000,
  });
}

const draftAssignment = (over = {}) => ({
  schema_version: 1,
  id: 'existing-lab',
  title: 'Existing Lab',
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: 'existing-lab-{github_login}',
  opens_at: new Date(Date.now() - 86400000).toISOString(),
  deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
  state: 'draft',
  assignment_type: 'individual',
  ...over,
});

// ============================================================ §3.1 roster gate

test.describe('31 - §3.1 The roster gate is the default a new assignment is saved with', () => {
  test('A new assignment is committed as roster_mode: enforced, and validates', async ({ page }) => {
    const contentWrites = [];
    await openNewAssignmentForm(page, { contentWrites });
    await fillMinimum(page, 'Roster Default Lab');
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'roster-default-lab'), { timeout: 10000 }).toBeTruthy();
    const doc = committed(contentWrites, 'roster-default-lab');

    // The form used to write 'open' here while its own hint said "Anyone with
    // the link can claim a repo".
    expect(doc.roster_mode).toBe('enforced');
    const { valid, errors } = validateAgainst('assignment', doc);
    expect(valid, JSON.stringify(errors)).toBe(true);
  });

  test('Open enrollment cannot be saved without a cap, and the message is next to the field', async ({ page }) => {
    const contentWrites = [];
    await openNewAssignmentForm(page, { contentWrites });
    await fillMinimum(page, 'Exam Open Lab');

    // Empty cap is fine under `enforced` - it is only the roster gate's absence
    // that makes the cap the last limit standing.
    await capInput(page).fill('');
    await expect(saveDraft(page)).toBeEnabled();

    await rosterSelect(page).selectOption('open');
    await expect(page.locator('.field-error-msg', { hasText: 'Open enrollment requires a cap' })).toBeVisible();
    await expect(saveDraft(page)).toBeDisabled();

    await capInput(page).fill('25');
    await expect(saveDraft(page)).toBeEnabled();
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'exam-open-lab'), { timeout: 10000 }).toBeTruthy();
    const doc = committed(contentWrites, 'exam-open-lab');
    expect(doc.roster_mode).toBe('open');
    expect(doc.max_acceptances).toBe(25);
    expect(validateAgainst('assignment', doc).valid).toBe(true);
  });

  test('Editing an assignment that is already open leaves it open', async ({ page }) => {
    // The new default governs new assignments only. Re-gating a live exam
    // whose cohort is not on any roster would reject every remaining student.
    const contentWrites = [];
    await openEditorFor(page, draftAssignment({ roster_mode: 'open', max_acceptances: 40 }), { contentWrites });
    await expect(rosterSelect(page)).toHaveValue('open');

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Existing Lab renamed');
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'existing-lab'), { timeout: 10000 }).toBeTruthy();
    const doc = committed(contentWrites, 'existing-lab');
    expect(doc.roster_mode).toBe('open');
    expect(doc.max_acceptances).toBe(40);
  });

  test('A hand-edited roster_mode the backend does not recognise loads as enforced', async ({ page }) => {
    // `accept.mjs` and `pages/generate.mjs` both treat "Open" as `enforced`.
    // The form has to agree, or the panel shows a permissive setting that is
    // not in force - and saving normalises the YAML to what is actually true.
    const contentWrites = [];
    await openEditorFor(page, draftAssignment({ roster_mode: 'Open' }), { contentWrites });
    await expect(rosterSelect(page)).toHaveValue('enforced');

    await saveDraft(page).click();
    await expect.poll(() => committed(contentWrites, 'existing-lab'), { timeout: 10000 }).toBeTruthy();
    expect(committed(contentWrites, 'existing-lab').roster_mode).toBe('enforced');
  });
});

// ======================================================= §3.3 acceptance_mode

test.describe('31 - §3.3 Acceptance mode is not a question, and not deleted either', () => {
  test('Advanced keeps every other control and drops only this one', async ({ page }) => {
    await openNewAssignmentForm(page);
    await advanced(page).locator('summary').click();

    for (const kept of ['Student permission', 'Submission ref', 'Timezone']) {
      await expect(advanced(page)).toContainText(kept);
    }
    await expect(advanced(page)).not.toContainText('Acceptance mode');
    await expect(advanced(page).locator('select')).toHaveCount(1); // student_permission only
  });

  test('Saving an edited assignment still writes acceptance_mode', async ({ page }) => {
    // buildDoc rebuilds the whole document, so a field with no control is a
    // field one careless refactor away from being deleted from every YAML -
    // the same trap that silently retired invitation links (CLAUDE.md).
    const contentWrites = [];
    await openEditorFor(page, draftAssignment({ acceptance_mode: 'self-service' }), { contentWrites });
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Existing Lab v2');
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'existing-lab'), { timeout: 10000 }).toBeTruthy();
    const doc = committed(contentWrites, 'existing-lab');
    expect(doc.acceptance_mode).toBe('self-service');
    expect(validateAgainst('assignment', doc).valid).toBe(true);
  });
});

// ======================================================== §3.4 python autograde

test.describe('31 - §3.4 A python test means one thing, from the form to the workflow', () => {
  // The checks live in a modal now (UX_PLAN §6). A python preset arrives with
  // a working script, so an EMPTY one has to be made by clearing it.
  async function addPythonTest(page, { id, script, index = 0 }) {
    await addCheck(page, CHECK_PYTHON);
    await page.getByLabel(`Check ${index + 1} ID`).fill(id);
    await page.getByLabel(`Check ${index + 1} Python script`).fill(script ?? '');
  }

  async function openChecks(page, title, opts = {}) {
    await openNewAssignmentForm(page, opts);
    await fillMinimum(page, title);
    await openAutogradeModal(page);
  }

  const saveChecks = (page) => page.getByRole('button', { name: 'Save checks' });

  test('The script survives the form, the YAML, the schema and the generated workflow', async ({ page }) => {
    // A double quote and a colon are what broke the string-concatenated
    // generator (F15) in every student repository at once, so the round trip
    // is exercised with both in the source.
    const script = 'import sys\nprint("hello: world")\nsys.exit(0)\n';
    const contentWrites = [];
    await openChecks(page, 'Python Lab', { contentWrites });

    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await page.locator('input[value="public"]').check();
    await addPythonTest(page, { id: 'validator', script });
    await saveChecks(page).click();

    await saveDraft(page).click();
    await expect.poll(() => committed(contentWrites, 'python-lab'), { timeout: 10000 }).toBeTruthy();
    const doc = committed(contentWrites, 'python-lab');

    // 1. The form wrote `script`, and nothing that used to compete with it.
    const [t] = doc.autograde.tests;
    expect(t.type).toBe('python');
    expect(t.script).toBe(script);
    expect(t).not.toHaveProperty('command');
    expect(t).not.toHaveProperty('setup_command');

    // 2. The schema accepts it.
    const { valid, errors } = validateAgainst('assignment', doc);
    expect(valid, JSON.stringify(errors)).toBe(true);

    // 3. The real generator turns it into a workflow that runs THAT script.
    const workflow = parseYaml(buildAutogradingWorkflow(doc, ORG));
    const [, write, grade] = workflow.jobs.grade.steps;
    expect(write.env.PXL_SCRIPT).toBe(script);
    expect(write.env.PXL_SCRIPT_PATH).toBe('.pxl-autograde/validator.py');
    expect(write.run).not.toContain('hello: world'); // env, never the run text
    expect(grade.uses).toBe('classroom-resources/autograding-python-grader@v1');
    expect(grade.with.command).toBe('python3 .pxl-autograde/validator.py');
    expect(JSON.stringify(grade.with)).not.toContain('pytest');
  });

  test('A python test with no script cannot be saved, and the row says why', async ({ page }) => {
    await openChecks(page, 'Scriptless Lab');
    await addPythonTest(page, { id: 'validator', script: '' });

    await expect(page.locator('.autograde-setup-modal .field-error-msg')).toContainText('needs a script');
    await expect(saveChecks(page)).toBeDisabled();

    await page.getByLabel('Check 1 Python script').fill('assert True');
    await expect(page.locator('.autograde-setup-modal .field-error-msg')).toHaveCount(0);
    await expect(saveChecks(page)).toBeEnabled();
  });

  test('A scriptless python check in a hand-written YAML is caught on the form', async ({ page }) => {
    // The modal cannot produce this state, but a YAML edited by hand can - and
    // the schema rejects it, so the form has to say so in words rather than
    // letting Save fail on a JSON Pointer.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'hand-edited': draftAssignment({
          id: 'hand-edited',
          title: 'Hand Edited',
          autograde: {
            enabled: true,
            execution_environment: 'lecturer_local',
            tests: [
              { id: 'first', type: 'python', points: 1 },
              { id: 'second', type: 'python', points: 1 },
            ],
          },
        }),
      },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=hand-edited`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Hand Edited', { timeout: 10000 });

    const err = page.locator('.autograde-summary .field-error-msg');
    await expect(err).toContainText('first, second');
    await expect(err).toContainText('need a script');
    await expect(saveDraft(page)).toBeDisabled();
  });

  test('Whitespace is not a script', async ({ page }) => {
    // `python3` over a file of spaces exits 0, which is a test that passes
    // without running anything - the exact failure the `script` requirement
    // exists to stop.
    await openChecks(page, 'Blank Script Lab');
    await addPythonTest(page, { id: 'validator', script: '   \n  \n' });

    await expect(page.locator('.autograde-setup-modal .field-error-msg')).toContainText('needs a script');
    await expect(saveChecks(page)).toBeDisabled();
  });

  test('A check saved as python carries no command behind it', async ({ page }) => {
    const contentWrites = [];
    await openChecks(page, 'Switched Lab', { contentWrites });

    // Start from the command preset, which fills `command`, then replace it
    // with a python check: the row the modal writes must carry only `script`.
    await addCheck(page, CHECK_RUN);
    await addPythonTest(page, { id: 'validator', script: 'assert True', index: 1 });
    await page.locator('.ag-table tbody tr').first().getByRole('button', { name: /Remove check/ }).click();
    await saveChecks(page).click();

    await saveDraft(page).click();
    await expect.poll(() => committed(contentWrites, 'switched-lab'), { timeout: 10000 }).toBeTruthy();
    const [t] = committed(contentWrites, 'switched-lab').autograde.tests;

    // A leftover `command` on a python test is a field the schema forbids and
    // the generator would once have preferred.
    expect(t).not.toHaveProperty('command');
    expect(t.script).toBe('assert True');
    expect(validateAgainst('assignment', committed(contentWrites, 'switched-lab')).valid).toBe(true);
  });

  test('Two python tests get their own script files and their own results', async ({ page }) => {
    const contentWrites = [];
    await openChecks(page, 'Two Python Lab', { contentWrites });
    await page.getByRole('radio', { name: /In each student's repo/ }).check();
    await page.locator('input[value="public"]').check();
    await addPythonTest(page, { id: 'first', script: 'assert 1 == 1', index: 0 });
    await addPythonTest(page, { id: 'second', script: 'assert 2 == 2', index: 1 });
    await saveChecks(page).click();

    await saveDraft(page).click();
    await expect.poll(() => committed(contentWrites, 'two-python-lab'), { timeout: 10000 }).toBeTruthy();
    const doc = committed(contentWrites, 'two-python-lab');

    const workflow = parseYaml(buildAutogradingWorkflow(doc, ORG));
    const steps = workflow.jobs.grade.steps;
    expect(steps).toHaveLength(6); // checkout + (write + grade) x2 + reporter

    const paths = steps.filter((s) => s.env?.PXL_SCRIPT_PATH).map((s) => s.env.PXL_SCRIPT_PATH);
    expect(paths).toEqual(['.pxl-autograde/first.py', '.pxl-autograde/second.py']);
    expect(steps.filter((s) => s.env?.PXL_SCRIPT).map((s) => s.env.PXL_SCRIPT))
      .toEqual(['assert 1 == 1', 'assert 2 == 2']);

    const reporter = steps.at(-1);
    expect(reporter.with.runners).toBe('first,second');
    expect(reporter.env.FIRST_RESULTS).toBe('${{ steps.first.outputs.result }}');
    expect(reporter.env.SECOND_RESULTS).toBe('${{ steps.second.outputs.result }}');
  });
});

// ========================================================== §3.5 draft count

test.describe('31 - §3.5 The draft count reads state, and copes with what it cannot read', () => {
  const asgn = (id, over = {}) => ({
    id,
    title: id,
    organization: ORG,
    assignment_type: 'individual',
    roster_mode: 'enforced',
    state: 'draft',
    template: { owner: ORG, repository: 'a-template' },
    repository_name_pattern: `${id}-{github_login}`,
    ...over,
  });

  /** Serve a specific assignment YAML path with arbitrary bytes, or a status. */
  async function overrideFile(page, id, { body = null, status = 200 } = {}) {
    await page.route(`**/pxl-classroom-control/contents/assignments/${id}.yml*`, async (route) => {
      if (body === null) {
        await route.fulfill({ status, body: JSON.stringify({ message: 'Not Found' }) });
        return;
      }
      await route.fulfill({
        status,
        body: JSON.stringify({ content: Buffer.from(body).toString('base64'), encoding: 'base64' }),
      });
    });
  }

  async function openDashboard(page, assignments) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      participatingOrgs: [ORG],
      currentUser: LECTURER,
      assignments,
      reports: {}, // no dashboard.json - this is the fallback branch
    });
  }

  test('A file that will not parse is not counted as a draft', async ({ page }) => {
    await openDashboard(page, {
      'a-draft': asgn('a-draft'),
      'b-published': asgn('b-published', { state: 'published' }),
      'c-broken': asgn('c-broken'),
    });
    // Unterminated flow collection - the YAML parser throws on it.
    await overrideFile(page, 'c-broken', { body: 'title: { unterminated\n' });

    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('h2', { hasText: /No dashboard data yet/i })).toBeVisible();
    // Only a-draft. Counting files said three; counting optimistically says two.
    await expect(page.locator('text=You have 1 draft in the Admin Panel')).toBeVisible();
  });

  test('A missing state is a draft, and a file that 404s is nothing at all', async ({ page }) => {
    await openDashboard(page, {
      'no-state': asgn('no-state'),
      'vanished': asgn('vanished'),
    });
    // The schema's default for `state` is draft, so an absent key is a draft.
    await overrideFile(page, 'no-state', { body: 'schema_version: 1\nid: no-state\ntitle: No State\n' });
    // Listed a moment ago, gone by the time it is read: a race, not a draft.
    await overrideFile(page, 'vanished', { status: 404 });

    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('text=You have 1 draft in the Admin Panel')).toBeVisible();
  });

  test('When nothing can be read at all, the panel still says something true', async ({ page }) => {
    await openDashboard(page, { 'x': asgn('x'), 'y': asgn('y') });
    await overrideFile(page, 'x', { status: 500 });
    await overrideFile(page, 'y', { status: 500 });

    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('h2', { hasText: /No dashboard data yet/i })).toBeVisible();
    await expect(page.locator('text=Published assignments appear here once the first report is generated')).toBeVisible();
    await expect(page.locator('text=in the Admin Panel - publish to track them here')).not.toBeVisible();
  });

  test('Every assignment in draft is still counted, and pluralised', async ({ page }) => {
    await openDashboard(page, { 'd1': asgn('d1'), 'd2': asgn('d2'), 'p1': asgn('p1', { state: 'closed' }) });

    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('text=You have 2 drafts in the Admin Panel')).toBeVisible();
  });
});

// ================================================== the cap that was invented

test.describe('31 - An absent cap is no cap', () => {
  test('A student is not turned away from an assignment that has no limit', async ({ page }) => {
    // `accept.mjs` enforces the cap only `if (maxAcceptances && ...)`, so an
    // absent field means unlimited. The card published `?? 150` and the view
    // read `?? 150`, which refused student 151 an acceptance the server would
    // have granted.
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      userRepos: [],
      assignments: {
        'uncapped': {
          id: 'uncapped',
          title: 'Uncapped Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          opens_at: new Date(Date.now() - 3600000).toISOString(),
          deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
          repository_name_pattern: 'uncapped-{github_login}',
          broker_repo: 'broker-uncapped',
          accepted_count: 999,
          // max_acceptances deliberately absent
        },
      },
    });

    await page.goto(inviteUrl(ORG, 'uncapped'));
    await expect(page.locator('h2', { hasText: 'Accept assignment' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('h2', { hasText: 'Registration cap reached' })).toHaveCount(0);
  });

  test('A real cap still turns a student away', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      userRepos: [],
      assignments: {
        'capped': {
          id: 'capped',
          title: 'Capped Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          opens_at: new Date(Date.now() - 3600000).toISOString(),
          deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
          repository_name_pattern: 'capped-{github_login}',
          broker_repo: 'broker-capped',
          max_acceptances: 2,
          accepted_count: 2,
        },
      },
    });

    await page.goto(inviteUrl(ORG, 'capped'));
    await expect(page.locator('h2', { hasText: 'Registration cap reached' })).toBeVisible({ timeout: 10000 });
  });

  test('Editing an uncapped assignment does not quietly cap it', async ({ page }) => {
    // The edit form loaded `a.max_acceptances ?? 50`, and buildDoc rebuilds the
    // whole document - so opening an uncapped assignment to fix a typo wrote a
    // cap of 50 into it.
    const contentWrites = [];
    await openEditorFor(page, draftAssignment(), { contentWrites }); // no max_acceptances
    await expect(capInput(page)).toHaveValue('');

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Existing Lab, still uncapped');
    await saveDraft(page).click();

    await expect.poll(() => committed(contentWrites, 'existing-lab'), { timeout: 10000 }).toBeTruthy();
    expect(committed(contentWrites, 'existing-lab')).not.toHaveProperty('max_acceptances');
  });

  test('A new assignment starts at the documented default', async ({ page }) => {
    const contentWrites = [];
    await openNewAssignmentForm(page, { contentWrites });
    await expect(capInput(page)).toHaveValue('50');

    await fillMinimum(page, 'Default Cap Lab');
    await saveDraft(page).click();
    await expect.poll(() => committed(contentWrites, 'default-cap-lab'), { timeout: 10000 }).toBeTruthy();
    expect(committed(contentWrites, 'default-cap-lab').max_acceptances).toBe(50);
  });
});
