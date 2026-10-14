// 114 - The dashboard's stuck-run banner, for hub staff on a working course.
//
// Review 2026-10-14 (P2-38, P2-33): the dashboard read hub write access only
// when the organization's control repository could not be read, so the banner
// the stuck-run fixes were made for (every page of runs, pending runs, a
// sentinel's own limit) never showed over a working course. And a page of runs
// that failed showed nothing, which reads as "nothing is stuck".

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
import { HUB_OWNER, HUB_REPO_NAME } from '../../lib/deployment.mjs';

const ID = 'lab-banner';
const dashboard = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  assignments: { [ID]: { title: 'Banner Lab', state: 'published', deadline_at: new Date(Date.now() + 86400_000).toISOString(), accepted: 1 } },
};
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

/** `runs`: status -> { status, body } for the hub's run lists. */
async function open(page, { push = true, runs = {} } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, reports: { dashboard } });
  await page.route(new RegExp(`/repos/${HUB_OWNER}/${HUB_REPO_NAME}$`), (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: HUB_REPO_NAME, permissions: { push } }) }));
  await page.route(new RegExp(`/repos/${HUB_OWNER}/${HUB_REPO_NAME}/actions/runs\\?`), (route) => {
    const status = new URL(route.request().url()).searchParams.get('status');
    const answer = runs[status] ?? { status: 200, body: { total_count: 0, workflow_runs: [] } };
    return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
  });
  await page.goto(`/dashboard/${ORG}`);
}

test.describe('114 - the stuck-run banner, on a working course', () => {
  test('hub staff see a run stuck waiting', async ({ page }) => {
    await open(page, {
      runs: {
        waiting: { status: 200, body: { total_count: 1, workflow_runs: [{ id: 501, name: 'Regenerate Dashboard Data', path: '.github/workflows/regenerate-dashboard.yml', status: 'waiting', created_at: ago(40), run_started_at: ago(40) }] } },
      },
    });
    const banner = page.locator('.pipeline-stuck-banner[role="alert"]');
    await expect(banner).toContainText('Regenerate Dashboard Data', { timeout: 15000 });
    await expect(banner.getByRole('button', { name: /Cancel Run/ })).toBeVisible();
  });

  test('TL-13: a run held behind its concurrency group past its limit is shown; a sentinel inside its own is not', async ({ page }) => {
    await open(page, {
      runs: {
        pending: { status: 200, body: { total_count: 2, workflow_runs: [
          { id: 601, name: 'Accept assignment', path: '.github/workflows/acceptance-handler.yml', status: 'pending', created_at: ago(60) },
          { id: 602, name: 'Deadline Sentinel', path: '.github/workflows/deadline-sentinel.yml', status: 'pending', created_at: ago(200) },
        ] } },
      },
    });
    const banner = page.locator('.pipeline-stuck-banner[role="alert"]');
    await expect(banner).toContainText('Accept assignment', { timeout: 15000 });
    await expect(banner).toContainText('pending');
    await expect(banner).not.toContainText('Deadline Sentinel');
  });

  test('a page of runs that cannot be read is said, never "nothing stuck" by silence', async ({ page }) => {
    await open(page, { runs: { in_progress: { status: 502, body: { message: 'Bad Gateway' } } } });
    await expect(page.locator('[data-hub-runs-unread]')).toContainText('Not every run of the hub could be read', { timeout: 15000 });
    await expect(page.locator('.pipeline-stuck-banner[role="alert"]')).toHaveCount(0);
    // TL-14: Diagnostics says the same, as a warning, with nothing to cancel.
    await page.locator('[data-hub-runs-unread]').getByRole('button', { name: 'Diagnostics' }).click();
    await expect(page.getByText('Central Hub Pipeline Health')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/Not every running or waiting workflow run could be read, so whether one is stuck is not known/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancel Stuck Run/ })).toHaveCount(0);
  });

  test('an account that cannot write to the hub sees neither', async ({ page }) => {
    await open(page, {
      push: false,
      runs: { waiting: { status: 200, body: { total_count: 1, workflow_runs: [{ id: 501, name: 'X', path: '.github/workflows/x.yml', status: 'waiting', created_at: ago(40) }] } } },
    });
    await expect(page.getByRole('heading', { name: /Banner Lab/ }).first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await expect(page.locator('.pipeline-stuck-banner')).toHaveCount(0);
  });
});
