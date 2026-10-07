// 104 - While a publish goes live, the editor says the step GitHub is at.
//
// 2026-10-06, during a GitHub incident, a lecturer read "Publishing: the
// student page goes live in a minute or two. (checked 45x)" for half an hour.
// GitHub had not started the publish; then a Pages deploy failed. Both are in
// the hub's workflow runs, so the line reads them (lib/publish-progress.js) -
// the run THIS publish started, by the id GitHub gave at the dispatch (review
// 2026-10-07: "this lecturer's newest run" could be another tab's).

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'labo-git';
const RUN = '18320775543';
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

async function watch(page, { publishRun = null, deployRuns = [], publishing = RUN }) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: {
      [ID]: {
        id: ID, title: 'Labo Git', organization: ORG, state: 'published', assignment_type: 'individual',
        template: { owner: ORG, repository: 'starter-template' }, repository_name_pattern: `${ID}-{github_login}`,
      },
    },
  });
  const asked = [];
  await page.route('**/actions/workflows/publish-assignment.yml/runs*', (route) => {
    asked.push(route.request().url());
    return route.fulfill({ json: { total_count: 0, workflow_runs: [] } });
  });
  await page.route(new RegExp(`/actions/runs/${RUN}$`), (route) => {
    asked.push(route.request().url());
    return route.fulfill({ json: publishRun });
  });
  await page.route('**/actions/workflows/deploy-frontend.yml/runs*', (route) =>
    route.fulfill({ json: { total_count: deployRuns.length, workflow_runs: deployRuns } }));
  await page.goto(`/dashboard/${ORG}/${ID}?tab=settings&publishing=${publishing}`);
  return asked;
}

test.describe('104 - the publishing line', () => {
  test('GitHub has not started the publish: said, with how long, and GitHub\'s status page', async ({ page }) => {
    const asked = await watch(page, {
      publishRun: { id: Number(RUN), status: 'queued', conclusion: null, created_at: minutesAgo(7), updated_at: minutesAgo(7), html_url: 'https://github.com/x/runs/1' },
    });
    const line = page.locator('.publish-watch');
    await expect(line).toHaveAttribute('data-publish-step', 'waiting-start', { timeout: 20000 });
    await expect(line).toContainText('Waiting for GitHub to start the publish (7 min).');
    await expect(line.getByRole('link', { name: 'githubstatus.com' })).toHaveAttribute('href', 'https://www.githubstatus.com');
    await expect(line).not.toContainText('checked');
    // The run this publish started, by its id - never a list of runs to guess from.
    expect(asked.some((u) => u.endsWith(`/actions/runs/${RUN}`))).toBe(true);
    expect(asked.some((u) => u.includes('publish-assignment.yml/runs'))).toBe(false);
  });

  test('published, but the deploy failed: said, and that it is tried again', async ({ page }) => {
    await watch(page, {
      publishRun: { status: 'completed', conclusion: 'success', created_at: minutesAgo(12), updated_at: minutesAgo(11), html_url: 'https://github.com/x/runs/1' },
      deployRuns: [{ status: 'completed', conclusion: 'failure', created_at: minutesAgo(10), updated_at: minutesAgo(9), html_url: 'https://github.com/x/runs/2' }],
    });
    const line = page.locator('.publish-watch');
    await expect(line).toHaveAttribute('data-publish-step', 'deploy-failed', { timeout: 20000 });
    await expect(line).toContainText('Published, but GitHub could not put the student page live. It is tried again automatically.');
    await expect(line.getByRole('link', { name: 'githubstatus.com' })).toHaveCount(0);
  });

  test('a publish that did not finish links its run and stops checking - no spinner', async ({ page }) => {
    const asked = await watch(page, {
      publishRun: { status: 'completed', conclusion: 'failure', created_at: minutesAgo(3), updated_at: minutesAgo(2), html_url: 'https://github.com/x/runs/9' },
    });
    const line = page.locator('.publish-watch');
    await expect(line).toHaveAttribute('data-publish-step', 'failed', { timeout: 20000 });
    await expect(line).toContainText('The publish did not finish on GitHub.');
    await expect(line.getByRole('link', { name: 'See the run.' })).toHaveAttribute('href', 'https://github.com/x/runs/9');
    await expect(line.locator('.spinner')).toHaveCount(0);
    const reads = asked.length;
    await page.waitForTimeout(12_000);
    expect(asked.length, 'nothing more is asked of GitHub').toBe(reads);
  });

  test('the pages were updated without this assignment\'s page: said, with the deploy\'s run', async ({ page }) => {
    await watch(page, {
      publishRun: { status: 'completed', conclusion: 'success', created_at: minutesAgo(12), updated_at: minutesAgo(11), html_url: 'https://github.com/x/runs/1' },
      deployRuns: [{ status: 'completed', conclusion: 'success', created_at: minutesAgo(10), updated_at: minutesAgo(8), html_url: 'https://github.com/x/runs/3' }],
    });
    const line = page.locator('.publish-watch');
    await expect(line).toHaveAttribute('data-publish-step', 'deployed-without-page', { timeout: 20000 });
    await expect(line).toContainText("Published, but the student pages were updated 8 min ago without this assignment's page.");
    await expect(line.getByRole('link', { name: 'See the run.' })).toHaveAttribute('href', 'https://github.com/x/runs/3');
  });

  test('GitHub named no run: the line says so instead of guessing one', async ({ page }) => {
    const asked = await watch(page, { publishing: '1' });
    const line = page.locator('.publish-watch');
    await expect(line).toHaveAttribute('data-publish-step', 'untracked', { timeout: 20000 });
    await expect(line).toContainText('GitHub did not say which run it started');
    expect(asked, 'no list of runs is read to guess from').toEqual([]);
  });
});
