// 90 - Grade exports, autograder table enhancements, and regrade progress panel
//
// Tests:
// 1. Autograder table dedicated columns: Confirmed address & Last commit with links.
// 2. Autograder table interactive sorting across all headers (numeric, string, date).
// 3. Submissions table sorting on CI Status, Score, and Last commit.
// 4. Regrade Run Progress Panel with live counters and dismiss button.
// 5. Export Grades (CSV) with confirmed_email first, github_login second, full_name third.
// 6. Export Detailed Breakdown (CSV) with multi-line feedback_breakdown snippet.

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
    commit_date: '2026-10-01T10:15:00.000Z',
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
    assignments: { [ID]: assignment },
    reports: { [ID]: report },
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
    const autogradeTable = page.locator('.autograde-section table');
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
    const aliceRow = page.locator('.autograde-section table tr', { hasText: 'student-alice' });
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

  test('Autograder table sorting on Earned points and Login headers', async ({ page }) => {
    await setup(page, { tab: 'grading' });
    const autogradeTable = page.locator('.autograde-section table');

    // Click Login header to sort descending
    const loginTh = autogradeTable.locator('th', { hasText: 'Login' });
    await loginTh.click();
    await expect(loginTh).toHaveAttribute('aria-sort', 'descending');
    let rows = autogradeTable.locator('tbody tr');
    await expect(rows.nth(0)).toContainText('student-charlie');

    // Click Earned header to sort ascending (10, 18, 20)
    const earnedTh = autogradeTable.locator('th', { hasText: 'Earned' });
    await earnedTh.click();
    await expect(earnedTh).toHaveAttribute('aria-sort', 'ascending');
    rows = autogradeTable.locator('tbody tr');
    await expect(rows.nth(0)).toContainText('student-bob');
    await expect(rows.nth(1)).toContainText('student-charlie');
    await expect(rows.nth(2)).toContainText('student-alice');

    // Click Earned header again for descending (20, 18, 10)
    await earnedTh.click();
    await expect(earnedTh).toHaveAttribute('aria-sort', 'descending');
    rows = autogradeTable.locator('tbody tr');
    await expect(rows.nth(0)).toContainText('student-alice');
    await expect(rows.nth(1)).toContainText('student-charlie');
    await expect(rows.nth(2)).toContainText('student-bob');
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

  test('Regrade Run Progress Panel appears on regrade action and can be dismissed', async ({ page }) => {
    await setup(page, { tab: 'grading' });

    // Read all scores again, on the Grading tab (it reads the runs; it starts none)
    const regradeBtn = page.locator('.grading-actions').getByRole('button', { name: /Read all scores again/ });
    await expect(regradeBtn).toBeVisible();
    await regradeBtn.click();

    // The regrade progress panel should appear
    const progressPanel = page.locator('.regrade-progress-panel');
    await expect(progressPanel).toBeVisible();

    // After completion, it shows success message
    await expect(progressPanel).toContainText(/Scores updated|successfully read/i);

    // Dismiss the panel
    const dismissBtn = progressPanel.getByRole('button', { name: 'Dismiss progress panel' });
    await dismissBtn.click();
    await expect(progressPanel).not.toBeVisible();
  });

  test('Export Grades (Excel XLSX) exports confirmed_email, login, name, and authentic commit date in .xlsx format', async ({ page }) => {
    await setup(page, { tab: 'grading' });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.grading-actions').getByRole('button', { name: 'Export grades' }).click(),
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

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.grading-actions').getByRole('button', { name: 'Export breakdown' }).click(),
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

  test('Grading failures disclosure is collapsible and expands on click', async ({ page }) => {
    const summaryWithFailed = {
      ...initialSummary,
      failed: [{ login: 'student-david', reason: 'no commit says "final submission", so nothing was handed in' }],
    };
    await setup(page, { summary: summaryWithFailed, tab: 'grading' });
    const failureDetails = page.locator('details.autograde-failed').first();
    await expect(failureDetails).toBeVisible();
    await expect(failureDetails).not.toHaveAttribute('open', '');

    const summary = failureDetails.locator('summary');
    await expect(summary).toContainText('grading failure(s)');

    // List items are hidden when collapsed
    await expect(failureDetails.locator('li', { hasText: 'student-david' })).not.toBeVisible();

    // Click to open
    await summary.click();
    await expect(failureDetails).toHaveAttribute('open', '');
    await expect(failureDetails.locator('li', { hasText: 'student-david' })).toBeVisible();

    // Click to collapse again
    await summary.click();
    await expect(failureDetails).not.toHaveAttribute('open', '');
    await expect(failureDetails.locator('li', { hasText: 'student-david' })).not.toBeVisible();
  });
});


