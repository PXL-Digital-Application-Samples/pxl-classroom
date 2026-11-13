// 107 - "Repositories nobody recorded": what to do about each one, from the
// notice itself.
//
// 2026-10-08, a lecturer reading it about their own leftover test: "Now what
// should I do? This is a bit unclear." It said to press Retry on the
// assignment page, where such a student has no row; it linked nowhere; it could
// not tell a test from a student; and nothing marked it handled, while the
// nightly rewrote it every night. Each line now carries its links, the advice
// that fits it, and a Retry where one can work; any notice can be marked dealt
// with (a 👍 on its comment).

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, answerConfirm } from '../fixtures/e2e-fixtures.mjs';
import { DEDUP_MARKER } from '../../lib/org-notices.mjs';

const ISSUE = { number: 7, state: 'open', html_url: `https://github.com/${ORG}/pxl-classroom-control/issues/7`, labels: [{ name: 'pxl-tracking' }] };
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const COMMENT_ID = 4242;

/** The nightly's notice, as find-unrecorded-repos.mjs and notify.mjs write it. */
const unrecorded = (reactions = 0) => ({
  id: COMMENT_ID,
  body: `${DEDUP_MARKER}unrecorded-abc-->\n### [ERROR] provisioning-failed\n\n**Assignment:** unrecorded-repositories\n**Time:** ${hoursAgo(6)}\n\n` +
    'A student repository exists that PXL Classroom has no record of. The student can work in it, but is missing from the student list.\n\n' +
    '- `lab-3-bob` - student `bob` (assignment `lab-3`)\n' +
    `- \`lab-3-${LECTURER.login}\` - student \`${LECTURER.login}\` (assignment \`lab-3\`)\n` +
    '- `old-x-ann` - student `ann` (assignment `old-x`)\n\n' +
    'On the **Organization** page of PXL Classroom, **Retry** beside each one adds the student.\n',
  html_url: `${ISSUE.html_url}#unrecorded`,
  updated_at: hoursAgo(6),
  reactions: { '+1': reactions },
});

const lab = (deadline) => ({
  id: 'lab-3', title: 'Lab 3', organization: ORG, state: 'published', assignment_type: 'individual', roster_mode: 'open',
  template: { owner: ORG, repository: 'starter' }, repository_name_pattern: 'lab-3-{github_login}', deadline_at: deadline,
});

async function open(page, { deadline = new Date(Date.now() + 7 * 86400_000).toISOString(), reactions = 0 } = {}) {
  const dispatches = [];
  const reactionCalls = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { 'lab-3': lab(deadline) },
    reports: {
      dashboard: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        assignments: { 'lab-3': { title: 'Lab 3', state: 'published', deadline_at: deadline, total_students: 3, accepted: 2, on_time: 0, late: 0, no_submission: 2 } },
      },
    },
    trackingIssue: ISSUE,
    trackingComments: [unrecorded(reactions)],
    workflowDispatches: dispatches,
  });
  await page.route(`**/issues/comments/${COMMENT_ID}/reactions**`, async (route) => {
    const req = route.request();
    reactionCalls.push(`${req.method()} ${new URL(req.url()).pathname}`);
    if (req.method() === 'POST') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 9, content: '+1', user: { login: LECTURER.login } }) });
    if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 9, content: '+1', user: { login: LECTURER.login } }]) });
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto(`/dashboard/${ORG}/organization`);
  await expect(page.locator('[data-unrecorded-lines], [data-dealt-list]').first()).toBeVisible({ timeout: 15000 });
  return { dispatches, reactionCalls };
}

const line = (page, repo) => page.locator('[data-unrecorded-lines] > li', { hasText: repo });

