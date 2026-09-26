// 87 - A lecturer's grading decisions: read again, re-grade a commit they
// choose, set a score by hand (2026-09-26).
//
// "Re-grade this student" only ever READ the run the rules pick. A lecturer
// asked to grade a different commit - the late hand-in, the one past the
// limit, the version before a mistake - and to set a score outright where no
// run can help. Both are stored as overrides (lib/grade-override.mjs) so every
// grader honours them; tests/grade-override.test.mjs covers the judge, this the
// screens.
//
// The fake GitHub: ONE student, SIX hand-ins, hand-in N scores N/10, a cap of
// 5 - so the rules grade #5 and #6 is "over the limit". Hand-in #3's run was
// cancelled (no result) until it is run again.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'cloud-exam-87';
const LOGIN = STUDENT_1.login;
const REPO = `${ORG}/${ID}-${LOGIN}`;
const MSG = 'einde examen';
const DEADLINE = '2026-10-01T12:00:00.000Z';
const sha = (n) => String(n).padStart(2, '0').padEnd(40, 'a');
const at = (min) => new Date(Date.parse('2026-10-01T09:00:00Z') + min * 60_000).toISOString();

const assignment = {
  id: ID, title: 'Cloud Exam', organization: ORG, state: 'closed', assignment_type: 'individual',
  template: { owner: ORG, repository: 'cloud-template' },
  template_grades: true,
  deadline_at: DEADLINE,
  submission_marker: { type: 'commit_message', value: MSG, multiple: true, max_hand_ins: 5 },
};
const report = {
  schema_version: 1, generated_at: '2026-10-01T13:00:00.000Z', assignment_id: ID,
  students: [{ github_login: LOGIN, acceptance_state: 'provisioned', submission_status: 'on-time', repo_name: REPO, effective_deadline_at: DEADLINE, preserved_sha: sha(6) }],
};
const summary = {
  schema_version: 1, assignment_id: ID, generated_at: '2026-10-01T13:00:00.000Z', graded_by: 'lecturer1', runner: 'github_actions',
  students: [{ login: LOGIN, earned_points: 5, total_points: 10, ci_status: 'success', ci_run_url: 'https://x/5', score_source: 'annotation-json', graded_at: '2026-10-01T13:00:00.000Z', graded_sha: sha(5) }],
  failed: [],
};
const overridePath = `overrides/${ID}/${LOGIN}.json`;
const summaryPath = `grading/${ID}/summary.json`;

async function setup(page, { overrides = null } = {}) {
  const contentWrites = [];
  const reruns = [];
  let rerunDone = false;
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER, contentWrites,
    assignments: { [ID]: assignment }, reports: { [ID]: report },
    gradingSummaries: { [ID]: summary },
    controlOverrides: overrides ? { [ID]: { [LOGIN]: { schema_version: 1, assignment_id: ID, github_login: LOGIN, overrides } } } : {},
  });
  const esc = REPO.replace('/', '\\/');
  await page.route(new RegExp(`/repos/${esc}/commits\\?`), (route) => {
    const first = Number(new URL(route.request().url()).searchParams.get('page') || 1) === 1;
    const rows = [1, 2, 3, 4, 5, 6].map((n) => ({ sha: sha(n), commit: { message: MSG, committer: { date: at(n * 10) } } })).reverse();
    return route.fulfill({ status: 200, body: JSON.stringify(first ? rows : []) });
  });
  await page.route(new RegExp(`/repos/${esc}/actions/runs(\\?.*)?$`), (route) => {
    const u = new URL(route.request().url());
    const headSha = u.searchParams.get('head_sha');
    const all = [1, 2, 3, 4, 5, 6].map((n) => ({
      id: 100 + n, event: 'push', name: 'Grading', status: 'completed', head_sha: sha(n), head_branch: 'main',
      created_at: new Date(Date.now() - 86400_000).toISOString(), head_commit: { message: MSG, timestamp: at(n * 10) },
    })).reverse();
    const first = Number(u.searchParams.get('page') || 1) === 1;
    const runs = headSha ? all.filter((r) => r.head_sha === headSha) : (first ? all : []);
    return route.fulfill({ status: 200, body: JSON.stringify({ workflow_runs: runs }) });
  });
  await page.route(new RegExp(`/repos/${esc}/actions/runs/(\\d+)/rerun$`), (route) => {
    reruns.push(route.request().url());
    rerunDone = true;
    return route.fulfill({ status: 201, body: '' });
  });
  await page.route(new RegExp(`/repos/${esc}/actions/runs/(\\d+)$`), (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ id: 103, status: rerunDone ? 'completed' : 'in_progress' }) }));
  await page.route(new RegExp(`/repos/${esc}/commits/([0-9a-f]{40})/check-runs`), (route) => {
    const n = Number(route.request().url().match(/commits\/(\d\d)a/)[1]);
    const cancelled = n === 3 && !rerunDone;
    return route.fulfill({ status: 200, body: JSON.stringify({ check_runs: [{ id: n, name: 'run-autograding-tests', status: 'completed', conclusion: cancelled ? 'cancelled' : 'success', html_url: `https://x/${n}`, output: { summary: null, annotations_count: cancelled ? 0 : 1 } }] }) });
  });
  await page.route(new RegExp(`/repos/${esc}/check-runs/(\\d+)/annotations`), (route) => {
    const n = route.request().url().match(/check-runs\/(\d+)\/annotations/)[1];
    return route.fulfill({ status: 200, body: JSON.stringify([{ annotation_level: 'notice', message: `{"totalPoints":${n},"maxPoints":10}` }]) });
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.getByRole('button', { name: `Actions for ${LOGIN}` }).first()).toBeVisible({ timeout: 15000 });
  return { contentWrites, reruns };
}

