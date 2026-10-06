// 104 - While a publish goes live, the editor says the step GitHub is at.
//
// 2026-10-06, during a GitHub incident, a lecturer read "Publishing: the
// student page goes live in a minute or two. (checked 45x)" for half an hour.
// GitHub had not started the publish; then a Pages deploy failed. Both are in
// the hub's workflow runs, so the line reads them (lib/publish-progress.js).

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'labo-git';
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

async function watch(page, { publishRuns, deployRuns = [] }) {
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
    return route.fulfill({ json: { total_count: publishRuns.length, workflow_runs: publishRuns } });
  });
  await page.route('**/actions/workflows/deploy-frontend.yml/runs*', (route) =>
    route.fulfill({ json: { total_count: deployRuns.length, workflow_runs: deployRuns } }));
  await page.goto(`/dashboard/${ORG}/${ID}?tab=settings&publishing=1`);
  return asked;
}

test.describe('104 - the publishing line', () => {
  test('GitHub has not started the publish: said, with how long, and GitHub\'s status page', async ({ page }) => {
    const asked = await watch(page, {
      publishRuns: [{ status: 'queued', conclusion: null, created_at: minutesAgo(7), updated_at: minutesAgo(7), html_url: 'https://github.com/x/runs/1' }],
    });
    const line = page.locator('.publish-watch');
    await expect(line).toHaveAttribute('data-publish-step', 'waiting-start', { timeout: 20000 });
    await expect(line).toContainText('Waiting for GitHub to start the publish (7 min).');
    await expect(line.getByRole('link', { name: 'githubstatus.com' })).toHaveAttribute('href', 'https://www.githubstatus.com');
    await expect(line).not.toContainText('checked');
    // This lecturer's own dispatched publish, not anyone's.
    expect(decodeURIComponent(asked[0])).toContain(`actor=${LECTURER.login}`);
  });

  test('published, but the deploy failed: said, and that it is tried again', async ({ page }) => {
    await watch(page, {
      publishRuns: [{ status: 'completed', conclusion: 'success', created_at: minutesAgo(12), updated_at: minutesAgo(11), html_url: 'https://github.com/x/runs/1' }],
      deployRuns: [{ status: 'completed', conclusion: 'failure', created_at: minutesAgo(10), updated_at: minutesAgo(9), html_url: 'https://github.com/x/runs/2' }],
    });
    const line = page.locator('.publish-watch');
    await expect(line).toHaveAttribute('data-publish-step', 'deploy-failed', { timeout: 20000 });
    await expect(line).toContainText('Published, but GitHub could not put the student page live. It is tried again automatically.');
    await expect(line.getByRole('link', { name: 'githubstatus.com' })).toHaveCount(0);
  });

  test('a publish that did not finish links its run', async ({ page }) => {
    await watch(page, {
      publishRuns: [{ status: 'completed', conclusion: 'failure', created_at: minutesAgo(3), updated_at: minutesAgo(2), html_url: 'https://github.com/x/runs/9' }],
    });
    const line = page.locator('.publish-watch');
    await expect(line).toHaveAttribute('data-publish-step', 'failed', { timeout: 20000 });
    await expect(line.getByRole('link', { name: 'See the run.' })).toHaveAttribute('href', 'https://github.com/x/runs/9');
  });
});
