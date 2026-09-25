// The assignment page says where its last starter sync stands.
//
// 2026-09-25, PXL-2TIN-NetAdv-26-27: two syncs were cut off by a timeout and
// nothing on screen said so - the dialog had said "dispatched successfully"
// and a later sync reported success. The line below the header now reads the
// newest sync record, and when that record says `running`, the run it names.
// One read on load and one per "Check again": no timer.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'lab-status';
const TPL = 'template-status';
const HEAD = 'a'.repeat(40);
const FILE = 'sync-20260925T151518Z-b1gcxj.json';

const record = (over = {}) => ({
  schema_version: 1,
  sync_id: FILE.replace('.json', ''),
  assignment_id: ID,
  synced_at: '2026-09-25T15:15:18Z',
  synced_by: 'wesleyhendrikx',
  status: 'completed',
  run_id: 777,
  run_url: 'https://github.com/Hub/pxl-classroom/actions/runs/777',
  total_students: 3,
  remaining: 0,
  template_repo: `${ORG}/${TPL}`,
  template_sha: HEAD,
  selected_files: [],
  summary: { total: 3, auto_merged: 1, pr_opened: 0, skipped: 2, failed: 0 },
  results: [
    { github_login: 'ada', repo_name: `${ORG}/r-ada`, outcome: 'auto-merged' },
    { github_login: 'bo', repo_name: `${ORG}/r-bo`, outcome: 'skipped-up-to-date' },
    { github_login: 'cy', repo_name: `${ORG}/r-cy`, outcome: 'skipped-up-to-date' },
  ],
  ...over,
});

async function setup(page, { rec, run = null, templateHead = HEAD, listingStatus = 200 }) {
  const calls = { runs: 0 };
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: {
      [ID]: { id: ID, title: 'Status', organization: ORG, state: 'published', assignment_type: 'individual', template: { owner: ORG, repository: TPL } },
    },
    reports: {
      [ID]: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        assignment_id: ID,
        students: [{ github_login: STUDENT_1.login, acceptance_state: 'provisioned', submission_status: 'on-time', repo_name: `${ORG}/${ID}-${STUDENT_1.login}` }],
      },
    },
  });
  await page.route(/api\.github\.com\/repos\/[^/]+\/pxl-classroom-control\/contents\/syncs\//, async (route) => {
    const url = route.request().url();
    if (url.endsWith(`/syncs/${ID}`) || url.includes(`/syncs/${ID}?`)) {
      if (listingStatus !== 200) return route.fulfill({ status: listingStatus, body: JSON.stringify({ message: 'x' }) });
      return route.fulfill({ status: 200, body: JSON.stringify([{ type: 'file', name: FILE, path: `syncs/${ID}/${FILE}` }]) });
    }
    if (url.includes(FILE)) {
      return route.fulfill({
        status: 200,
        body: JSON.stringify({ content: Buffer.from(JSON.stringify(rec)).toString('base64'), encoding: 'base64' }),
      });
    }
    return route.fallback();
  });
  await page.route(/api\.github\.com\/repos\/[^/]+\/[^/]+\/actions\/runs\/777$/, async (route) => {
    calls.runs++;
    if (!run) return route.fulfill({ status: 500, body: '{}' });
    return route.fulfill({ status: 200, body: JSON.stringify(run) });
  });
  await page.route(new RegExp(`api\\.github\\.com/repos/${ORG}/${TPL}/commits\\?per_page=1`), (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([{ sha: templateHead }]) }),
  );
  return calls;
}

const line = (page) => page.locator('.sync-status');

