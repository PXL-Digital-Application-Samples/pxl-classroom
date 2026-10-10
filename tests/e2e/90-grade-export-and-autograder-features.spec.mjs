// 90 - Grade exports, the Grading table, its cards and its box
//
// Tests:
// 1. Grading table dedicated columns: Confirmed address & Graded submission with links.
// 2. Grading table sorting on the Score and Login headers.
// 3. Submissions table sorting on Score.
// 4. The box under the cards says when the scores were read, and the average.
// 5. The cards count and filter the table; a student with no score is a row.
// 6. Export grades and Export breakdown, from the Export menu.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'prog-exam-90';
const DEADLINE = '2026-10-01T12:00:00.000Z';
const sha = (n) => String(n).padStart(2, '0').padEnd(40, 'a');

const assignment = {
  id: ID,
  title: 'Programming Exam',
  organization: ORG,
  state: 'closed',
  assignment_type: 'individual',
  template: { owner: ORG, repository: 'prog-template' },
  template_grades: true,
  deadline_at: DEADLINE,
  autograde: {
    enabled: true,
    execution_environment: 'github_actions',
    runner: 'github_actions',
    tests: [
      { id: 'test_alpha', name: 'Alpha Check', points: 10 },
      { id: 'test_beta', name: 'Beta Check', points: 10 },
    ],
  },
};

const students = [
  {
    github_login: 'student-alice',
    claimed_email: 'alice.alison@student.pxl.be',
    full_name: 'Alice Alison',
    student_number: '12340001',
    class_group: '2TIN-A',
    acceptance_state: 'provisioned',
    submission_status: 'on-time',
    repo_name: `${ORG}/${ID}-student-alice`,
    repo_url: `https://github.com/${ORG}/${ID}-student-alice`,
    effective_deadline_at: DEADLINE,
    last_on_time_sha: sha(1),
    // As report.mjs writes it: the latest commit's SHA beside its own time.
    latest_observed_sha: sha(1),
    commit_date: '2026-10-01T10:15:00.000Z',
    latest_commit_date: '2026-10-01T10:15:00.000Z',
    commit_message: 'Finish the playbook\n\nwith handlers',
    commit_count: 5,
  },
  {
    github_login: 'student-bob',
    claimed_email: 'bob.builder@student.pxl.be',
    full_name: 'Bob Builder',
    student_number: '12340002',
    class_group: '2TIN-B',
    acceptance_state: 'provisioned',
    submission_status: 'on-time',
    repo_name: `${ORG}/${ID}-student-bob`,
    repo_url: `https://github.com/${ORG}/${ID}-student-bob`,
    effective_deadline_at: DEADLINE,
    last_on_time_sha: sha(2),
    latest_observed_sha: sha(2),
    commit_date: '2026-10-01T09:30:00.000Z',
    commit_count: 3,
  },
  {
    github_login: 'student-charlie',
    claimed_email: 'charlie.chaplin@student.pxl.be',
    full_name: 'Charlie Chaplin',
    student_number: '12340003',
    class_group: '2TIN-A',
    acceptance_state: 'provisioned',
    submission_status: 'on-time',
    repo_name: `${ORG}/${ID}-student-charlie`,
    repo_url: `https://github.com/${ORG}/${ID}-student-charlie`,
    effective_deadline_at: DEADLINE,
    last_on_time_sha: sha(3),
    latest_observed_sha: sha(3),
    commit_date: '2026-10-01T11:45:00.000Z',
    commit_count: 4,
  },
  {
    github_login: 'student-david',
    claimed_email: 'david.davids@student.pxl.be',
    full_name: 'David Davids',
    student_number: '12340004',
    class_group: '2TIN-B',
    acceptance_state: 'provisioned',
    submission_status: 'no-submission',
    repo_name: `${ORG}/${ID}-student-david`,
    repo_url: `https://github.com/${ORG}/${ID}-student-david`,
    effective_deadline_at: DEADLINE,
    commit_count: 0,
  },
];