const dialog = (page) => page.getByRole('dialog', { name: `Actions for ${LOGIN}` });
const grading = (page) => dialog(page).locator('[data-section="grading"]');
const picker = (page) => page.getByRole('dialog', { name: `Re-grade a commit for ${LOGIN}` });
const lastWrite = (writes, path) => [...writes].reverse().find((w) => w.path === path);
const lastSummary = (writes) => JSON.parse(lastWrite(writes, summaryPath).content);

async function openActions(page) {
  await page.getByRole('button', { name: `Actions for ${LOGIN}` }).first().click();
  await expect(dialog(page)).toBeVisible();
}

test.describe('87 - grading decisions', () => {
  test('three actions, and what is in force said first', async ({ page }) => {
    await setup(page);
    await openActions(page);
    await expect(grading(page)).toContainText('Now 5/10, on commit 05aaaaa. Graded by the rules.');
    await expect(grading(page).getByRole('button', { name: 'Read score again' })).toBeVisible();
    await expect(grading(page).getByRole('button', { name: 'Re-grade a commit…' })).toBeVisible();
    await expect(grading(page).locator('summary', { hasText: 'Set score by hand' })).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Re-grade this student' })).toHaveCount(0);
  });

  test('RE-GRADE A COMMIT: the over-limit hand-in is listed with its result, chosen with a reason, and stored', async ({ page }) => {
    const { contentWrites } = await setup(page);
    await openActions(page);
    await grading(page).getByRole('button', { name: 'Re-grade a commit…' }).click();
    const rows = picker(page).locator('.commit-row');
    await expect(rows).toHaveCount(6);
    const six = rows.filter({ hasText: '#6' });
    await expect(six).toContainText('over the limit');
    await expect(six).toContainText('6/10');
    await expect(rows.filter({ hasText: '#5' })).toContainText('graded now');
    await six.getByRole('radio').check();
    await picker(page).getByLabel(/Reason/).fill('The wifi dropped during hand-in 5');
    await picker(page).getByRole('button', { name: 'Grade on #6 (6/10)' }).click();

    await expect.poll(() => !!lastWrite(contentWrites, summaryPath), { timeout: 15000 }).toBe(true);
    const override = JSON.parse(lastWrite(contentWrites, overridePath).content).overrides.at(-1);
    expect(override).toMatchObject({ type: 'submission_sha', value: sha(6), reason: 'The wifi dropped during hand-in 5', overridden_by: LECTURER.login });
    const row = lastSummary(contentWrites).students[0];
    expect(row).toMatchObject({ earned_points: 6, graded_sha: sha(6), decided_by: { kind: 'commit', by: LECTURER.login, reason: 'The wifi dropped during hand-in 5' } });
  });

  test('a hand-in with NO result says why and offers to run it again - and the result, once there, can be chosen', async ({ page }) => {
    const { reruns } = await setup(page);
    await openActions(page);
    await grading(page).getByRole('button', { name: 'Re-grade a commit…' }).click();
    const three = picker(page).locator('.commit-row').filter({ hasText: '#3' });
    await expect(three).toContainText('no result');
    await expect(three.getByRole('radio')).toBeDisabled();
    await expect(three).toContainText('Runs the tests as they were at this commit');
    await three.getByRole('button', { name: 'Run grading again' }).click();
    await expect.poll(() => reruns.length).toBe(1);
    expect(reruns[0]).toMatch(/\/actions\/runs\/103\/rerun$/);
    await expect(three).toContainText('3/10', { timeout: 20000 });
    await expect(three.getByRole('radio')).toBeEnabled();
  });

  test('SET SCORE BY HAND: stored, recorded as manual, and shown as such on the badge', async ({ page }) => {
    const { contentWrites } = await setup(page);
    await openActions(page);
    await grading(page).locator('summary', { hasText: 'Set score by hand' }).click();
    await grading(page).getByLabel('Score', { exact: true }).fill('8');
    await grading(page).getByLabel('Out of').fill('10');
    await grading(page).getByLabel(/Reason \(recorded with the score\)/).fill('Oral defence');
    await grading(page).getByRole('button', { name: 'Set score' }).click();
    await expect.poll(() => !!lastWrite(contentWrites, summaryPath), { timeout: 15000 }).toBe(true);
    const override = JSON.parse(lastWrite(contentWrites, overridePath).content).overrides.at(-1);
    expect(override).toMatchObject({ type: 'manual_score', value: { earned: 8, total: 10 }, reason: 'Oral defence' });
    expect(lastSummary(contentWrites).students[0]).toMatchObject({ earned_points: 8, total_points: 10, score_source: 'manual', decided_by: { kind: 'score' } });
    // On the cohort table: the number, and that a person set it - no "*"
    // (inferred), which it is not.
    const badge = page.locator('tr', { hasText: LOGIN }).locator('.badge-clickable').first();
    await expect(badge).toContainText('8/10 pts');
    await expect(badge).toContainText('by hand');
    await expect(badge.locator('.score-inferred')).toHaveCount(0);
  });

  test('a score above the total cannot be set - the button and the rule agree', async ({ page }) => {
    await setup(page);
    await openActions(page);
    await grading(page).locator('summary', { hasText: 'Set score by hand' }).click();
    await grading(page).getByLabel('Score', { exact: true }).fill('12');
    await grading(page).getByLabel('Out of').fill('10');
    await grading(page).getByLabel(/Reason \(recorded with the score\)/).fill('x');
    await expect(grading(page)).toContainText('The score cannot be more than the total.');
    await expect(grading(page).getByRole('button', { name: 'Set score' })).toBeDisabled();
  });

  test('GO BACK TO THE RULES: a chosen commit is shown, and undone with its own reason', async ({ page }) => {
    const chosen = { type: 'submission_sha', value: sha(6), reason: 'wifi', overridden_by: 'lecturer1', overridden_at: '2026-10-01T14:00:00.000Z' };
    const { contentWrites } = await setup(page, { overrides: [chosen] });
    await openActions(page);
    await expect(grading(page).locator('[data-decision]')).toContainText('Graded on commit 06aaaaa, chosen by @lecturer1');
    await grading(page).getByPlaceholder('Decided after the appeal').fill('Appeal withdrawn');
    await grading(page).getByRole('button', { name: 'Go back to the rules' }).click();
    await expect.poll(() => !!lastWrite(contentWrites, summaryPath), { timeout: 15000 }).toBe(true);
    const entries = JSON.parse(lastWrite(contentWrites, overridePath).content).overrides;
    expect(entries.at(-1)).toMatchObject({ type: 'submission_sha', value: null, reason: 'Appeal withdrawn' });
    const row = lastSummary(contentWrites).students[0];
    expect(row.earned_points).toBe(5);
    expect(row.decided_by).toBeUndefined();
  });
});
