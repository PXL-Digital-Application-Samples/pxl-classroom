// 113 - Open feedback PRs, pressed (review 2026-10-14, phase 2).
//
// No spec pressed it. What it must do: open each pull request on the
// assignment's submission branch (S1, a `master` template here), say a failed
// student in the column as "Not opened" (P1-4), and show a PR number only once
// the records holding it are saved (P2-7) - written against the records as
// read, so a record changed during the press refuses the write (P2-4).

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'fb-press';

const assignment = {
  schema_version: 1,
  id: ID,
  title: 'Feedback Press',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'enforced',
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 86400_000).toISOString(),
  template: { owner: ORG, repository: 'fb-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  submission_ref: 'refs/heads/master',
  feedback_pr: true,
  feedback_pr_baseline_branch: 'pxl-baseline',
};

const students = ['a', 'b', 'c'].map((x) => ({
  github_login: `student-${x}`,
  acceptance_state: 'provisioned',
  submission_status: x === 'c' ? 'no-submission' : 'on-time',
  repo_name: `${ORG}/${ID}-student-${x}`,
  commit_count: x === 'c' ? 0 : 2,
}));

/**
 * `changedAtCommit`: the records read at a parent commit (`?ref=`) differ from
 * the ones read during the press - a move or a permission change meanwhile.
 */
async function open(page, { changedAtCommit = false, noCommitsFor = null } = {}) {
  const gitCommits = [];
  const pullBodies = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment },
    reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students } },
    gitCommits,
  });
  // Registered after the fixture, so these win.
  await page.route('**/pxl-classroom-control/contents/repositories/**', async (route) => {
    const url = route.request().url();
    const file = url.match(/repositories\/[^/]+\/([^/?#]+)\.json/);
    if (!file) {
      return route.fulfill({
        status: 200,
        body: JSON.stringify(students.map((s) => ({ name: `${s.github_login}.json`, path: `repositories/${ID}/${s.github_login}.json`, type: 'file' }))),
      });
    }
    const atCommit = /[?&]ref=/.test(url);
    const doc = {
      schema_version: 1, assignment_id: ID, github_login: file[1], repo_id: 900 + file[1].length,
      repo_name: `${ORG}/${ID}-${file[1]}`, repo_url: `https://github.com/${ORG}/${ID}-${file[1]}`,
      ...(changedAtCommit && atCommit ? { access_state: 'invited' } : {}),
    };
    return route.fulfill({ status: 200, body: JSON.stringify({ content: Buffer.from(JSON.stringify(doc, null, 2) + '\n').toString('base64'), encoding: 'base64', sha: atCommit ? 'later' : 'read' }) });
  });
  await page.route(new RegExp(`api\\.github\\.com/repos/${ORG}/${ID}-student-[a-z]/pulls$`), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    pullBodies.push({ url: route.request().url(), body: route.request().postDataJSON() });
    if (route.request().url().includes('student-a')) {
      return route.fulfill({ status: 201, body: JSON.stringify({ number: 7, html_url: `https://github.com/${ORG}/${ID}-student-a/pull/7` }) });
    }
    // GitHub's answer for a branch with nothing past the baseline.
    if (noCommitsFor && route.request().url().includes(noCommitsFor)) {
      return route.fulfill({ status: 422, body: JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'No commits between pxl-baseline and master' }] }) });
    }
    return route.fulfill({ status: 500, body: JSON.stringify({ message: 'Server Error' }) });
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.locator('.students-table, table')).toBeVisible({ timeout: 15000 });
  return { gitCommits, pullBodies };
}

async function press(page) {
  await page.locator('.assignment-tabs .primer-tab', { hasText: /^Grading$/ }).click();
  await page.locator('.grading-actions').getByRole('button', { name: /More/ }).click();
  await page.getByRole('menuitem', { name: /Open feedback PRs/i }).click();
  await page.getByRole('button', { name: /Open Feedback PRs on 2 Repo/ }).click();
  await expect(page.getByRole('button', { name: /Opening Pull Requests/ })).toHaveCount(0, { timeout: 15000 });
  await page.locator('.assignment-tabs .primer-tab', { hasText: /^Progress$/ }).click();
}

const cell = (page, login) => page.locator('tr', { hasText: login }).locator('td.col-feedback-pr');

test.describe('113 - Open feedback PRs, pressed', () => {
  test('on the submission branch; a failed student stays "Not opened"; nothing to review is a dash', async ({ page }) => {
    const { gitCommits, pullBodies } = await open(page);
    await press(page);
    expect(pullBodies.map((p) => p.body.head), 'the submission branch, never a spelled main (S1)').toEqual(['master', 'master']);
    expect(pullBodies.every((p) => p.body.base === 'pxl-baseline')).toBe(true);
    await expect(cell(page, 'student-a')).toContainText('#7');
    await expect(cell(page, 'student-b').locator('[data-fb-pr="not-opened"]')).toHaveText('Not opened');
    await expect(cell(page, 'student-c').locator('[data-fb-pr="nothing-yet"]')).toHaveText('-');
    await expect(page.locator('.toast', { hasText: /1 feedback PR could not be opened/ })).toBeVisible();
    expect(gitCommits).toHaveLength(1);
    expect(gitCommits[0].files.map((f) => f.path)).toEqual([`repositories/${ID}/student-a.json`]);
  });

  test('S10 (TS-12): nothing past the starting point yet is said as that, never as a PR that could not be opened', async ({ page }) => {
    await open(page, { noCommitsFor: 'student-b' });
    await press(page);
    await expect(page.locator('.toast', { hasText: '1 student has nothing past the starting point yet, so no feedback PR was opened for them.' })).toBeVisible();
    await expect(cell(page, 'student-a')).toContainText('#7');
    await page.waitForTimeout(500);
    await expect(page.locator('.toast', { hasText: /could not be opened/ })).toHaveCount(0);
  });

  test('a record changed during the press refuses the write, and the column shows no PR number it did not save (P2-4, P2-7)', async ({ page }) => {
    const { gitCommits } = await open(page, { changedAtCommit: true });
    await press(page);
    await expect(page.locator('.toast', { hasText: /recording them in the control repository failed/ })).toBeVisible({ timeout: 15000 });
    expect(gitCommits.filter((c) => c.files.some((f) => f.path.includes('student-a')))).toEqual([]);
    await expect(cell(page, 'student-a')).not.toContainText('#7');
    await expect(cell(page, 'student-a').locator('[data-fb-pr="not-opened"]')).toHaveText('Not opened');
  });
});