const report = {
  schema_version: 1,
  generated_at: '2026-10-01T13:00:00.000Z',
  assignment_id: ID,
  students,
};

const initialSummary = {
  schema_version: 1,
  assignment_id: ID,
  generated_at: '2026-10-01T13:00:00.000Z',
  graded_by: 'lecturer1',
  runner: 'github_actions',
  students: [
    {
      login: 'student-alice',
      earned_points: 20,
      total_points: 20,
      ci_status: 'success',
      ci_run_url: 'https://github.com/runs/1',
      score_source: 'annotation-json',
      graded_at: '2026-10-01T13:00:00.000Z',
      graded_sha: sha(1),
    },
    {
      login: 'student-bob',
      earned_points: 10,
      total_points: 20,
      ci_status: 'failure',
      ci_run_url: 'https://github.com/runs/2',
      score_source: 'points',
      graded_at: '2026-10-01T13:00:00.000Z',
      graded_sha: sha(2),
    },
    {
      login: 'student-charlie',
      earned_points: 18,
      total_points: 20,
      ci_status: null,
      ci_run_url: null,
      score_source: 'manual',
      graded_at: '2026-10-01T14:00:00.000Z',
      graded_sha: null,
      decided_by: {
        kind: 'score',
        by: 'lecturer1',
        at: '2026-10-01T14:00:00.000Z',
        reason: 'Oral exam override',
      },
    },
  ],
  failed: [],
};

// Local JSON record for student-bob (testing local test breakdown)
const bobLocalGrading = {
  schema_version: 1,
  assignment_id: ID,
  github_login: 'student-bob',
  archive_sha: sha(2),
  archive_branch: 'main',
  graded_at: '2026-10-01T13:00:00.000Z',
  graded_by: 'lecturer1',
  runner: 'docker',
  total_points: 20,
  earned_points: 10,
  tests: [
    { id: 'test_alpha', passed: true, points: 10, earned: 10, duration_ms: 120, exit_code: 0 },
    { id: 'test_beta', passed: false, points: 10, earned: 0, duration_ms: 80, exit_code: 1 },
  ],
};


async function setup(page, options = {}) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    contentWrites,
    assignments: { [ID]: options.assignment || assignment },
    reports: { [ID]: options.report || report },
    gradingSummaries: { [ID]: options.summary || initialSummary },
  });

  // Mock student-bob local grading record
  await page.route(new RegExp(`/repos/[^/]+/[^/]+/contents/grading/${ID}/student-bob\\.json`), (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: Buffer.from(JSON.stringify(bobLocalGrading)).toString('base64'),
        encoding: 'base64',
      }),
    });
  });

  // Mock check runs and annotations for student repos
  await page.route(new RegExp(`/repos/${ORG}/[^/]+/commits/[^/]+/check-runs`), (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        check_runs: [
          {
            id: 101,
            name: 'run-autograding-tests',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/runs/1',
            output: { summary: null, annotations_count: 2 },
          },
        ],
      }),
    });
  });
  await page.route(new RegExp(`/repos/${ORG}/[^/]+/check-runs/101/annotations`), (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { annotation_level: 'notice', title: 'Alpha Check', message: 'Points 10/10' },
        { annotation_level: 'notice', title: 'Beta Check', message: 'Points 10/10' },
      ]),
    });
  });

  // Everything about scores is the Grading tab's (BETA-UX.md, 2026-10-02).
  await page.goto(`/dashboard/${ORG}/${ID}${options.tab ? `?tab=${options.tab}` : ''}`);
  // The bar names the assignment by its title once the page has read it
  // (lib/assignment-crumb.js): waiting for the title is waiting for the load.
  await expect(page.getByRole('heading', { name: 'Programming Exam', level: 1 })).toBeVisible({ timeout: 15000 });
  return { contentWrites };
}

