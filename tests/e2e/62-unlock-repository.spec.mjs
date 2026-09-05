// 62 - Reopening a student repository after the deadline.
//
// Lockdown is meant to be permanent for a cohort, and for a cohort it is. But a
// deadline is a rule about a cohort and a repository belongs to a person, so
// "no way back" was the wrong answer: a certificate that arrives after the
// freeze, an appeal upheld, a resit in the same repository, a repository frozen
// by a run that should not have included it.
//
// Doing it by hand means an org owner deleting a ruleset in the GitHub UI, with
// nothing written down anywhere - and a grade dispute months later asks whether
// this student could have pushed after the deadline. That question needs a
// document, not a memory, so the unlock writes one.
//
// Two things this spec exists to pin:
//
//   PRESERVATION FIRST. Unlocking before the deadline snapshot is in the
//   archive lets the thing being graded move underneath the grade.
//
//   THE RULESET IS DISABLED, NEVER DELETED. `enforcement` is a flag
//   (lib/submission-lock.mjs). A deleted ruleset re-created later without the
//   App in `bypass_actors` would lock this system out of the repository along
//   with the student.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'linux-processes-2026';
const STUDENT = 'student-personal';
const REPO = `${ID}-${STUDENT}`;
const SHA = 'a'.repeat(40);
const RULESET_ID = 77;

const assignment = (over = {}) => ({
  id: ID,
  title: 'Linux Processes 2026',
  organization: ORG,
  state: 'closed',
  assignment_type: 'individual',
  roster_mode: 'enforced',
  max_acceptances: 50,
  opens_at: '2026-09-01T08:00:00Z',
  deadline_at: '2026-09-20T20:00:00Z',
  template: { owner: ORG, repository: 'linux-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  student_permission: 'admin',
  ...over,
});

const reportWith = (over = {}) => ({
  schema_version: 1,
  assignment_id: ID,
  org: ORG,
  generated_at: '2026-09-21T02:00:00Z',
  students: [{
    github_login: STUDENT,
    acceptance_state: 'accepted',
    submission_status: 'on-time',
    repo_name: REPO,
    preservation_status: 'preserved',
    preserved_sha: SHA,
    lock_down_at: '2026-09-20T20:00:00Z',
    ...over,
  }],
});

const lockdownRecord = (over = {}) => ({
  schema_version: 1,
  assignment_id: ID,
  deadline_at: '2026-09-20T20:00:00Z',
  executed_at: '2026-09-20T20:01:00Z',
  lock_method: 'ruleset',
  results: [{
    github_login: STUDENT,
    repo_name: `${ORG}/${REPO}`,
    repo_id: 1,
    snapshot_sha: SHA,
    lock_method: 'ruleset',
    verified: true,
    permission_after: null,
    ...over,
  }],
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const asContent = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: b64(o), encoding: 'base64' }) });
const NOT_FOUND = { status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) };

/**
 * Open the assignment's roster & progress page, with the ruleset endpoints and
 * the lockdown record staged.
 *
 * `apiCalls` records every ruleset and collaborator request the page makes, so
 * a test can assert what was NOT done as well as what was.
 */
