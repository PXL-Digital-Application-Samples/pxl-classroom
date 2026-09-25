// The sync dialog follows the run it started, and can be reopened on it.
//
// 2026-09-25: the dialog said "dispatched successfully" and then nothing, while
// two syncs of .NET Advanced were cut off. It now asks GitHub for the run it
// started (`return_run_details`), checks that run and its record every 10
// seconds WHILE OPEN, stops when it is done or the dialog closes, and can be
// opened again from the assignment page's Starter code line.
//
// Timers run on Playwright's clock, so every check is counted.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes, openStarterSyncModal } from '../fixtures/e2e-fixtures.mjs';

const ID = 'lab-follow';
const TPL = 'template-follow';
const RUN = 555;
const FILE = 'sync-20260925T151518Z-b1gcxj.json';
const SHA = '1e7f7145a0499768a23976c4b7076ba21cc11b2f';

const record = (over = {}) => ({
  schema_version: 1, sync_id: FILE.replace('.json', ''), assignment_id: ID, synced_at: '2026-09-25T15:15:18Z',
  synced_by: LECTURER.login, run_id: RUN, run_url: `https://github.com/Hub/pxl-classroom/actions/runs/${RUN}`,
  template_repo: `${ORG}/${TPL}`, template_sha: SHA, selected_files: [], summary: {}, total_students: 111,
  status: 'running', results: [], ...over,
});
const res = (n) => Array.from({ length: n }, (_, i) => ({ github_login: `s${i}`, repo_name: `${ORG}/r${i}`, outcome: 'auto-merged' }));

/**
 * `state.run` and `state.rec` are what GitHub answers now; a test moves them
 * on between checks. `state.calls` counts the run reads.
 */
async function setup(page, { runsList = [], dispatchDetails = true } = {}) {
  const state = { run: { status: 'queued' }, rec: null, calls: 0, trees: 0, dispatchBody: null };
  await page.clock.install({ time: new Date('2026-09-25T15:15:00Z') });
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: { id: ID, title: 'Follow', organization: ORG, state: 'published', assignment_type: 'individual', template: { owner: ORG, repository: TPL } } },
    reports: { [ID]: { schema_version: 1, generated_at: new Date().toISOString(), assignment_id: ID, students: [{ github_login: STUDENT_1.login, acceptance_state: 'provisioned', submission_status: 'on-time', repo_name: `${ORG}/${ID}-${STUDENT_1.login}` }] } },
  });
  await page.route(/\/actions\/workflows\/sync-starter-code\.yml\/dispatches$/, async (route) => {
    state.dispatchBody = route.request().postDataJSON();
    if (!dispatchDetails) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 200, body: JSON.stringify({ workflow_run_id: RUN, run_url: `https://api.github.com/x/runs/${RUN}`, html_url: `https://github.com/Hub/pxl-classroom/actions/runs/${RUN}` }) });
  });
  await page.route(/\/actions\/workflows\/sync-starter-code\.yml\/runs/, (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ workflow_runs: runsList }) }));
  await page.route(new RegExp(`/actions/runs/${RUN}$`), (route) => {
    state.calls++;
    return route.fulfill({ status: 200, body: JSON.stringify({ id: RUN, html_url: `https://github.com/Hub/pxl-classroom/actions/runs/${RUN}`, ...state.run }) });
  });
  await page.route(/contents\/syncs\//, (route) => {
    const url = route.request().url();
    if (!state.rec) return route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
    if (url.includes(FILE)) return route.fulfill({ status: 200, body: JSON.stringify({ content: Buffer.from(JSON.stringify(state.rec)).toString('base64'), encoding: 'base64' }) });
    return route.fulfill({ status: 200, body: JSON.stringify([{ type: 'file', name: FILE, path: `syncs/${ID}/${FILE}` }]) });
  });
  page.on('request', (r) => { if (/\/git\/trees\/main/.test(r.url())) state.trees++; });
  return state;
}

const panel = (page) => page.locator('.follow-panel');
// A little past the 10-second interval, so the check it schedules has fired.
const tick = (page) => page.clock.runFor(11_000);