test.describe('90 - Grade exports and autograder features', () => {
  test('Autograder table dedicated columns: Confirmed address & Graded submission with links', async ({ page }) => {
    await setup(page, { tab: 'grading' });
    const autogradeTable = page.locator('[data-grading-table] table');
    await expect(autogradeTable).toBeVisible();

    // Headers must include Confirmed address and Graded submission
    const ths = autogradeTable.locator('th');
    await expect(ths.locator('text=Confirmed address')).toBeVisible();
    await expect(ths.locator('text=Graded submission')).toBeVisible();

    // Alice confirmed email and last commit date
    const aliceRow = autogradeTable.locator('tr', { hasText: 'student-alice' });
    await expect(aliceRow.locator('.claimed-address')).toHaveText('alice.alison@student.pxl.be');
    const commitLink = aliceRow.locator('a.sha');
    await expect(commitLink).toHaveAttribute('href', `https://github.com/${ORG}/${ID}-student-alice/commit/${sha(1)}`);
  });

  test('the login opens the student\'s repository for this assignment, not their GitHub profile', async ({ page }) => {
    // Asked 2026-10-07: what a grader opens next is the work, not the person.
    await setup(page, { tab: 'grading' });
    const aliceRow = page.locator('[data-grading-table] table tr', { hasText: 'student-alice' });
    const login = aliceRow.locator('a[data-grading-repo]');
    await expect(login).toHaveText('student-alice');
    await expect(login).toHaveAttribute('href', `https://github.com/${ORG}/${ID}-student-alice`);
    await expect(login).toHaveAttribute('target', '_blank');
  });

  test('on Progress too: the login opens the same repository, and the repository column stays', async ({ page }) => {
    await setup(page, {});
    const aliceRow = page.locator('tr', { hasText: 'student-alice' }).first();
    const login = aliceRow.locator('a[data-progress-repo]');
    await expect(login).toHaveText('student-alice', { timeout: 15000 });
    await expect(login).toHaveAttribute('href', `https://github.com/${ORG}/${ID}-student-alice`);
    await expect(aliceRow.locator('.col-repo a.repo-icon-link')).toHaveAttribute('href', `https://github.com/${ORG}/${ID}-student-alice`);
  });

  test('hovering a login on Progress says who it is, the last commit and how it stands to the deadline', async ({ page }) => {
    await setup(page, {});
    const title = await page.locator('tr', { hasText: 'student-alice' }).first().locator('a[data-progress-repo]').getAttribute('title', { timeout: 15000 });
    expect(title.split('\n')[0]).toMatch(/alice\.alison@student\.pxl\.be|Alice Alison/);
    expect(title).toMatch(new RegExp(`Last commit ${sha(1).slice(0, 7)}, .+: Finish the playbook$`, 'm'));
    expect(title).not.toContain('with handlers');
    expect(title).toContain('Last commit 1h 45m before the deadline.');
  });

  test('hovering a login on Grading says which commit was graded, when it was committed, and against the deadline', async ({ page }) => {
    await setup(page, { tab: 'grading' });
    const title = await page.locator('[data-grading-table] tr', { hasText: 'student-alice' }).locator('a[data-grading-repo]').getAttribute('title', { timeout: 15000 });
    expect(title).toMatch(new RegExp(`Graded commit ${sha(1).slice(0, 7)}, committed .+ \\(1h 45m before the deadline\\)`));
    expect(title).not.toMatch(/on time/i);
  });

  test('a graded hand-in is shown at when GitHub recorded its push, in the cell and on the login', async ({ page }) => {
    // Committed 10:15 (the report's time), pushed 10:20: the push is what the
    // hand-in was judged by, so that is the time shown, and said to be one.
    const summary = {
      ...initialSummary,
      students: initialSummary.students.map((r) => (r.login === 'student-alice'
        ? { ...r, graded_pushed_at: '2026-10-01T10:20:00.000Z', graded_pushed_from: 'run' }
        : r)),
    };
    await setup(page, { tab: 'grading', summary });
    const aliceRow = page.locator('[data-grading-table] tr', { hasText: 'student-alice' });
    // A time read off a grading run is the run's start, seconds after the push.
    await expect(aliceRow.locator('a.sha')).toHaveAttribute('title', `When GitHub started grading it, seconds after the push. SHA: ${sha(1)}`, { timeout: 15000 });
    const title = await aliceRow.locator('a[data-grading-repo]').getAttribute('title');
    expect(title).toMatch(new RegExp(`Graded commit ${sha(1).slice(0, 7)}, pushed .+ \\(1h 40m before the deadline\\)`));
    expect(title).not.toContain('committed');
    // Bob has no push recorded (graded before this was kept): his commit time, said as such.
    const bobTitle = await page.locator('[data-grading-table] tr', { hasText: 'student-bob' }).locator('a[data-grading-repo]').getAttribute('title');
    expect(bobTitle).toMatch(/Graded commit \w{7}(, committed .+)?$/m);
    expect(bobTitle).not.toContain('pushed');
  });

  test('a graded commit that is not the latest shows its SHA, never the later commit\'s time', async ({ page }) => {
    // Graded on an on-time commit, then pushed again after the deadline. The
    // report's one commit time is the LATEST commit's; it was shown beside the
    // graded one, dating it 4 hours later than it was.
    const late = {
      ...report,
      students: report.students.map((s) => (s.github_login === 'student-alice'
        ? { ...s, latest_observed_sha: sha(9), commit_date: '2026-10-01T16:00:00.000Z', latest_commit_date: '2026-10-01T16:00:00.000Z', submission_status: 'late' }
        : s)),
    };
    await setup(page, { tab: 'grading', report: late });
    const aliceRow = page.locator('[data-grading-table] tr', { hasText: 'student-alice' });
    await expect(aliceRow.locator('a.sha')).toHaveText(sha(1).slice(0, 7), { timeout: 15000 });
    const title = await aliceRow.locator('a[data-grading-repo]').getAttribute('title');
    expect(title).toMatch(new RegExp(`Graded commit ${sha(1).slice(0, 7)}$`, 'm'));
    expect(title).not.toContain('committed');
  });

  test('Grading table sorting on the Score and Login headers', async ({ page }) => {
    await setup(page, { tab: 'grading' });
    const autogradeTable = page.locator('[data-grading-table] table');

    // Click Login header to sort descending
    const loginTh = autogradeTable.locator('th', { hasText: 'Login' });
    await loginTh.click();
    await expect(loginTh).toHaveAttribute('aria-sort', 'descending');
    // Every student is a row now, david too: in no summary, "Not read yet".
    let rows = autogradeTable.locator('tbody tr');
    await expect(rows.nth(0)).toContainText('student-david');
    await expect(rows.nth(1)).toContainText('student-charlie');

    // Click the Score header to sort ascending (10, 18, 20, then no score)
    const earnedTh = autogradeTable.locator('th', { hasText: 'Score' });
    await earnedTh.click();
    await expect(earnedTh).toHaveAttribute('aria-sort', 'ascending');
    rows = autogradeTable.locator('tbody tr');
    await expect(rows.nth(0)).toContainText('student-bob');
    await expect(rows.nth(1)).toContainText('student-charlie');
    await expect(rows.nth(2)).toContainText('student-alice');
    await expect(rows.nth(3)).toContainText('student-david');

    // Click the Score header again for descending (20, 18, 10) - no score
    // stays last whichever way it is sorted.
    await earnedTh.click();
    await expect(earnedTh).toHaveAttribute('aria-sort', 'descending');
    rows = autogradeTable.locator('tbody tr');
    await expect(rows.nth(0)).toContainText('student-alice');
    await expect(rows.nth(1)).toContainText('student-charlie');
    await expect(rows.nth(2)).toContainText('student-bob');
    await expect(rows.nth(3)).toContainText('student-david');
  });

  test('Submissions table sorting on its Score header', async ({ page }) => {
    await setup(page);
    const submissionsTable = page.locator('.table-wrapper.desktop-only table');
    await expect(submissionsTable).toBeVisible();

    // Sort by Score ascending
    const scoreTh = submissionsTable.locator('th.col-score');
    await scoreTh.click();
    await expect(scoreTh).toHaveAttribute('aria-sort', 'ascending');
    let rows = submissionsTable.locator('tbody tr');
    // student-david has no score (nulls sorted last)
    await expect(rows.nth(0)).toContainText('student-bob');     // 10
    await expect(rows.nth(1)).toContainText('student-charlie'); // 18
    await expect(rows.nth(2)).toContainText('student-alice');   // 20
    await expect(rows.nth(3)).toContainText('student-david');   // null

    // Sort by Score descending
    await scoreTh.click();
    await expect(scoreTh).toHaveAttribute('aria-sort', 'descending');
    rows = submissionsTable.locator('tbody tr');
    await expect(rows.nth(0)).toContainText('student-alice');   // 20
    await expect(rows.nth(1)).toContainText('student-charlie'); // 18
    await expect(rows.nth(2)).toContainText('student-bob');     // 10
    await expect(rows.nth(3)).toContainText('student-david');   // null
  });

  test('Read all scores again: beside it, when the scores were read and from where; the box says what they add up to', async ({ page }) => {
    const { contentWrites } = await setup(page, { tab: 'grading' });
    // Beside the button, not at the bottom (asked 2026-10-08).
    const read = page.locator('.grading-actions [data-scores-read]');
    // charlie was read an hour after the others: the oldest read is the time,
    // and who read them is not claimed for everybody - hover says the rest.
    await expect(read).toContainText('Scores read from GitHub Actions');
    await expect(read.locator('time')).toHaveAttribute('datetime', '2026-10-01T13:00:00.000Z');
    await expect(read).toHaveAttribute('title', /^1 student was read again since, the latest .+ by @lecturer1\.$/);
    const box = page.locator('[data-grading-box]');
    await expect(box).toHaveAttribute('data-state', 'read');
    await expect(box).toContainText('Average');

    const regradeBtn = page.locator('.grading-actions').getByRole('button', { name: /Read all scores again/ });
    await expect(regradeBtn).toBeVisible();
    await regradeBtn.click();

    // Done: the block says who read them now, from the summary just saved - a
    // status worked out from what is on record (DESIGN.md §1.5).
    await expect.poll(() => contentWrites.some((w) => w.path === `grading/${ID}/summary.json`), { timeout: 15000 }).toBe(true);
    await expect(read).toContainText(`Scores read by @${LECTURER.login} from GitHub Actions`);
    await expect(box).toHaveAttribute('data-state', 'read');
  });

  test('on Progress, beside Refresh: when the commits were read and how, and no footer', async ({ page }) => {
    const readAt = (i) => `2026-10-01T1${i}:30:00.000Z`;
    const read2 = {
      ...report,
      students: students.map((s, i) => ({ ...s, latest_observed_at: readAt(i), latest_observation_type: i === 0 ? 'scheduled' : 'manual' })),
    };
    await setup(page, { report: read2 });
    const read = page.locator('.actions-bar [data-commits-read]');
    await expect(read).toBeVisible({ timeout: 15000 });
    // The OLDEST read, and how that one was made.
    await expect(read).toContainText('Commits read by the nightly check');
    await expect(read.locator('time')).toHaveAttribute('datetime', readAt(0));
    // Hover adds what the two lines do not say.
    await expect(read).toHaveAttribute('title', /^The oldest of 4 students' reads; the newest was .+\. The report was last rebuilt .+\.$/);
    await expect(page.locator('.table-footer')).toHaveCount(0);
    // The GitHub quota is the Organization tab's, not a block here (it did
    // not fit beside the buttons, 2026-10-10).
    await expect(page.locator('[data-api-quota]')).toHaveCount(0);
  });

  test('the cards count the table, filter it, and the box gives the average', async ({ page }) => {
    const summaryWithFailed = {
      ...initialSummary,
      failed: [{ login: 'student-david', reason: 'no CI run at commit 04aaaaa', kind: 'no-result' }],
    };
    await setup(page, { summary: summaryWithFailed, tab: 'grading' });
    const card = (label) => page.locator('[data-grading-cards] .summary-card', { hasText: label }).locator('.summary-value');
    await expect(card('Students')).toHaveText('4');
    await expect(card('Scored')).toHaveText('3');
    await expect(card('Needs a look')).toHaveText('1');
    // The deadline has passed, so nothing handed in is red - none here.
    await expect(card('Not handed in')).toHaveText('0');
    await expect(card('Not handed in')).toHaveClass(/stat-red/);
    await expect(page.locator('[data-grading-box]')).toContainText('Average 16 / 20 over 3 students, 1 at full marks.');

    // The card filters the table, as on Progress.
    await page.locator('[data-grading-cards] .summary-card', { hasText: 'Needs a look' }).click();
    const rows = page.locator('[data-grading-table] tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('student-david');
    await expect(rows.first()).toContainText('No score to read');
    await expect(rows.first()).toContainText('no CI run at commit 04aaaaa');
    await expect(rows.first().locator('.status-dot')).toHaveClass(/dot-danger/);
  });

  test('a score is the Progress badge, and a failed run is not called a failure beside its score', async ({ page }) => {
    await setup(page, { tab: 'grading' });
    const bob = page.locator('[data-grading-table] tr', { hasText: 'student-bob' });
    const badge = bob.locator('[data-grading-score]');
    await expect(badge).toHaveText(/10\/20 pts/);
    await expect(badge).toHaveClass(/badge-warning/);
    await expect(page.locator('[data-grading-table] th', { hasText: 'CI status' })).toHaveCount(0);
    await expect(page.locator('[data-grading-table]')).not.toContainText('failure');
    await badge.click();
    const dialog = page.locator('.autograde-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText('failure');
  });

  test('Export Grades (Excel XLSX) exports confirmed_email, login, name, and authentic commit date in .xlsx format', async ({ page }) => {
    await setup(page, { tab: 'grading' });

    await page.locator('.grading-actions').getByRole('button', { name: /^Export/ }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.grading-actions').getByRole('menuitem', { name: /Export grades/ }).click(),
    ]);

    expect(download.suggestedFilename()).toBe(`${ID}-grades.xlsx`);
    const path = await download.path();
    const fileBytes = readFileSync(path);
    // Verify PK zip header
    expect(fileBytes[0]).toBe(0x50);
    expect(fileBytes[1]).toBe(0x4b);
    expect(fileBytes[2]).toBe(0x03);
    expect(fileBytes[3]).toBe(0x04);

    const text = fileBytes.toString('utf8');
    expect(text).toContain('confirmed_email');
    expect(text).toContain('github_login');
    expect(text).toContain('full_name');
    expect(text).toContain('last_commit_before_deadline_time');
    expect(text).toContain('alice.alison@student.pxl.be');
    expect(text).toContain('student-alice');
    expect(text).toContain('2026-10-01T10:15:00.000Z');
  });

  test('Export Breakdown (Excel) skips detailed log for max points and includes breakdown for partial points', async ({ page }) => {
    await setup(page, { tab: 'grading' });

    await page.locator('.grading-actions').getByRole('button', { name: /^Export/ }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.grading-actions').getByRole('menuitem', { name: /Export breakdown/ }).click(),
    ]);

    expect(download.suggestedFilename()).toBe(`${ID}-breakdown.xlsx`);
    const path = await download.path();
    const fileBytes = readFileSync(path);
    // Verify PK zip header
    expect(fileBytes[0]).toBe(0x50);
    expect(fileBytes[1]).toBe(0x4b);
    expect(fileBytes[2]).toBe(0x03);
    expect(fileBytes[3]).toBe(0x04);

    const text = fileBytes.toString('utf8');
    // Alice has maximum points (20/20) -> detailed breakdown is skipped for optimization
    expect(text).toContain('Full score (20/20)');

    // Bob has partial points (10/20) -> breakdown from local JSON is included
    expect(text).toContain('test_alpha: PASS (10/10)');
    expect(text).toContain('test_beta: FAIL (0/10)');

    // Charlie has manual override
    expect(text).toContain('Manual score set by @lecturer1');

    // David has no submission
    expect(text).toContain('No submission');
  });

  test('Top choice in Export dropdown is Export Excel (.xlsx)', async ({ page }) => {
    await setup(page);

    const exportBtn = page.getByRole('button', { name: /Export/ }).first();
    await exportBtn.click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.export-dropdown-item', { hasText: 'Export Excel (.xlsx)' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe(`${ID}.xlsx`);
    const path = await download.path();
    const fileBytes = readFileSync(path);
    expect(fileBytes[0]).toBe(0x50);
    expect(fileBytes[1]).toBe(0x4b);
    expect(fileBytes[2]).toBe(0x03);
    expect(fileBytes[3]).toBe(0x04);
  });

  test('NOTHING HANDED IN IS NOT A GRADING FAILURE: a row of its own, grey before the deadline, red after', async ({ page }) => {
    // 2026-10-08: twenty students four days before an exam's deadline were a
    // red "20 grading failure(s)" at the bottom of the tab. A row written before
    // failed rows carried a kind is read from its sentence.
    const notHandedIn = {
      ...initialSummary,
      failed: [{ login: 'student-david', reason: 'no commit says "final submission", so nothing was handed in' }],
    };
    await setup(page, { summary: notHandedIn, tab: 'grading' });
    await expect(page.locator('details.autograde-failed')).toHaveCount(0);
    const david = page.locator('[data-grading-table] tr', { hasText: 'student-david' });
    await expect(david).toHaveAttribute('data-grading-status', 'not-handed-in');
    // The deadline here has passed: red, and no "yet".
    await expect(david).toContainText('Not handed in');
    await expect(david).not.toContainText('Not handed in yet');
    await expect(david.locator('.status-dot')).toHaveClass(/dot-danger/);
    const card = page.locator('[data-grading-cards] .summary-card', { hasText: 'Not handed in' });
    await expect(card.locator('.summary-value')).toHaveText('1');
    await expect(page.locator('[data-grading-cards] .summary-card', { hasText: 'Needs a look' }).locator('.summary-value')).toHaveText('0');
  });

  test('before the deadline it is "not handed in yet", in grey', async ({ page }) => {
    const future = '2099-01-01T12:00:00.000Z';
    const notHandedIn = {
      ...initialSummary,
      failed: [{ login: 'student-david', reason: 'no commit says "final submission", so nothing was handed in', kind: 'not-handed-in' }],
    };
    await setup(page, {
      summary: notHandedIn,
      tab: 'grading',
      assignment: { ...assignment, deadline_at: future, state: 'published' },
      report: { ...report, students: students.map((s) => ({ ...s, effective_deadline_at: future })) },
    });
    const david = page.locator('[data-grading-table] tr', { hasText: 'student-david' });
    await expect(david).toContainText('Not handed in yet');
    await expect(david.locator('.status-dot')).toHaveClass(/dot-neutral/);
    const card = page.locator('[data-grading-cards] .summary-card', { hasText: 'Not handed in yet' });
    await expect(card.locator('.summary-value')).toHaveClass(/stat-neutral/);
  });
});


