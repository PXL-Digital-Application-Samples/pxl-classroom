// 88 - "Grade this commit now": a lecturer dispatches the grading workflow for
// a commit that has no result (2026-09-26).
//
// GitHub's re-run replays the original push; the dispatch entry
// (lib/grade-dispatch.mjs) runs the CURRENT workflow against the chosen
// commit. Its run belongs to the branch tip, so the choice stores the run id
// and the grade is read from that run - tests/grade-dispatch.test.mjs covers
// the judge, this the screen.
//
// The fake GitHub: one student, three hand-ins scoring N/10, hand-in #2's run
// cancelled for good. The dispatch starts run 900, which scores 8/10.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'cloud-exam-88';
const LOGIN = STUDENT_1.login;
const REPO = `${ORG}/${ID}-${LOGIN}`;
const MSG = 'einde examen';
const DEADLINE = '2026-10-01T12:00:00.000Z';
const sha = (n) => String(n).padStart(2, '0').padEnd(40, 'a');
const at = (min) => new Date(Date.parse('2026-10-01T09:00:00Z') + min * 60_000).toISOString();
const WORKFLOW = '.github/workflows/classroom.yml';
const withEntry = `name: Grading\non:\n  push:\n  workflow_dispatch:\n    inputs:\n      grade_sha:\n        required: true\n        type: string\njobs:\n  grade:\n    steps:\n      - uses: classroom-resources/autograding-grading-reporter@v1\n`;
const withoutEntry = 'name: Grading\non: push\njobs:\n  grade:\n    steps:\n      - uses: classroom-resources/autograding-grading-reporter@v1\n';

const assignment = {
  id: ID, title: 'Cloud Exam', organization: ORG, state: 'closed', assignment_type: 'individual',
  template: { owner: ORG, repository: 'cloud-template' },
  template_grades: true,
  deadline_at: DEADLINE,
  submission_marker: { type: 'commit_message', value: MSG, multiple: true },
};
const report = {
  schema_version: 1, generated_at: '2026-10-01T13:00:00.000Z', assignment_id: ID,
  students: [{ github_login: LOGIN, acceptance_state: 'provisioned', submission_status: 'on-time', repo_name: REPO, effective_deadline_at: DEADLINE, preserved_sha: sha(3) }],
};
const summary = {
  schema_version: 1, assignment_id: ID, generated_at: '2026-10-01T13:00:00.000Z', graded_by: 'lecturer1', runner: 'github_actions',
  students: [{ login: LOGIN, earned_points: 3, total_points: 10, ci_status: 'success', ci_run_url: 'https://x/3', score_source: 'annotation-json', graded_at: '2026-10-01T13:00:00.000Z', graded_sha: sha(3) }],
  failed: [],
};
const overridePath = `overrides/${ID}/${LOGIN}.json`;
const summaryPath = `grading/${ID}/summary.json`;

async function setup(page, { workflow = withEntry } = {}) {
  const contentWrites = [];
  const dispatches = [];
  let dispatched = false;
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER, contentWrites,
    assignments: { [ID]: assignment }, reports: { [ID]: report },
    gradingSummaries: { [ID]: summary },
  });
  const esc = REPO.replace('/', '\\/');
  await page.route(new RegExp(`/repos/${esc}/commits\\?`), (route) => {
    const first = Number(new URL(route.request().url()).searchParams.get('page') || 1) === 1;
    const rows = [1, 2, 3].map((n) => ({ sha: sha(n), commit: { message: MSG, committer: { date: at(n * 10) } } })).reverse();
    return route.fulfill({ status: 200, body: JSON.stringify(first ? rows : []) });
  });
  await page.route(new RegExp(`/repos/${esc}/actions/runs(\\?.*)?$`), (route) => {
    const u = new URL(route.request().url());
    const headSha = u.searchParams.get('head_sha');
    // Older than GitHub's 30 days, so the re-run is not offered: the dispatch is the only way.
    const all = [1, 2, 3].map((n) => ({
      id: 100 + n, event: 'push', name: 'Grading', status: 'completed', head_sha: sha(n), head_branch: 'main',
      created_at: '2026-08-01T09:00:00Z', head_commit: { message: MSG, timestamp: at(n * 10) },
    })).reverse();
    const first = Number(u.searchParams.get('page') || 1) === 1;
    const runs = headSha ? all.filter((r) => r.head_sha === headSha) : (first ? all : []);
    return route.fulfill({ status: 200, body: JSON.stringify({ workflow_runs: runs }) });
  });
  await page.route(new RegExp(`/repos/${esc}/actions/workflows\\?`), (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ workflows: [{ id: 5, path: WORKFLOW, state: 'active' }] }) }));
  await page.route(new RegExp(`/repos/${esc}/contents/\\.github/workflows/classroom\\.yml`), (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ content: Buffer.from(workflow).toString('base64') }) }));
  await page.route(new RegExp(`/repos/${esc}/actions/workflows/5/dispatches$`), (route) => {
    dispatches.push(route.request().postDataJSON());
    dispatched = true;
    return route.fulfill({ status: 200, body: JSON.stringify({ workflow_run_id: 900 }) });
  });
  await page.route(new RegExp(`/repos/${esc}/actions/runs/900$`), (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({
      id: 900, event: 'workflow_dispatch', status: dispatched ? 'completed' : 'queued',
      display_title: `Grade ${sha(2)} (PXL Classroom)`, head_sha: sha(3), check_suite_id: 77, html_url: 'https://x/run/900',
    }) }));
  await page.route(new RegExp(`/repos/${esc}/check-suites/77/check-runs`), (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ check_runs: [{ id: 8, name: 'run-autograding-tests', status: 'completed', conclusion: 'success', html_url: 'https://x/8', output: { summary: null, annotations_count: 1 } }] }) }));
  await page.route(new RegExp(`/repos/${esc}/commits/([0-9a-f]{40})/check-runs`), (route) => {
    const n = Number(route.request().url().match(/commits\/(\d\d)a/)[1]);
    const cancelled = n === 2;
    return route.fulfill({ status: 200, body: JSON.stringify({ check_runs: [{ id: n, name: 'run-autograding-tests', status: 'completed', conclusion: cancelled ? 'cancelled' : 'success', html_url: `https://x/${n}`, output: { summary: null, annotations_count: cancelled ? 0 : 1 } }] }) });
  });
  await page.route(new RegExp(`/repos/${esc}/check-runs/(\\d+)/annotations`), (route) => {
    const n = route.request().url().match(/check-runs\/(\d+)\/annotations/)[1];
    return route.fulfill({ status: 200, body: JSON.stringify([{ annotation_level: 'notice', message: `{"totalPoints":${n},"maxPoints":10}` }]) });
  });
  await page.clock.install();
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.getByRole('button', { name: `Actions for ${LOGIN}` }).first()).toBeVisible({ timeout: 15000 });
  return { contentWrites, dispatches };
}

