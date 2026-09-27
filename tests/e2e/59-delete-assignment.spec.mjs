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

// The report was regenerated after the last commit to its sources, unless a
// test says otherwise (lib/report-freshness.mjs).
const SOURCES_CHANGED_AT = '2026-08-20T20:05:00Z';
const REPORT_GENERATED_AT = '2026-08-20T20:06:30Z';

async function openClosedAssignment(
  page,
  {
    gitCommits, workflowDispatches, treeTruncated = false, brokerStatus = 200, reportStudents = [],
    generatedAt = REPORT_GENERATED_AT, sourcesStatus = 200,
  } = {},
) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment() },
    // The evidence has to exist to be kept: without a report on record the
    // delete correctly copies nothing, which is not what this is testing.
    reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: generatedAt, students: reportStudents } },
    gitCommits,
    workflowDispatches,
  });

  // The newest commit to observations/<id> and lockdowns/<id>, which is what
  // the delete compares the report's generated_at against.
  await page.route(new RegExp(`/repos/${ORG}/pxl-classroom-control/commits\\?path=`), (route) =>
    sourcesStatus !== 200
      ? route.fulfill({ status: sourcesStatus, body: '{"message":"boom"}' })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ sha: 'a'.repeat(40), commit: { committer: { date: SOURCES_CHANGED_AT } } }]),
        }),
  );

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
    // Where the code still is - the one thing retired/ does not hold. Nothing
    // was preserved here, so there is no row to read it off and the name falls
    // back to this assignment's own archive, with the count saying not to
    // expect anything in it.
    expect(manifest.archive_repo).toContain(ID);
    expect(manifest.preserved_submissions).toBe(0);
    expect(manifest.removed_paths).toContain(`assignments/${ID}.yml`);

    // An assignment whose id merely starts the same way is NOT this one.
    expect(manifest.removed_paths).not.toContain(`assignments/${ID}-2.yml`);
    expect(manifest.removed_paths).not.toContain(`acceptances/${ID}-2/bob.json`);
    // Org-wide data is nobody's assignment to delete.
    expect(manifest.removed_paths).not.toContain('students/roster.yml');
    expect(manifest.removed_paths).not.toContain('reports/dashboard.json');
  });

  test('the archive it names is where the submissions actually went', async ({ page }) => {
    // THE WIRING, which no unit test can reach: the panel has to hand the
    // report it already read to the manifest builder. Without that, the builder
    // composes today's archive name - and a cohort preserved before
    // per-assignment archives is in the org's single legacy repository, so the
    // one document written to be read years later would name a repository that
    // never held a line of their work.
    const legacy = `${ORG}/pxl-classroom-archive`;
    const commits = await del(page, {
      reportStudents: [
        { github_login: 'alice', preservation_status: 'preserved', archive_repo: legacy },
        { github_login: 'bram', preservation_status: 'preserved', archive_repo: legacy },
        { github_login: 'cara', preservation_status: 'not-required' },
      ],
    });
    await expect.poll(() => commits.length, { timeout: 10000 }).toBe(1);

    const manifest = JSON.parse(
      commits[0].files.find((w) => w.path === `retired/${ID}/manifest.json`).content,
    );
    expect(manifest.archive_repo, 'read off the preserved rows, not composed').toBe(legacy);
    expect(manifest.archive_repo).not.toContain(ID);
    expect(manifest.preserved_submissions, 'only the rows actually preserved').toBe(2);
  });

  test('a report older than the lock and preservation deletes nothing, and starts the rebuild', async ({ page }) => {
    // Measured 2026-09-27: a delete a minute after a finalize, before the
    // regeneration landed, kept the pre-deadline report as evidence and wrote
    // `preserved_submissions: 0` over an archive holding both students' work -
    // in a commit that also removed the preservation records it was wrong about.
    const workflowDispatches = [];
    const commits = await del(page, { workflowDispatches, generatedAt: '2026-08-20T19:30:00Z' });
    await expect(page.locator('.toast').first()).toContainText('try again in a minute or two', { timeout: 10000 });
    await expect.poll(() => workflowDispatches.map((d) => d.workflow)).toContain('regenerate-dashboard.yml');
    expect(commits).toHaveLength(0);
  });

  test('a delete that cannot tell whether the report is current deletes nothing', async ({ page }) => {
    const commits = await del(page, { sourcesStatus: 500 });
    await expect(page.locator('.toast').first()).toContainText('Could not check whether the report is up to date', { timeout: 10000 });
    expect(commits).toHaveLength(0);
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