test.describe('107 - repositories nobody recorded', () => {
  test('each line: its links, the advice that fits it, and a Retry only where one can work', async ({ page }) => {
    await open(page);
    const bob = line(page, 'lab-3-bob');
    await expect(bob).toHaveAttribute('data-advice', 'open');
    await expect(bob.getByRole('link', { name: 'lab-3-bob' })).toHaveAttribute('href', `https://github.com/${ORG}/lab-3-bob`);
    await expect(bob.getByRole('link', { name: 'Lab 3' })).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}/lab-3$`));
    await expect(bob.getByRole('button', { name: 'Retry @bob' })).toBeVisible();
    // The lecturer's own test: said so, and nothing to retry.
    const own = line(page, `lab-3-${LECTURER.login}`);
    await expect(own).toHaveAttribute('data-advice', 'own');
    await expect(own).toContainText('Your own test acceptance');
    await expect(own.getByRole('button')).toHaveCount(0);
    // An assignment that no longer exists: nothing to add them to.
    const gone = line(page, 'old-x-ann');
    await expect(gone).toHaveAttribute('data-advice', 'gone');
    await expect(gone.getByRole('button')).toHaveCount(0);
  });

  test('Retry in the notice starts the acceptance again for that student', async ({ page }) => {
    const { dispatches } = await open(page);
    await line(page, 'lab-3-bob').getByRole('button', { name: 'Retry @bob' }).click();
    await expect.poll(() => dispatches.filter((d) => d.workflow === 'retry-acceptance.yml').length, { timeout: 10000 }).toBe(1);
    expect(dispatches.find((d) => d.workflow === 'retry-acceptance.yml').inputs).toMatchObject({ org: ORG, assignment_id: 'lab-3', github_login: 'bob', bypass_window: 'true' });
    await expect(line(page, 'lab-3-bob')).toContainText('Retry started');
  });

  // The hub's ANSWER, read from the run (lib/retry-outcome.mjs). 2026-11-13:
  // this line said "is on the assignment's list in a minute or two" at the
  // click, over a retry the hub refused two seconds later with a green run.
  const RUN = 900;
  async function answer(page, { message, statuses = ['completed'] }) {
    const left = [...statuses];
    const calls = { run: 0 };
    await page.route(/\/actions\/workflows\/retry-acceptance\.yml\/dispatches$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ workflow_run_id: RUN, html_url: `https://github.com/Hub/pxl-classroom/actions/runs/${RUN}` }) }));
    await page.route(new RegExp(`/actions/runs/${RUN}$`), (route) => {
      calls.run++;
      const status = left.length > 1 ? left.shift() : left[0];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: RUN, status, conclusion: status === 'completed' ? 'success' : null }) });
    });
    await page.route(new RegExp(`/actions/runs/${RUN}/jobs`), (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: 77, name: 'retry' }] }) }));
    await page.route(/\/check-runs\/77\/annotations/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(message === null ? [] : [{ annotation_level: 'notice', title: 'pxl-retry-outcome', message }]) }));
    return calls;
  }
  const outcome = (page) => line(page, 'lab-3-bob').locator('[data-retry-outcome]');

  test('a retry the hub REFUSED says so, why and what to do - on a green run - and can be pressed again', async ({ page }) => {
    await open(page);
    await answer(page, { message: 'accept=rejected:no-claim record=skipped' });
    await line(page, 'lab-3-bob').getByRole('button', { name: 'Retry @bob' }).click();
    await expect(outcome(page)).toHaveAttribute('data-state', 'refused');
    await expect(outcome(page)).toContainText('Not added: no confirmed email address.');
    await expect(outcome(page)).toContainText('Ask them to open the invitation link and accept again with their address; they keep their repository');
    await expect(outcome(page)).not.toContainText("is on the assignment's list");
    await expect(outcome(page).getByRole('link', { name: 'View run' })).toHaveAttribute('href', `https://github.com/Hub/pxl-classroom/actions/runs/${RUN}`);
    await expect(line(page, 'lab-3-bob').getByRole('button', { name: 'Retry @bob' })).toBeVisible();
  });

  test('while the hub has not answered it says waiting, the notice cannot be marked dealt with, and then it says added', async ({ page }) => {
    await open(page);
    const calls = await answer(page, { message: 'accept=accepted provision=provisioned:invited record=success', statuses: ['in_progress', 'completed'] });
    await line(page, 'lab-3-bob').getByRole('button', { name: 'Retry @bob' }).click();
    await expect(outcome(page)).toHaveAttribute('data-state', 'waiting');
    await expect(outcome(page)).toContainText('Waiting for the answer');
    await expect(page.locator('[data-dealt-with]')).toHaveCount(0);
    // The next check, five seconds on.
    await expect(outcome(page)).toHaveAttribute('data-state', 'added', { timeout: 15000 });
    await expect(outcome(page)).toContainText("@bob is on the assignment's list.");
    await expect(line(page, 'lab-3-bob').getByRole('button', { name: 'Retry @bob' })).toHaveCount(0);
    await expect(page.locator('[data-dealt-with]')).toBeVisible();
    // And it stops asking once it knows.
    const settled = calls.run;
    await page.waitForTimeout(6000);
    expect(calls.run).toBe(settled);
  });

  test('a refusal is still on the page after a reload, and in a colleague\'s tab: it is read from the run, not remembered', async ({ page }) => {
    // DESIGN.md §1.5. The retry was pressed somewhere else, earlier: this page
    // finds the last Retry of @bob for lab-3 in the hub's runs and shows what
    // the hub answered, with when - and offers Retry, pressing nothing itself.
    // Routes after the fixture's own (the last one registered answers), then
    // the page is loaded again: that load is the one under test.
    const { dispatches } = await open(page);
    await answer(page, { message: 'accept=rejected:no-claim record=skipped' });
    await page.route(/\/actions\/workflows\/retry-acceptance\.yml\/runs/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ workflow_runs: [
        { id: 12, display_title: `Retry Acceptance: someone-else / lab-3 (${ORG})`, created_at: new Date(Date.now() - 60_000).toISOString(), html_url: 'https://github.com/Hub/pxl-classroom/actions/runs/12' },
        { id: RUN, display_title: `Retry Acceptance: bob / lab-3 (${ORG})`, created_at: new Date(Date.now() - 2 * 3600_000).toISOString(), html_url: `https://github.com/Hub/pxl-classroom/actions/runs/${RUN}` },
      ] }) }));
    await page.reload();
    await expect(outcome(page)).toHaveAttribute('data-state', 'refused', { timeout: 15000 });
    await expect(outcome(page)).toContainText('Last retry, 2h ago: Not added: no confirmed email address.');
    await expect(outcome(page).locator('.status-dot')).toHaveClass(/dot-danger/);
    await expect(line(page, 'lab-3-bob').getByRole('button', { name: 'Retry @bob' })).toBeVisible();
    expect(dispatches.filter((d) => d.workflow === 'retry-acceptance.yml').length, 'opening the page starts nothing').toBe(0);
  });

  test('a run that ended without saying what it decided claims nothing', async ({ page }) => {
    await open(page);
    await answer(page, { message: null });
    await line(page, 'lab-3-bob').getByRole('button', { name: 'Retry @bob' }).click();
    await expect(outcome(page)).toHaveAttribute('data-state', 'unknown');
    await expect(outcome(page)).toContainText('without saying what it decided');
  });

  test('after the deadline it says so, and Retry asks first', async ({ page }) => {
    const { dispatches } = await open(page, { deadline: new Date(Date.now() - 3 * 86400_000).toISOString() });
    const bob = line(page, 'lab-3-bob');
    await expect(bob).toHaveAttribute('data-advice', 'late');
    await expect(bob).toContainText('was not collected at it; their work is in the repository');
    await bob.getByRole('button', { name: 'Retry @bob' }).click();
    await expect(page.locator('.confirm-dialog')).toContainText("Retry @bob's acceptance after the deadline?");
    await answerConfirm(page);
    await expect.poll(() => dispatches.filter((d) => d.workflow === 'retry-acceptance.yml').length, { timeout: 10000 }).toBe(1);
  });

  test('Dealt with: a 👍 on the notice, it leaves the list, and it can be taken back', async ({ page }) => {
    const { reactionCalls } = await open(page);
    await page.locator('[data-dealt-with]').click();
    await expect.poll(() => reactionCalls.filter((c) => c.startsWith('POST')).length, { timeout: 10000 }).toBe(1);
    await expect(page.locator('[data-unrecorded-lines]')).toHaveCount(0);
    await expect(page.locator('.org-needs-title')).toContainText('All quiet');
    const dealt = page.locator('[data-dealt-list]');
    await expect(dealt).toContainText('1 notice marked dealt with');
    await dealt.locator('summary').click();
    await dealt.locator('[data-not-dealt-with]').click();
    await expect.poll(() => reactionCalls.filter((c) => c.startsWith('DELETE')).length, { timeout: 10000 }).toBe(1);
    await expect(page.locator('[data-unrecorded-lines]')).toBeVisible();
  });

  test('a notice already marked dealt with is not on the list, and not in the count', async ({ page }) => {
    await open(page, { reactions: 1 });
    await expect(page.locator('.org-needs-title')).toContainText('All quiet');
    await expect(page.locator('[data-dealt-list]')).toContainText('1 notice marked dealt with');
  });
});