test.describe('82 - The sync dialog follows the run it started', () => {
  test('dispatch -> waiting -> running with progress -> done, and then it stops checking', async ({ page }) => {
    const state = await setup(page);
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await openStarterSyncModal(page);
    const modal = page.locator('.modal.card.modal-wide');
    await modal.locator('button', { hasText: /Apply Starter Update/i }).click();

    // It asked GitHub which run it started.
    await expect.poll(() => state.dispatchBody?.return_run_details).toBe(true);
    await expect(panel(page)).toHaveAttribute('data-state', 'waiting');
    await expect(panel(page)).toContainText('Waiting for GitHub to start the sync');
    await expect(panel(page).getByRole('link', { name: 'View run' })).toHaveAttribute('href', `https://github.com/Hub/pxl-classroom/actions/runs/${RUN}`);
    // The only button left is Close - nothing to decide, so no primary (DESIGN.md §1.2).
    await expect(modal.locator('.modal-foot .btn-primary')).toHaveCount(0);

    state.run = { status: 'in_progress' };
    state.rec = record({ results: res(40) });
    await tick(page);
    await expect(panel(page)).toHaveAttribute('data-state', 'running');
    await expect(panel(page)).toContainText('40 of 111 students at the last count');

    state.run = { status: 'completed', conclusion: 'success' };
    state.rec = record({ status: 'completed', remaining: 0, results: [...res(43), ...Array.from({ length: 68 }, (_, i) => ({ github_login: `k${i}`, repo_name: `${ORG}/k${i}`, outcome: 'skipped-up-to-date' }))] });
    await tick(page);
    await expect(panel(page)).toHaveAttribute('data-state', 'completed');
    await expect(panel(page)).toContainText('43 updated, 68 already had it.');
    await expect(panel(page)).toContainText('Finished checking at');

    const settled = state.calls;
    await page.clock.runFor(60_000);
    expect(state.calls, 'no checks after the outcome is known').toBe(settled);
  });

  test('closing the dialog stops the checking', async ({ page }) => {
    const state = await setup(page);
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await openStarterSyncModal(page);
    await page.locator('.modal.card.modal-wide button', { hasText: /Apply Starter Update/i }).click();
    // The first check has to have LANDED before the clock moves, or the next
    // one is not scheduled yet and advancing the clock proves nothing.
    await expect(panel(page)).toHaveAttribute('data-state', 'waiting');
    const first = state.calls;
    await page.clock.runFor(11_000);
    await expect.poll(() => state.calls, { timeout: 10_000 }).toBeGreaterThan(first);
    await page.locator('.modal-foot button', { hasText: 'Close' }).click();
    const atClose = state.calls;
    await page.clock.runFor(60_000);
    expect(state.calls).toBe(atClose);
  });

  test('a run that ends before recording anything: nothing was sent, and it says so', async ({ page }) => {
    const state = await setup(page);
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await openStarterSyncModal(page);
    await page.locator('.modal.card.modal-wide button', { hasText: /Apply Starter Update/i }).click();
    await expect(panel(page)).toHaveAttribute('data-state', 'waiting');
    state.run = { status: 'completed', conclusion: 'failure' };
    await tick(page);
    await expect(panel(page)).toHaveAttribute('data-state', 'ended-before-start');
    await expect(panel(page)).toContainText('The run failed before it started syncing');
    await expect(panel(page)).toContainText('Nothing was sent to any student');
  });

  test('a check that THROWS (a timed-out request) does not end the following', async ({ page }) => {
    const state = await setup(page);
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await openStarterSyncModal(page);
    await page.locator('.modal.card.modal-wide button', { hasText: /Apply Starter Update/i }).click();
    await expect(panel(page)).toHaveAttribute('data-state', 'waiting');
    // The next run read hangs: the client's own timeout rejects it.
    await page.route(new RegExp(`/actions/runs/${RUN}$`), () => { /* never answered */ });
    await tick(page);
    await page.clock.runFor(15_000);
    await expect(panel(page)).toHaveAttribute('data-state', 'unknown');
    // The run answers again, and the following picks up where it was.
    await page.unroute(new RegExp(`/actions/runs/${RUN}$`));
    await page.route(new RegExp(`/actions/runs/${RUN}$`), (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ id: RUN, status: 'completed', conclusion: 'success' }) }));
    state.rec = record({ status: 'completed', remaining: 0, results: res(111) });
    await tick(page);
    await expect(panel(page)).toHaveAttribute('data-state', 'completed');
  });

  test('GitHub not saying which run: it says it cannot follow, rather than guessing', async ({ page }) => {
    await setup(page, { dispatchDetails: false });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await openStarterSyncModal(page);
    await page.locator('.modal.card.modal-wide button', { hasText: /Apply Starter Update/i }).click();
    await expect(page.locator('.dispatch-banner.success')).toContainText('cannot be followed here');
    await expect(panel(page)).toHaveCount(0);
  });

  test('a sync already queued for this assignment is named, and can be followed instead', async ({ page }) => {
    const state = await setup(page, {
      runsList: [{ id: RUN, display_title: `Sync Starter Code: ${ID} (${ORG})`, status: 'queued', created_at: '2026-09-25T15:14:00Z', actor: { login: 'wesleyhendrikx' }, html_url: `https://github.com/Hub/pxl-classroom/actions/runs/${RUN}` }],
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await openStarterSyncModal(page);
    const banner = page.locator('[data-banner="active-sync"]');
    await expect(banner).toContainText('A sync of this assignment is already waiting to start');
    await expect(banner).toContainText('by @wesleyhendrikx');
    await banner.getByRole('button', { name: 'Follow it' }).click();
    await expect(panel(page)).toHaveAttribute('data-state', 'waiting');
    expect(state.dispatchBody, 'following dispatched nothing').toBe(null);
  });

  test('Follow on the Starter code line opens the dialog on that run - no scan of every student', async ({ page }) => {
    const state = await setup(page);
    state.run = { status: 'in_progress' };
    state.rec = record({ results: res(12) });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    const line = page.locator('.sync-status');
    await expect(line).toHaveAttribute('data-state', 'running');
    const treesBefore = state.trees;
    await line.getByRole('button', { name: 'Follow' }).click();
    await expect(panel(page)).toHaveAttribute('data-state', 'running');
    await expect(panel(page)).toContainText('12 of 111 students at the last count');
    expect(state.trees, 'following reads the run, not 111 repositories').toBe(treesBefore);
  });
});