const dialog = (page) => page.getByRole('dialog', { name: `Actions for ${LOGIN}` });
const picker = (page) => page.getByRole('dialog', { name: `Re-grade a commit for ${LOGIN}` });
const lastWrite = (writes, path) => [...writes].reverse().find((w) => w.path === path);

async function openPicker(page) {
  await page.getByRole('button', { name: `Actions for ${LOGIN}` }).first().click();
  await dialog(page).locator('[data-section="grading"]').getByRole('button', { name: 'Re-grade a commit…' }).click();
  await expect(picker(page).locator('.commit-row')).toHaveCount(3);
}

test.describe('88 - grade this commit now', () => {
  test('a hand-in with no result is graded by a dispatch, chosen, and read from THAT run', async ({ page }) => {
    const { contentWrites, dispatches } = await setup(page);
    await openPicker(page);
    const two = picker(page).locator('.commit-row').filter({ hasText: '#2' });
    await expect(two).toContainText('no result');
    await expect(two).toContainText('Tests written in the workflow are the current ones');
    await two.getByRole('button', { name: 'Grade this commit now' }).click();
    await expect.poll(() => dispatches.length).toBe(1);
    expect(dispatches).toEqual([{ ref: 'main', inputs: { grade_sha: sha(2) }, return_run_details: true }]);
    await expect(two).toContainText('grading…');

    // Advance until the dialog's 10-second check has run: the timer is set
    // only once the dispatch has resolved in the page.
    await expect.poll(async () => {
      await page.clock.runFor(11_000);
      return (await two.textContent()).includes('8/10');
    }, { timeout: 15000 }).toBe(true);
    await two.getByRole('radio').check();
    await picker(page).getByLabel(/Reason/).fill('The run was cancelled by a runner outage');
    await picker(page).getByRole('button', { name: 'Grade on #2 (8/10)' }).click();

    await expect.poll(() => !!lastWrite(contentWrites, summaryPath), { timeout: 15000 }).toBe(true);
    const override = JSON.parse(lastWrite(contentWrites, overridePath).content).overrides.at(-1);
    expect(override).toMatchObject({ type: 'submission_sha', value: sha(2), run_id: 900 });
    const row = JSON.parse(lastWrite(contentWrites, summaryPath).content).students[0];
    expect(row).toMatchObject({ earned_points: 8, graded_sha: sha(2), ci_run_url: 'https://x/run/900', decided_by: { kind: 'commit' } });
  });

  test('a workflow without the entry offers no button, and says how to get it', async ({ page }) => {
    await setup(page, { workflow: withoutEntry });
    await openPicker(page);
    const two = picker(page).locator('.commit-row').filter({ hasText: '#2' });
    await expect(two).toContainText('no result');
    await expect(two.getByRole('button', { name: 'Grade this commit now' })).toHaveCount(0);
    await expect(picker(page)).toContainText('sync the updated workflow file with Sync Starter Code');
  });
});