async function openTracking(page, {
  record = lockdownRecord(),
  report = reportWith(),
  rulesets = [{ id: RULESET_ID, name: 'pxl-classroom-deadline', enforcement: 'active', source_type: 'Repository' }],
  putStatus = 200,
  putEnforcement = 'disabled',
  collaboratorStatus = 204,
  writeStatus = null,
  doc = assignment(),
} = {}) {
  const contentWrites = [];
  const apiCalls = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: doc },
    roster: [{ student_number: '0123456', full_name: 'Alice Example', email: 'a@x.be', github_login: STUDENT }],
    reports: { [ID]: report },
    contentWrites,
  });

  await page.route(`**/contents/lockdowns/${ID}/lockdown-record.json*`, (route) =>
    route.fulfill(record ? asContent(record) : NOT_FOUND));

  await page.route(`**/repos/${ORG}/${REPO}/rulesets`, (route) => {
    apiCalls.push({ method: route.request().method(), url: route.request().url() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rulesets) });
  });

  await page.route(`**/repos/${ORG}/${REPO}/rulesets/*`, (route) => {
    const req = route.request();
    apiCalls.push({ method: req.method(), url: req.url(), body: req.postDataJSON?.() ?? null });
    if (putStatus !== 200) {
      return route.fulfill({ status: putStatus, contentType: 'application/json', body: JSON.stringify({ message: 'Must have admin rights' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: RULESET_ID, enforcement: putEnforcement }) });
  });

  await page.route(`**/repos/${ORG}/${REPO}/collaborators/**`, (route) => {
    const req = route.request();
    apiCalls.push({ method: req.method(), url: req.url(), body: req.postDataJSON?.() ?? null });
    return route.fulfill({ status: collaboratorStatus, contentType: 'application/json', body: '{}' });
  });

  if (writeStatus !== null) {
    await page.route(`**/contents/lockdowns/${ID}/unlocked/${STUDENT}.json`, (route) =>
      route.fulfill({ status: writeStatus, contentType: 'application/json', body: JSON.stringify({ message: 'Conflict' }) }));
  }

  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.getByRole('button', { name: `Actions for ${STUDENT}` }).first())
    .toBeVisible({ timeout: 15000 });
  return { contentWrites, apiCalls };
}

const modal = (page) => page.locator('.modal-overlay .modal');
const unlockSection = (page) => modal(page).locator('section', { hasText: 'Reopen the repository' });

async function openActions(page) {
  await page.getByRole('button', { name: `Actions for ${STUDENT}` }).first().click();
  await expect(modal(page)).toBeVisible({ timeout: 10000 });
}

const unlockWrite = (writes) => writes.find((w) => w.path === `lockdowns/${ID}/unlocked/${STUDENT}.json`);

// ---------------------------------------------------------------------------

test.describe('when the section appears at all', () => {
  test('a preserved, locked repository offers the control', async ({ page }) => {
    await openTracking(page);
    await openActions(page);
    await expect(unlockSection(page)).toBeVisible();
    await expect(unlockSection(page).getByRole('button', { name: /Reopen repository/ })).toBeVisible();
  });

  test('nothing is offered before the deadline has run', async ({ page }) => {
    // No lockdown record at all. A heading over "nothing has been locked" on
    // every student in a live cohort is noise, so the section does not render.
    await openTracking(page, { record: null });
    await openActions(page);
    await expect(unlockSection(page)).toHaveCount(0);
  });

  test('nothing is offered for a student the deadline run never saw', async ({ page }) => {
    // Accepted after the freeze: a real report row, no lockdown row.
    await openTracking(page, { record: lockdownRecord({ github_login: 'somebody-else' }) });
    await openActions(page);
    await expect(unlockSection(page)).toHaveCount(0);
  });

  test('the extension and retry actions are untouched by any of this', async ({ page }) => {
    await openTracking(page, { record: null });
    await openActions(page);
    await expect(modal(page).getByRole('button', { name: /Grant extension/ })).toBeVisible();
    await expect(modal(page).getByRole('button', { name: /Retry acceptance/ })).toBeVisible();
  });
});

test.describe('preservation first, always', () => {
  test('a pending snapshot refuses, and says to wait', async ({ page }) => {
    // Reopening now lets the work being graded move before it is safely in
    // the archive.
    await openTracking(page, { report: reportWith({ preservation_status: 'pending', preserved_sha: null }) });
    await openActions(page);
    await expect(unlockSection(page)).toContainText('has not been preserved yet');
    await expect(unlockSection(page)).toContainText('wait for the nightly');
    await expect(unlockSection(page).getByRole('button', { name: /Reopen repository/ })).toHaveCount(0);
  });

  test('a FAILED preservation refuses differently - waiting will not fix it', async ({ page }) => {
    await openTracking(page, { report: reportWith({ preservation_status: 'failed', preserved_sha: null }) });
    await openActions(page);
    await expect(unlockSection(page)).toContainText('nothing to grade against');
    await expect(unlockSection(page)).not.toContainText('wait for the nightly');
    await expect(unlockSection(page).getByRole('button', { name: /Reopen repository/ })).toHaveCount(0);
  });

  test('a repository the run failed to lock is not reported as reopenable', async ({ page }) => {
    await openTracking(page, { record: lockdownRecord({ verified: false }) });
    await openActions(page);
    await expect(unlockSection(page)).toContainText('did not manage to lock');
  });

  test('an assignment that locks nothing has nothing to reopen', async ({ page }) => {
    await openTracking(page, { record: lockdownRecord({ lock_method: 'none' }) });
    await openActions(page);
    await expect(unlockSection(page)).toContainText('does not lock repositories at the deadline');
  });
});

