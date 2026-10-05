// 92 - The page says which step a request is at, and when to send it again.
//
// 2026-10-02: two students joining PXL-2TIN-DevOps-2627's `fullhouse` watched
// the team card spin, time out after three minutes and say "your team
// repository has not appeared" - four times each - while every one of their
// joins was being cancelled behind one run GitHub never started. The page knew
// nothing but "a repository appeared" or "a label appeared".
//
// It now reads two more public things (frontend/src/lib/acceptance-progress.js):
// the student's own broker issue TITLE, which is how far the broker got, and
// the hub run named after that issue. These pin what each answer shows, that an
// answer that could not be READ changes nothing, and that "send it again" sends
// the same request again.

import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';
import { HANDLED_TITLE_BY_PURPOSE, NOT_DELIVERED_TITLE_BY_PURPOSE, REJECTED_ISSUE_TITLE } from '../../lib/broker-issue-titles.mjs';
import { acceptanceRunName } from '../../lib/acceptance-run-name.mjs';

const T0 = new Date('2026-10-02T10:22:00Z');
const ID = 'hw-progress';
const BROKER = `broker-${ID}`;
const REPO = `${ID}-${STUDENT_1.login}`;
const GROUP_ID = 'grp-progress';
const GROUP_BROKER = `broker-${GROUP_ID}`;

const individual = () => ({
  id: ID,
  title: 'Progress',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
  opens_at: new Date(T0.getTime() - 3600_000).toISOString(),
  deadline_at: new Date(T0.getTime() + 7 * 86400_000).toISOString(),
  repository_name_pattern: `${ID}-{github_login}`,
  broker_repo: BROKER,
});

const group = () => ({
  id: GROUP_ID,
  title: 'Group progress',
  organization: ORG,
  state: 'published',
  assignment_type: 'group',
  roster_mode: 'open',
  max_acceptances: 50,
  opens_at: new Date(T0.getTime() - 3600_000).toISOString(),
  deadline_at: new Date(T0.getTime() + 7 * 86400_000).toISOString(),
  group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
  repository_name_pattern: `${GROUP_ID}-{team_slug}`,
  broker_repo: GROUP_BROKER,
});

/**
 * Accept with the repository invisible and no label, the issue titled `title`
 * (null: the issue read fails), and the hub's run list answering `runs`
 * (null: the run list read fails). Returns a record of what the page sent.
 */
async function setup(page, { title, run = undefined, runs = undefined, groupMode = false }) {
  const sent = { issues: [] };
  await page.clock.install({ time: T0 });
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: groupMode ? { [GROUP_ID]: group() } : { [ID]: individual() },
    ...(groupMode
      ? {
          teams: {
            [GROUP_ID]: [
              { team_slug: 'team-alpha', team_name: 'Team Alpha', members: ['someone'], member_count: 1, max_members: 3, is_full: false },
            ],
          },
        }
      : {}),
  });
  const broker = groupMode ? GROUP_BROKER : BROKER;
  await page.route(`**/api.github.com/repos/${ORG}/${groupMode ? `${GROUP_ID}-team-alpha` : REPO}`, (route) =>
    route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
  await page.route('**/api.github.com/user/repository_invitations*', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([]) }));
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes(`/repos/${ORG}/${broker}/issues`)) {
      try { sent.issues.push(req.postDataJSON()); } catch { sent.issues.push(null); }
    }
  });
  await page.route(`**/api.github.com/repos/${ORG}/${broker}/issues/*`, (route) =>
    title === null
      ? route.fulfill({ status: 500, body: JSON.stringify({ message: 'boom' }) })
      : route.fulfill({ status: 200, body: JSON.stringify({ number: 1, title, state: 'open', locked: true, labels: [] }) }));
  await page.route('**/api.github.com/repos/*/*/actions/workflows/acceptance-handler.yml/runs*', (route) => {
    if (runs === null) return route.fulfill({ status: 500, body: JSON.stringify({ message: 'boom' }) });
    const list = runs ?? (run ? [{ display_title: acceptanceRunName(`${ORG}/${broker}`, 1), created_at: T0.toISOString(), ...run }] : []);
    return route.fulfill({ status: 200, body: JSON.stringify({ total_count: list.length, workflow_runs: list }) });
  });
  return sent;
}

async function accept(page) {
  await page.goto(inviteUrl(ORG, ID));
  await page.getByRole('button', { name: /Accept assignment/i }).click();
  await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });
}

/**
 * Move the page's clock forward in steps, letting each check's requests
 * resolve in between. One jump would fire the next check and leave the one it
 * schedules after its own requests stranded beyond the jump.
 */
async function advance(page, ms) {
  for (let t = 0; t < ms; t += 3_000) {
    await page.clock.runFor(3_000);
    await page.waitForTimeout(40);
  }
}

// Past the second check, which is the first that reads the issue.
const settle = (page) => advance(page, 12_000);

