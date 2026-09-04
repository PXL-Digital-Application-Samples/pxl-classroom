// 59 - Deleting an assignment.
//
// GitHub Classroom's delete takes every student repository with it, which is
// the reputation the word carries into this dialog. Classroom50's keeps them
// and removes only the record. So does this - and it also removes the working
// data and the broker, because an assignment that is gone should not leave a
// public repository nothing will ever close.
//
// What survives is evidence: the report, the CSV, the grades and a manifest,
// under retired/<id>/. Nothing iterates that folder.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'retired-lab';

const assignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'Retired Lab',
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: '2026-08-01T08:00:00Z',
  deadline_at: '2026-08-20T20:00:00Z',
  state: 'closed',
  assignment_type: 'individual',
  max_acceptances: 50,
  ...over,
});

/** Every blob the control repo holds, as the recursive tree API returns it. */
const TREE = [
  `assignments/${ID}.yml`,
  `reports/${ID}.json`,
  `reports/${ID}.csv`,
  `acceptances/${ID}/alice.json`,
  `observations/${ID}/alice/2026-08-19T00-00-00Z.json`,
  `repositories/${ID}/alice.json`,
  `lockdowns/${ID}/lockdown-record.json`,
  `grading/${ID}/summary.json`,
  // Must survive: org-wide, and named after no assignment.
  'students/roster.yml',
  'reports/dashboard.json',
  // Must survive: a different assignment whose id merely starts the same way.
  `assignments/${ID}-2.yml`,
  `acceptances/${ID}-2/bob.json`,
];

async function openClosedAssignment(page, { gitCommits, treeTruncated = false, brokerStatus = 200 } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment() },
    // The evidence has to exist to be kept: without a report on record the
    // delete correctly copies nothing, which is not what this is testing.
    reports: { [ID]: { schema_version: 1, assignment_id: ID, students: [] } },
    gitCommits,
  });

  await page.route('**/git/trees/main?recursive=1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        truncated: treeTruncated,
        tree: TREE.map((path) => ({ path, type: 'blob' })),
      }),
    }),
  );
  // The broker: HEAD-ish read then DELETE.
  await page.route(`**/repos/${ORG}/broker-${ID}`, (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: brokerStatus, body: '{}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: `{"name":"broker-${ID}"}` }),
  );

  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(page.getByRole('button', { name: 'Delete assignment', exact: true })).toBeVisible({ timeout: 15000 });
}

const dialog = (page) => page.locator('[aria-label="Delete assignment"]');

test.describe('59 - the dialog says what it costs before it can be used', () => {
  test('it leads with what is NOT deleted, and refuses until the id is typed', async ({ page }) => {
    await openClosedAssignment(page);
    await page.getByRole('button', { name: 'Delete assignment', exact: true }).click();

    // The fear the word creates, answered first.
    await expect(dialog(page)).toContainText('Student repositories are untouched');
    await expect(dialog(page)).toContainText('The archive is kept');
    await expect(dialog(page)).toContainText(`retired/${ID}/`);

    const confirm = dialog(page).getByRole('button', { name: /Delete assignment/ });
    await expect(confirm).toBeDisabled();

    await page.getByLabel(/Type .* to confirm/).fill('not-the-id');
    await expect(confirm).toBeDisabled();

    await page.getByLabel(/Type .* to confirm/).fill(ID);
    await expect(confirm).toBeEnabled();
  });

  test('it is not offered while the assignment is still accepting', async ({ page }) => {
    // Deleting a live assignment would take the broker out from under students
    // who can still be accepting. The lifecycle stops that first.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment({ state: 'published' }) },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Delete assignment', exact: true })).toHaveCount(0);
  });
});

test.describe('59 - what it writes and what it removes', () => {
  /**
   * The delete goes through the Git Data API - one commit for the whole thing -
   * so the fixture records it in `gitCommits`, not in `contentWrites`, which
   * only sees single-file PUTs.
   */
  async function del(page, opts = {}) {
    const gitCommits = [];
    await openClosedAssignment(page, { gitCommits, ...opts });
    await page.getByRole('button', { name: 'Delete assignment', exact: true }).click();
    await page.getByLabel(/Type .* to confirm/).fill(ID);
    await dialog(page).getByRole('button', { name: /Delete assignment/ }).click();
    return gitCommits;
  }

  test('the evidence is written and the working data removed in one commit', async ({ page }) => {
    const commits = await del(page);
    await expect.poll(() => commits.length, { timeout: 10000 }).toBe(1);

    const writes = commits[0].files;
    const paths = writes.map((w) => w.path);
    // Kept, as evidence.
    expect(paths).toContain(`retired/${ID}/manifest.json`);
    expect(paths).toContain(`retired/${ID}/report.json`);

    const manifest = JSON.parse(writes.find((w) => w.path === `retired/${ID}/manifest.json`).content);
    expect(manifest.assignment_id).toBe(ID);
    expect(manifest.deleted_by).toBeTruthy();
    // Where the code still is - the one thing retired/ does not hold.
    expect(manifest.archive_repo).toContain(ID);
    expect(manifest.removed_paths).toContain(`assignments/${ID}.yml`);

    // An assignment whose id merely starts the same way is NOT this one.
    expect(manifest.removed_paths).not.toContain(`assignments/${ID}-2.yml`);
    expect(manifest.removed_paths).not.toContain(`acceptances/${ID}-2/bob.json`);
    // Org-wide data is nobody's assignment to delete.
    expect(manifest.removed_paths).not.toContain('students/roster.yml');
    expect(manifest.removed_paths).not.toContain('reports/dashboard.json');
  });

  test('a truncated tree deletes nothing', async ({ page }) => {
    // A partial listing would leave whatever it did not name behind for ever,
    // unreachable from any surface because the assignment is gone.
    const commits = await del(page, { treeTruncated: true });
    await expect(page.locator('.toast')).toContainText('too large to enumerate', { timeout: 10000 });
    expect(commits).toHaveLength(0);
  });

  test('a broker that will not delete stops the whole thing', async ({ page }) => {
    // Broker first, and on failure nothing else moves: an assignment removed
    // while its broker stands is a public repository nothing will ever close.
    const commits = await del(page, { brokerStatus: 403 });
    await expect(page.locator('.toast')).toContainText('Administration', { timeout: 10000 });
    expect(commits).toHaveLength(0);
  });
});
