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
  // Its reopen record, lockdowns/<id>/unlocked/<login>.json, when it was reopened.
  unlocked = null,
  // Override documents in the control repository: { [fileLogin]: doc }.
  overrides = null,
} = {}) {
  const contentWrites = [];
  const apiCalls = [];
  const gitCommits = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: doc },
    roster: [{ student_number: '0123456', full_name: 'Alice Example', email: 'a@x.be', github_login: STUDENT }],
    reports: { [ID]: report },
    contentWrites,
    gitCommits,
    controlUnlocked: unlocked ? { [ID]: { [STUDENT]: unlocked } } : {},
    controlOverrides: overrides ? { [ID]: overrides } : {},
  });
  // The App, for a repository ruleset's bypass list (lib/submission-lock.mjs resolveAppId).
  await page.route('**/api.github.com/apps/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 4242 }) }));

  await page.route(`**/contents/lockdowns/${ID}/lockdown-record.json*`, (route) =>
    route.fulfill(record ? asContent(record) : NOT_FOUND));

  // A ruleset unlock also asks whether an organization ruleset holds the
  // repository, and here none does. Staged as the empty list GitHub answers:
  // the catch-all's `{}` is not a list, and a rulesets read that is not a list
  // is unreadable, which refuses the unlock.
  await page.route(`**/orgs/${ORG}/rulesets?*`, (route) => {
    apiCalls.push({ method: route.request().method(), url: route.request().url() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // `?*`: the list is walked with `per_page` and `page`, and a Playwright glob
  // must match the whole URL, query included.
  await page.route(`**/repos/${ORG}/${REPO}/rulesets?*`, (route) => {
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
  return { contentWrites, apiCalls, gitCommits };
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

  // R7-3 (review 2026-10-16): what happens AFTER the reopen, in lockdown's own
  // rule - a deadline still ahead ends it; a passed one leaves it open.
  test('R7-3: with the deadline moved later, Reopen says they are locked, archived and graded again then', async ({ page }) => {
    const later = new Date(Date.now() + 3 * 86400_000).toISOString()
    await openTracking(page, { doc: assignment({ deadline_at: later }) });
    await openActions(page);
    await expect(unlockSection(page).locator('[data-reopen-until]')).toContainText(/they are locked, archived and graded again then/);
  });

  // R7-28 (step-back review): the page's override Map is keyed by the file's
  // own spelling, and the lookup lowercases - a login with a capital lost its
  // extension, and Reopen said nothing would lock them again.
  test('R7-28: an extension in a file that spells the login with capitals still ends the reopen', async ({ page }) => {
    const later = new Date(Date.now() + 3 * 86400_000).toISOString()
    await openTracking(page, { overrides: { [STUDENT]: {
      schema_version: 1, assignment_id: ID, github_login: 'Student-Personal',
      overrides: [{ type: 'deadline_extension', value: later, reason: 'Medical certificate', overridden_by: 'admin-panel', overridden_at: new Date().toISOString() }],
    } } });
    await openActions(page);
    await expect(unlockSection(page).locator('[data-reopen-until]')).toContainText(/they are locked, archived and graded again then/);
    await expect(unlockSection(page)).not.toContainText('so what you grade is unaffected');
  });

  // R7-36: a lock record that could not be read is not "nothing locked yet".
  test('R7-36: an extension granted while the lock record cannot be read says so, not that their lock follows it', async ({ page }) => {
    await openTracking(page);
    await page.route(`**/contents/lockdowns/${ID}/lockdown-record.json*`, (route) =>
      route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ message: 'Bad Gateway' }) }));
    await openActions(page);
    const later = new Date(Date.now() + 3 * 86400_000)
    const local = new Date(later.getTime() - later.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    await modal(page).locator('input[type="datetime-local"]').first().fill(local);
    await modal(page).getByPlaceholder(/Medical certificate/).first().fill('Medical certificate');
    await modal(page).getByRole('button', { name: 'Grant extension' }).click();
    const toast = page.locator('.toast', { hasText: `Extension granted to ${STUDENT}` });
    await expect(toast).toContainText('Whether their repository is already locked could not be read');
    await expect(toast).not.toContainText('follow it');
  });

  test('R7-3: with the deadline passed, Reopen says nothing locks them again', async ({ page }) => {
    await openTracking(page);
    await openActions(page);
    await expect(unlockSection(page).locator('[data-reopen-until]')).toContainText(/nothing locks them again: use Lock again when they are done/);
  });

  test('R7-16: an extension granted to a locked student says it does not reopen them, and how it does', async ({ page }) => {
    await openTracking(page);
    await openActions(page);
    const later = new Date(Date.now() + 3 * 86400_000)
    const local = new Date(later.getTime() - later.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    await modal(page).locator('input[type="datetime-local"]').first().fill(local);
    // The first reason box is the extension's; the Reopen section has its own.
    await modal(page).getByPlaceholder(/Medical certificate/).first().fill('Medical certificate');
    await modal(page).getByRole('button', { name: 'Grant extension' }).click();
    const toast = page.locator('.toast', { hasText: `Extension granted to ${STUDENT}` });
    await expect(toast).toContainText('already locked at the deadline, and more time does not reopen it. Reopen them to let them push until');
    await expect(toast).not.toContainText('use the new deadline anyway');
  });

  // R7-24: a student reopened with time and locked again at its end is locked
  // like anyone else; the reopen record still on file does not make them open.
  test('R7-24: an extension granted to a student locked again since their reopen says it does not reopen them', async ({ page }) => {
    await openTracking(page, {
      record: lockdownRecord({ lockdown_at: '2026-09-25T20:00:00Z', relocked_after: '2026-09-22T09:00:00Z' }),
      unlocked: { github_login: STUDENT, unlocked_at: '2026-09-22T09:00:00Z', unlocked_by: LECTURER, reason: 'Appeal upheld', method: 'ruleset' },
    });
    await openActions(page);
    const later = new Date(Date.now() + 3 * 86400_000)
    const local = new Date(later.getTime() - later.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    await modal(page).locator('input[type="datetime-local"]').first().fill(local);
    await modal(page).getByPlaceholder(/Medical certificate/).first().fill('Medical certificate');
    await modal(page).getByRole('button', { name: 'Grant extension' }).click();
    const toast = page.locator('.toast', { hasText: `Extension granted to ${STUDENT}` });
    await expect(toast).toContainText('already locked at the deadline, and more time does not reopen it');
    await expect(toast).not.toContainText('stays open');
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

    await expect.poll(() => apiCalls.find((c) => c.method === 'PUT'), { timeout: 20000 }).toBeTruthy();
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

    await expect.poll(() => unlockWrite(contentWrites), { timeout: 20000 }).toBeTruthy();
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

    await expect.poll(() => apiCalls.find((c) => c.url.includes('/collaborators/')), { timeout: 20000 }).toBeTruthy();
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

    await expect.poll(() => unlockWrite(contentWrites), { timeout: 20000 }).toBeTruthy();
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

test.describe('a team repository (LD6, TL-6)', () => {
  // One repository, one lock: reopening it for the member clicked reopens it
  // for the team, so every member the lock demoted is restored - and a member
  // the lock found with no access is not re-invited, whatever the live
  // presence check says.
  const members = [
    { github_login: STUDENT, permission_after: 'pull' },
    { github_login: 'student-mate', permission_after: 'pull' },
    { github_login: 'student-removed', permission_after: 'none' },
  ];
  const teamDoc = () => assignment({
    assignment_type: 'group',
    group_config: { max_team_size: 4, formation_mode: 'self-service', allow_team_creation: true },
    repository_name_pattern: `${ID}-{team_slug}`,
    student_permission: 'push',
  });
  const teamReport = () => ({
    ...reportWith(),
    students: members.map((m) => ({ ...reportWith().students[0], github_login: m.github_login, team_slug: 'team-a' })),
  });
  const teamRecord = () => ({
    ...lockdownRecord(),
    lock_method: 'demotion',
    results: members.map((m) => ({ ...lockdownRecord().results[0], github_login: m.github_login, team_slug: 'team-a', lock_method: 'demotion', ...m })),
  });

  test('restores every member locked on it, not the one removed, and writes one record', async ({ page }) => {
    const { apiCalls, contentWrites } = await openTracking(page, { record: teamRecord(), report: teamReport(), doc: teamDoc() });
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();
    await expect.poll(() => unlockWrite(contentWrites), { timeout: 20000 }).toBeTruthy();
    const puts = apiCalls.filter((c) => c.method === 'PUT' && c.url.includes('/collaborators/')).map((c) => decodeURIComponent(c.url.split('/collaborators/')[1]));
    expect(puts.sort()).toEqual([STUDENT, 'student-mate'].sort());
    expect(apiCalls.filter((c) => c.method === 'PUT').every((c) => c.body?.permission === 'push')).toBe(true);
    expect(contentWrites.filter((w) => w.path.startsWith(`lockdowns/${ID}/unlocked/`)).map((w) => w.path)).toEqual([`lockdowns/${ID}/unlocked/${STUDENT}.json`]);
  });
});

test.describe('a ruleset repository that was ALSO made read-only', () => {
  // `late_policy: block` + `lock_down_enabled: true`: the ruleset held the
  // branch and phase 4 demoted on top of it, recorded as `demoted: true` beside
  // `lock_method: ruleset`. Reopen read `lock_method` alone, switched the ruleset
  // off, said the student could push again, and left them at `pull`.
  const both = () => lockdownRecord({ lock_method: 'ruleset', demoted: true });

  test('says it restores access too, then does both, ruleset first', async ({ page }) => {
    const { apiCalls, contentWrites } = await openTracking(page, {
      record: both(),
      doc: assignment({ student_permission: 'push' }),
    });
    await openActions(page);
    await expect(unlockSection(page)).toContainText('switched off');
    await expect(unlockSection(page)).toContainText('Their access was also reduced at the deadline');
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();

    await expect.poll(() => unlockWrite(contentWrites), { timeout: 20000 }).toBeTruthy();
    const writes = apiCalls.filter((c) => c.method === 'PUT');
    expect(writes.map((c) => (c.url.includes('/collaborators/') ? 'collaborator' : 'ruleset')))
      .toEqual(['ruleset', 'collaborator']);
    expect(writes[1].body).toEqual({ permission: 'push' });

    const doc = JSON.parse(unlockWrite(contentWrites).content);
    expect(doc.lock_method).toBe('ruleset');
    expect(doc.permission_restored).toBe('push');
  });

  test('a restore that fails after the ruleset went says so, and records nothing', async ({ page }) => {
    const { contentWrites } = await openTracking(page, { record: both(), collaboratorStatus: 403 });
    await openActions(page);
    await unlockSection(page).locator('textarea').fill('Appeal upheld');
    await unlockSection(page).getByRole('button', { name: /Reopen repository/ }).click();
    const toast = page.locator('.toast, [role="alert"]').filter({ hasText: /Could not finish reopening/i }).first();
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText('still read-only');
    await expect(toast).toContainText(/organization owner can restore their access/i);
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

// LOCK AGAIN (review 2026-10-15, P2-57). Every lockdown run skips a repository
// with a reopen record, the manual "Lock everyone out" included, so nothing
// could ever lock it again (lib/repo-relock.mjs).
test.describe('Lock again', () => {
  const reopened = {
    schema_version: 1, assignment_id: ID, github_login: STUDENT, repo_name: `${ORG}/${REPO}`,
    unlocked_at: '2026-09-22T10:00:00Z', unlocked_by: 'lecturer', reason: 'Appeal upheld',
    lock_method: 'ruleset', snapshot_sha: SHA,
  };
  const off = [{ id: RULESET_ID, name: 'pxl-classroom-deadline', enforcement: 'disabled', source_type: 'Repository' }];

  test('a reopened repository says when, by whom and why, offers Lock again, and never Reopen a second time', async ({ page }) => {
    // The lockdown row still reads locked: no pass has rewritten it since. The
    // reopen record is what knows (it offered Reopen on an open repository).
    await openTracking(page, { unlocked: reopened, rulesets: off });
    await openActions(page);
    const section = unlockSection(page);
    await expect(section.locator('[data-reopened]')).toContainText('by @lecturer: "Appeal upheld"');
    await expect(section.locator('[data-reopened]')).toContainText("Lock again puts the deadline's lock back.");
    await expect(section.getByRole('button', { name: 'Lock again' })).toBeVisible();
    await expect(section.getByRole('button', { name: /Reopen repository/ })).toHaveCount(0);
  });

  test("Lock again switches the ruleset back on, and one commit removes the reopen record and gives a 'reopened' row its lock back", async ({ page }) => {
    // A later pass wrote the row reopened: no method, a reopened_at.
    const record = lockdownRecord({ lock_method: null, reopened_at: '2026-09-22T10:00:00Z', verified: false });
    const { apiCalls, gitCommits } = await openTracking(page, { unlocked: reopened, rulesets: off, putEnforcement: 'active', record });
    await openActions(page);
    await unlockSection(page).getByRole('button', { name: 'Lock again' }).click();
    await expect(page.locator('.toast', { hasText: `${ORG}/${REPO} is locked again.` })).toBeVisible({ timeout: 15000 });
    // R6-39: a ruleset covers the submission branch, and the toast says so.
    await expect(page.locator('.toast', { hasText: 'can no longer push to its submission branch' })).toBeVisible();

    const put = apiCalls.find((c) => c.method === 'PUT' && c.url.includes(`/rulesets/${RULESET_ID}`));
    expect(put?.body, 'only enforcement, back on').toEqual({ enforcement: 'active' });
    expect(apiCalls.some((c) => c.method === 'DELETE'), 'nothing is deleted').toBe(false);
    expect(gitCommits).toHaveLength(1);
    const files = Object.fromEntries(gitCommits[0].files.map((f) => [f.path, f.content]));
    expect(files[`lockdowns/${ID}/unlocked/${STUDENT}.json`], 'the reopen record goes').toBeNull();
    // ...and is KEPT, ended (R6-13): the only statement that they could push
    // after the deadline. Validated against unlock-record by the fixture.
    const keptPath = Object.keys(files).find((p) => p.startsWith(`lockdowns/${ID}/relocked/${STUDENT}/`));
    expect(keptPath, 'the reopen is kept under relocked/').toBeTruthy();
    const kept = JSON.parse(files[keptPath]);
    expect(kept).toMatchObject({ unlocked_at: reopened.unlocked_at, unlocked_by: 'lecturer', reason: 'Appeal upheld' });
    expect(Date.parse(kept.relocked_at)).toBeGreaterThan(Date.parse(reopened.unlocked_at));
    const row = JSON.parse(files[`lockdowns/${ID}/lockdown-record.json`]).results[0];
    expect(row).toMatchObject({ lock_method: 'ruleset', verified: true, snapshot_sha: SHA });
    expect('reopened_at' in row).toBe(false);
  });

  test('R6-12: locked, and then the record could not be read - says it is locked, never "could not lock"', async ({ page }) => {
    const { gitCommits } = await openTracking(page, { unlocked: reopened, rulesets: off, putEnforcement: 'active' });
    await openActions(page);
    // From here the lockdown record answers 500: the lock is already back on
    // when Lock again reads it to record that.
    await page.route(`**/contents/lockdowns/${ID}/lockdown-record.json*`, (route) =>
      route.fulfill({ status: 500, body: JSON.stringify({ message: 'Server Error' }) }));
    await unlockSection(page).getByRole('button', { name: 'Lock again' }).click();
    await expect(page.locator('.toast', { hasText: `${ORG}/${REPO} is locked again, but its records could not be updated` })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.toast', { hasText: 'Could not lock' })).toHaveCount(0);
    expect(gitCommits).toEqual([]);
  });

  test('a ruleset that will not switch back on says so, and changes no record', async ({ page }) => {
    const { gitCommits } = await openTracking(page, { unlocked: reopened, rulesets: off, putStatus: 403 });
    await openActions(page);
    await unlockSection(page).getByRole('button', { name: 'Lock again' }).click();
    await expect(page.locator('.toast', { hasText: `Could not lock ${ORG}/${REPO} again` })).toBeVisible({ timeout: 15000 });
    expect(gitCommits).toEqual([]);
  });
});