test.describe('92 - Which step the request is at', () => {
  test('not delivered: said at once, and sending it again sends a new request', async ({ page }) => {
    const sent = await setup(page, { title: NOT_DELIVERED_TITLE_BY_PURPOSE.accept });
    await accept(page);
    await settle(page);
    const state = page.locator('.timeout-state', { hasText: /did not go through/i });
    await expect(state).toBeVisible({ timeout: 15000 });
    await expect(state).toContainText(/problem passing your request on/i);
    await expect(page.locator('.attempt-step-failed')).toContainText('Invitation checked');
    expect(sent.issues).toHaveLength(1);
    await state.getByRole('button', { name: /Send it again/i }).click();
    await expect.poll(() => sent.issues.length, { timeout: 10000 }).toBe(2);
  });

  test('waiting in GitHub\'s queue: no timeout, and the offer comes at three minutes', async ({ page }) => {
    await setup(page, { title: HANDLED_TITLE_BY_PURPOSE.accept, run: { status: 'queued' } });
    await accept(page);
    await settle(page);
    const pending = page.locator('.pending-state');
    await expect(pending).toContainText(/waiting for GitHub to start it/i, { timeout: 15000 });
    await expect(pending.getByRole('button', { name: /Send it again/i })).toHaveCount(0);

    await advance(page, 3 * 60_000);
    await expect(pending.getByRole('button', { name: /Send it again/i })).toBeVisible({ timeout: 15000 });

    // Well past the old three-minute cap: still waiting, never "has not appeared".
    await advance(page, 6 * 60_000);
    await expect(pending).toBeVisible();
    await expect(page.locator('.timeout-state')).toHaveCount(0);
  });

  test('a run GitHub stopped: did not go through', async ({ page }) => {
    await setup(page, { title: HANDLED_TITLE_BY_PURPOSE.accept, run: { status: 'completed', conclusion: 'cancelled' } });
    await accept(page);
    await settle(page);
    await expect(page.locator('.timeout-state')).toContainText(/stopped your request before it finished/i, { timeout: 15000 });
    await expect(page.getByRole('button', { name: /Send it again/i })).toBeVisible();
  });

  test('a run that finished with nothing set up, after a grace for the answer to arrive', async ({ page }) => {
    await setup(page, {
      title: HANDLED_TITLE_BY_PURPOSE.accept,
      run: { status: 'completed', conclusion: 'success', updated_at: T0.toISOString() },
    });
    await accept(page);
    await settle(page);
    // Within the grace: still setting up.
    await expect(page.locator('.pending-state')).toContainText(/working on it/i, { timeout: 15000 });
    await advance(page, 2 * 60_000);
    await expect(page.locator('.timeout-state')).toContainText(/finished without setting anything up/i, { timeout: 15000 });
  });

  test('a link the broker would not take: no "send it again", because the same link will not work', async ({ page }) => {
    await setup(page, { title: REJECTED_ISSUE_TITLE, run: null });
    await accept(page);
    await settle(page);
    const state = page.locator('.timeout-state');
    await expect(state).toContainText(/Ask your lecturer for the current link/i, { timeout: 15000 });
    await expect(state.getByRole('button', { name: /Send it again/i })).toHaveCount(0);
  });

  test('UNREADABLE IS NOT EVIDENCE: nothing read, nothing concluded - the page behaves as it always did', async ({ page }) => {
    await setup(page, { title: null, runs: null });
    await accept(page);
    await settle(page);
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.attempt-progress')).toHaveCount(0);
    await expect(page.locator('.timeout-state', { hasText: /did not go through/i })).toHaveCount(0);
    // And it still ends where it used to: the ordinary timeout.
    await advance(page, 5 * 60_000);
    await expect(page.locator('.timeout-state')).toContainText(/has not appeared/i, { timeout: 15000 });
  });

  test('a team join GitHub stopped: the card says so, and sending it again joins the SAME team', async ({ page }) => {
    const sent = await setup(page, {
      title: HANDLED_TITLE_BY_PURPOSE.accept,
      run: { status: 'completed', conclusion: 'cancelled' },
      groupMode: true,
    });
    await page.goto(inviteUrl(ORG, GROUP_ID));
    const card = page.locator('.team-item-card', { hasText: 'Team Alpha' });
    await card.getByRole('button', { name: /Join Team/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });
    await settle(page);
    const state = page.locator('.timeout-state', { hasText: /did not go through/i });
    await expect(state).toContainText(/Joining Team Alpha did not go through/i, { timeout: 15000 });
    await state.getByRole('button', { name: /Send it again/i }).click();
    await expect.poll(() => sent.issues.length, { timeout: 10000 }).toBe(2);
    const body = JSON.parse(sent.issues[1].body);
    expect(body.team_slug).toBe('team-alpha');
    expect(sent.issues[1].title).toMatch(/ team:team-alpha$/);
  });
});
