// 120 - a student who has accepted is on the page before the report knows them.
//
// 2026-11-20, PXL-2TIN-DevOps-2627/pe-actions-reeks-2: fifty students accepted
// in three minutes. Every acceptance dispatched a rebuild of reports/<id>.json
// and each cancelled the one before it, so the page showed one student - the
// lecturer - for eight minutes, and Refresh re-checked that one student only.
// The acceptance and repository records are saved by the acceptance itself,
// and the page now reads them (lib/unreported-acceptances.mjs).
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'pe-actions-reeks-2';

const assignment = () => ({
  schema_version: 1,
  id: ID,
  title: 'PE actions - Reeks 2',
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 80,
});

// What the report held at 16:05: the lecturer's own acceptance, and nobody else.
const report = () => ({
  schema_version: 1,
  assignment_id: ID,
  generated_at: new Date(Date.now() - 120_000).toISOString(),
  students: [{
    github_login: 'd-ries',
    acceptance_state: 'provisioned',
    submission_status: 'no-submission',
    repo_name: `${ORG}/${ID}-d-ries`,
    repo_url: `https://github.com/${ORG}/${ID}-d-ries`,
  }],
});

const accepted = (login, i) => ({
  schema_version: 1, assignment_id: ID, github_login: login, github_id: 9000 + i,
  accepted_at: new Date(Date.now() - 60_000).toISOString(), status: 'provisioned', issue_number: 10 + i, decided_by_run_id: String(100 + i),
});
const repoRecord = (login, i) => ({
  schema_version: 1, assignment_id: ID, github_login: login, repo_id: 7000 + i,
  repo_name: `${ORG}/${ID}-${login}`, repo_url: `https://github.com/${ORG}/${ID}-${login}`,
});

const STUDENTS = ['FarukKazankayaPXL', 'nielsvds1', 'LarsHendrickxPXL'];

async function openDetail(page, { gitCommits = [] } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment() },
    reports: { [ID]: report() },
    controlAcceptances: { [ID]: [accepted('d-ries', 0), ...STUDENTS.map((l, i) => accepted(l, i + 1))] },
    controlRepositories: { [ID]: [repoRecord('d-ries', 0), ...STUDENTS.map((l, i) => repoRecord(l, i + 1))] },
    gitCommits,
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.locator('.cohort-table, table').first()).toBeVisible({ timeout: 15000 });
}

test.describe('120 - accepted students are listed before the report is rebuilt', () => {
  test('every accepted student is a row at once, read as not read yet rather than no submission', async ({ page }) => {
    await openDetail(page);
    for (const login of ['d-ries', ...STUDENTS]) {
      await expect(page.locator('tr', { hasText: login }).first(), login).toBeVisible();
    }
    const faruk = page.locator('tr', { hasText: 'FarukKazankayaPXL' }).first();
    await expect(faruk).toContainText('Not read yet');
    await expect(faruk).not.toContainText('No submission');
  });

  test('Refresh looks at them too, and saves them in the report', async ({ page }) => {
    const gitCommits = [];
    await openDetail(page, { gitCommits });
    await page.getByRole('button', { name: /^Refresh$/i }).first().click();
    const reportWrites = () => gitCommits
      .filter((c) => c.message === `Live refresh: ${ID}`)
      .flatMap((c) => c.files)
      .filter((f) => f.path === `reports/${ID}.json`)
    await expect.poll(() => reportWrites().length, { timeout: 20000 }).toBe(1);
    const written = JSON.parse(reportWrites()[0].content);
    expect(written.students.map((s) => s.github_login).sort()).toEqual(['d-ries', ...STUDENTS].sort());
  });
});
