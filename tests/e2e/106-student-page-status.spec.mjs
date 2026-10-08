// 106 - Do students see what is saved? Said from the facts, on every tab, and
// the same after a refresh.
//
// 2026-10-08: a lecturer changed a published assignment's deadline and pressed
// Save. A toast said "about two minutes" and vanished; after that nothing said
// whether students had the new deadline, and a refresh would not have either.
// The page now compares the card the SAVED document makes (lib/student-card.mjs,
// the generator's own function) with the card students are served.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
import { studentCard } from '../../lib/student-card.mjs';

const ID = 'pe1-106';
const KEY = 'link-key-106';
const SAVED_DEADLINE = '2026-10-14T20:30:00.000Z';
const OLD_DEADLINE = '2026-10-12T20:30:00.000Z';
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

const doc = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'PE1 groepsindeling',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'starter-template' },
  opens_at: '2026-10-08T07:25:00.000Z',
  deadline_at: SAVED_DEADLINE,
  invite_key: KEY,
  ...over,
});

/**
 * @param {object} o
 * @param {object|null} [o.served]  the card students are served; default: what the saved document makes
 * @param {number} [o.savedMinutesAgo]
 * @param {object[]} [o.deploys]
 */
async function open(page, { served = null, savedMinutesAgo = 2, deploys = [], path = '' } = {}) {
  const dispatches = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [ID]: doc() }, workflowDispatches: dispatches });
  if (served) {
    await page.route(`**/data/${ORG}/i/*.json*`, (route) =>
      route.request().url().includes('.teams.json') ? route.fallback()
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema_version: 1, assignment: served }) }));
  }
  await page.route(new RegExp(`/repos/${ORG}/pxl-classroom-control/commits\\?path=`), (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ sha: 'a'.repeat(40), commit: { committer: { date: minutesAgo(savedMinutesAgo) } } }]) }));
  await page.route('**/actions/workflows/deploy-frontend.yml/runs*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total_count: deploys.length, workflow_runs: deploys }) }));
  await page.goto(`/dashboard/${ORG}/${ID}${path}`);
  return { dispatches };
}

const oldCard = () => studentCard(doc({ deadline_at: OLD_DEADLINE }), { timezone: 'Europe/Brussels' });
const header = (page) => page.locator('.student-page-line');

test.describe('106 - do students see what is saved', () => {
  test('they do: Settings says so, and no other tab says anything', async ({ page }) => {
    await open(page, { path: '/settings' });
    const status = page.locator('[data-student-page="current"]');
    await expect(status).toContainText('Students see what is saved.', { timeout: 15000 });
    await page.getByRole('link', { name: 'Progress' }).click();
    await expect(page.locator('.assignment-tabs')).toBeVisible();
    await expect(header(page)).toHaveCount(0);
  });

  test('just saved, the site updating: every tab says so, with how long - after a refresh too', async ({ page }) => {
    await open(page, {
      served: oldCard(),
      savedMinutesAgo: 2,
      deploys: [{ status: 'in_progress', conclusion: null, created_at: minutesAgo(1), updated_at: minutesAgo(1), html_url: 'https://x/9' }],
    });
    await expect(header(page)).toContainText(
      'Students still see the version before your last save: updating the student site (2 min so far; usually 3 to 4 minutes).',
      { timeout: 15000 },
    );
    // A refresh asks the facts again; nothing lived only in the old tab.
    await page.reload();
    await expect(header(page)).toContainText('Students still see the version before your last save', { timeout: 15000 });
  });

  test('on Settings: the steps, what differs, and the short version in the bar', async ({ page }) => {
    await open(page, {
      served: oldCard(),
      savedMinutesAgo: 2,
      deploys: [{ status: 'queued', conclusion: null, created_at: minutesAgo(1), updated_at: minutesAgo(1) }],
      path: '/settings',
    });
    const block = page.locator('[data-student-page="updating"]');
    await expect(block.locator('.publish-steps li')).toHaveCount(3, { timeout: 15000 });
    await expect(block.locator('.publish-steps li').nth(1)).toHaveAttribute('data-step-state', 'active');
    await expect(block.locator('[data-student-page-differences]')).toContainText('deadline: students see 12 Oct 2026');
    await expect(block.locator('[data-student-page-differences]')).toContainText('saved 14 Oct 2026');
    await expect(page.locator('[data-publish-bar]')).toHaveText(/Updating the student page, step 2 of 3 \(2 min so far\)\./);
    // Said once on this tab: the header line is for the other tabs.
    await expect(header(page)).toHaveCount(0);
  });

  test('long after the save and nothing updating: stuck, said, and one press asks again', async ({ page }) => {
    const { dispatches } = await open(page, {
      served: oldCard(),
      savedMinutesAgo: 25,
      deploys: [{ status: 'completed', conclusion: 'success', created_at: minutesAgo(20), updated_at: minutesAgo(18) }],
    });
    await expect(header(page)).toContainText('25 min after it was saved, and nothing is updating it now.', { timeout: 15000 });
    await header(page).getByRole('button', { name: 'Update the student page now' }).click();
    await expect.poll(() => dispatches.filter((d) => d.workflow === 'regenerate-dashboard.yml').length, { timeout: 10000 }).toBe(1);
    // Asked again just now: updating, not stuck.
    await expect(header(page)).toContainText('updating the student site', { timeout: 15000 });
  });
});