test.describe('81 - The assignment page says where the last starter sync stands', () => {
  test('completed and current: a quiet success line, no action', async ({ page }) => {
    await setup(page, { rec: record() });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(line(page)).toHaveAttribute('data-state', 'completed');
    await expect(line(page)).toContainText('Starter code: Last sync by @wesleyhendrikx: aaaaaaa, all 3 students handled');
    await expect(line(page)).toContainText('1 updated, 2 already had it.');
    await expect(line(page).locator('.status-dot.dot-success')).toBeVisible();
    await expect(line(page).getByRole('button')).toHaveCount(0);
  });

  test('the template moved on since: says so, and Sync again opens the sync', async ({ page }) => {
    await setup(page, { rec: record(), templateHead: 'b'.repeat(40) });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(line(page)).toHaveAttribute('data-state', 'template-changed');
    await expect(line(page)).toContainText('The template has changed since - sync again to send it.');
    await line(page).getByRole('button', { name: 'Sync again' }).click();
    await expect(page.locator('#starter-sync-title')).toBeVisible();
  });

  test('a run that died with the record still at running: the NetAdv case, told plainly', async ({ page }) => {
    await setup(page, {
      rec: record({ status: 'running', remaining: undefined, total_students: 111, results: Array.from({ length: 31 }, (_, i) => ({ github_login: `s${i}`, repo_name: `${ORG}/r${i}`, outcome: 'auto-merged' })) }),
      run: { status: 'completed', conclusion: 'cancelled', html_url: 'https://github.com/Hub/pxl-classroom/actions/runs/777' },
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(line(page)).toHaveAttribute('data-state', 'died');
    await expect(line(page)).toContainText('was cancelled before it finished');
    // The sha is set in monospace (DESIGN.md §2).
    await expect(line(page).locator('strong code')).toHaveText('aaaaaaa');
    await expect(line(page)).toContainText('31 of 111 students reached');
    await expect(line(page).getByRole('link', { name: 'View run' })).toHaveAttribute('href', 'https://github.com/Hub/pxl-classroom/actions/runs/777');
    await expect(line(page).locator('.status-dot.dot-warning')).toBeVisible();
  });

  test('running: progress, and Check again reads once more - nothing reads on its own', async ({ page }) => {
    const calls = await setup(page, {
      rec: record({ status: 'running', remaining: undefined, total_students: 111, results: [] }),
      run: { status: 'in_progress' },
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(line(page)).toHaveAttribute('data-state', 'running');
    await expect(line(page)).toContainText('0 of 111 students done at the last count.');
    expect(calls.runs).toBe(1);
    await page.waitForTimeout(1500);
    expect(calls.runs, 'no polling').toBe(1);
    await line(page).getByRole('button', { name: 'Check again' }).click();
    await expect.poll(() => calls.runs).toBe(2);
  });

  test('stopped at its budget: how many are left', async ({ page }) => {
    await setup(page, { rec: record({ status: 'stopped', total_students: 111, remaining: 43, results: [] }) });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(line(page)).toContainText('stopped with 43 students not reached');
    await expect(line(page).getByRole('button', { name: 'Sync again' })).toBeVisible();
  });

  test('failed students are named, each with why', async ({ page }) => {
    await setup(page, {
      rec: record({ results: [{ github_login: 'ada', repo_name: `${ORG}/r-ada`, outcome: 'failed', error: 'could not read main (HTTP 404)' }] , total_students: 1 }),
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(line(page)).toHaveAttribute('data-state', 'completed-with-failures');
    await expect(line(page).locator('.sync-status-failed')).toContainText('@ada: could not read main (HTTP 404)');
    await expect(line(page).locator('.status-dot.dot-danger')).toBeVisible();
  });

  test('records that cannot be read say so - not "never synced"', async ({ page }) => {
    await setup(page, { rec: record(), listingStatus: 500 });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(line(page)).toHaveAttribute('data-state', 'unreadable');
    await expect(line(page)).toContainText('This is not "no sync has run" - it is unknown.');
  });

  test('never synced: no line at all', async ({ page }) => {
    await setup(page, { rec: record(), listingStatus: 404 });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(page.locator('.detail-header, h1, h2').first()).toBeVisible();
    await expect(line(page)).toHaveCount(0);
  });
});