test.describe('doing it', () => {
  test('the ruleset is DISABLED and never deleted', async ({ page }) => {
    // A deleted ruleset re-created later without the App in bypass_actors
    // locks this system out of the repository along with the student.
    const { apiCalls } = await openTracking(page);
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();

    await expect.poll(() => apiCalls.find((c) => c.method === 'PUT'), { timeout: 10000 }).toBeTruthy();
    const put = apiCalls.find((c) => c.method === 'PUT');
    expect(put.url).toContain(`/rulesets/${RULESET_ID}`);
    expect(put.body, 'only enforcement is sent - the rules and the bypass survive')
      .toEqual({ enforcement: 'disabled' });
    expect(apiCalls.some((c) => c.method === 'DELETE'), 'nothing is deleted').toBe(false);
  });

  test('and it is written down, because doing this by hand records nothing', async ({ page }) => {
    const { contentWrites } = await openTracking(page);
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Medical certificate, extension approved after the freeze');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();

    await expect.poll(() => unlockWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const doc = JSON.parse(unlockWrite(contentWrites).content);
    expect(doc.assignment_id).toBe(ID);
    expect(doc.github_login).toBe(STUDENT);
    expect(doc.repo_name, 'owner/name, readable on its own').toBe(`${ORG}/${REPO}`);
    expect(doc.reason).toBe('Medical certificate, extension approved after the freeze');
    expect(doc.unlocked_by).toBe(LECTURER.login);
    expect(doc.lock_method).toBe('ruleset');
    // What was graded, so a reader can see the work was already in the archive
    // when the repository was reopened.
    expect(doc.snapshot_sha).toBe(SHA);
    expect(doc.unlocked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('the record is written AFTER the unlock, never before', async ({ page }) => {
    // A control repo that claims something the organization did not do is
    // worse than no record.
    const { apiCalls, contentWrites } = await openTracking(page, { putStatus: 403 });
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();

    await expect(page.locator('.toast, [role="alert"]').filter({ hasText: /organization owner/i }).first())
      .toBeVisible({ timeout: 10000 });
    expect(apiCalls.some((c) => c.method === 'PUT')).toBe(true);
    expect(unlockWrite(contentWrites), 'no record for an unlock that did not happen').toBeUndefined();
  });

  test('a 403 names who can do it, rather than saying "failed"', async ({ page }) => {
    // Editing a repository ruleset needs admin on it, and a lecturer can be
    // hub-writable without owning the organization. This is the ordinary
    // failure, not an exotic one.
    await openTracking(page, { putStatus: 403 });
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();
    await expect(page.locator('.toast, [role="alert"]').filter({ hasText: /organization owner can/i }).first())
      .toBeVisible({ timeout: 10000 });
  });

  test('a ruleset that has already been removed is reported, not shrugged off', async ({ page }) => {
    // The lockdown record says a ruleset locked this repository. If there is
    // none, something removed it - a green toast over that would hide it.
    const { contentWrites } = await openTracking(page, { rulesets: [] });
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();
    await expect(page.locator('.toast, [role="alert"]').filter({ hasText: /already have been removed/i }).first())
      .toBeVisible({ timeout: 10000 });
    expect(unlockWrite(contentWrites)).toBeUndefined();
  });

  test('a PUT that answers 200 with the lock still ACTIVE is a failure', async ({ page }) => {
    // The answer is read back rather than assumed. A button reporting an
    // unlock it did not perform sends somebody to argue with a student who
    // still cannot hand in.
    const { contentWrites } = await openTracking(page, { putEnforcement: 'active' });
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();
    await expect(page.locator('.toast, [role="alert"]').filter({ hasText: /still active/i }).first())
      .toBeVisible({ timeout: 10000 });
    expect(unlockWrite(contentWrites)).toBeUndefined();
  });

  test('a record that fails to write says the repository IS open anyway', async ({ page }) => {
    // The honest report. The lecturer has to know the one document a dispute
    // would rest on is missing, and that nothing else will write it.
    await openTracking(page, { writeStatus: 409 });
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();
    const toast = page.locator('.toast, [role="alert"]').filter({ hasText: /is reopened, but recording it failed/i }).first();
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText(/nothing else will write it down/i);
  });
});

test.describe('a demoted repository', () => {
  const demoted = () => lockdownRecord({ lock_method: 'demotion', permission_after: 'pull' });

  test('restores the assignment\'s student_permission, and touches no ruleset', async ({ page }) => {
    // lockdown.mjs degrades to demotion per repository, so one assignment can
    // hold both methods. Undoing a demotion with a ruleset flip would report
    // success over a student who still cannot push.
    const { apiCalls } = await openTracking(page, {
      record: demoted(),
      doc: assignment({ student_permission: 'push' }),
    });
    await openActions(page);
    await expect(unlockSection(page)).toContainText('push');
    await unlockSection(page).locator('textarea').fill('Resit agreed');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();

    await expect.poll(() => apiCalls.find((c) => c.url.includes('/collaborators/')), { timeout: 10000 }).toBeTruthy();
    const call = apiCalls.find((c) => c.url.includes('/collaborators/'));
    expect(call.method).toBe('PUT');
    expect(call.url).toContain(`/collaborators/${STUDENT}`);
    expect(call.body).toEqual({ permission: 'push' });
    expect(apiCalls.some((c) => c.url.includes('/rulesets')), 'no ruleset is read or written').toBe(false);
  });

  test('and the record says which level was restored', async ({ page }) => {
    const { contentWrites } = await openTracking(page, { record: demoted() });
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Resit agreed');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();

    await expect.poll(() => unlockWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const doc = JSON.parse(unlockWrite(contentWrites).content);
    expect(doc.lock_method).toBe('demotion');
    expect(doc.permission_restored).toBe('admin');
  });

  test('a failed permission restore writes no record', async ({ page }) => {
    const { contentWrites } = await openTracking(page, { record: demoted(), collaboratorStatus: 403 });
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Resit agreed');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();
    await expect(page.locator('.toast, [role="alert"]').filter({ hasText: /Could not reopen/i }).first())
      .toBeVisible({ timeout: 10000 });
    expect(unlockWrite(contentWrites)).toBeUndefined();
  });
});

test.describe('the reason is not optional', () => {
  test('the button is disabled until one is typed', async ({ page }) => {
    // This document is read by somebody who was not there. A reason field
    // saying nothing answers nothing, so it may not be skipped or defaulted.
    await openTracking(page);
    await openActions(page);
    const button = unlockSection(page).getByRole('button', { name: /Reopen repository/ });
    await expect(button).toBeDisabled();
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await expect(button).toBeEnabled();
  });

  test('whitespace is not a reason', async ({ page }) => {
    await openTracking(page);
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('    ');
    await expect(unlockSection(page).getByRole('button', { name: /Reopen repository/ })).toBeDisabled();
  });
});

test.describe('DESIGN.md conformity', () => {
  test('the dialog still has exactly one primary button', async ({ page }) => {
    // DESIGN.md 1.2 - a modal counts as its own view, and this one's primary
    // is already spent on "Grant extension".
    await openTracking(page);
    await openActions(page);
    await expect(modal(page).locator('.btn-primary')).toHaveCount(1);
    await expect(modal(page).locator('.btn-primary')).toHaveText(/Grant extension/);
  });

  test('nothing here points a lecturer at the repository\'s documentation', async ({ page }) => {
    // DESIGN.md 1.6 / tests/doc-refs.test.mjs.
    await openTracking(page, { report: reportWith({ preservation_status: 'pending', preserved_sha: null }) });
    await openActions(page);
    await expect(unlockSection(page)).not.toContainText(/RUNBOOK|ARCHITECTURE|LESSONS|DESIGN\.md/);
  });
});
