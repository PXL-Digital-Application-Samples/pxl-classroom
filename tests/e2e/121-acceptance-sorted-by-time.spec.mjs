// 121 - the Acceptance column sorts by when each student accepted, newest
// first, and says the time on hover.
//
// 2026-11-24, pxl-grpro-wpl1-2627: "suddenly an extra student in our
// classroom". The request was a sortable column of repository creation times;
// the table has no width for one (DESIGN.md §7), and the column it would sort
// beside already exists. report.mjs writes `accepted_at` from the acceptance
// record, and a student the report does not list yet carries it from that
// record too (lib/unreported-acceptances.mjs), so the newest arrival is on top
// before any rebuild.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'pe-html-css';
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const assignment = () => ({
  schema_version: 1,
  id: ID,
  title: 'PE: HTML & CSS',
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: at(24 * 60),
  deadline_at: new Date(Date.now() + 3600_000).toISOString(),
  timezone: 'Europe/Brussels',
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 80,
});

const row = (login, acceptedAt) => ({
  github_login: login,
  acceptance_state: acceptedAt ? 'provisioned' : 'not-accepted',
  accepted_at: acceptedAt,
  submission_status: 'no-submission',
  ...(acceptedAt ? { repo_name: `${ORG}/${ID}-${login}`, repo_url: `https://github.com/${ORG}/${ID}-${login}` } : {}),
});

// Alphabetical order and acceptance order disagree on purpose.
const report = () => ({
  schema_version: 1,
  assignment_id: ID,
  generated_at: at(10),
  students: [
    row('AlexanderGalbertPXL', at(300)),
    row('ArchmageXtentral', at(20)),
    row('BramPeetersPXL', at(120)),
    row('CelineNotYetPXL', null),
  ],
});

const record = (login, i, acceptedAt) => ({
  schema_version: 1, assignment_id: ID, github_login: login, github_id: 9100 + i,
  accepted_at: acceptedAt, status: 'provisioned', issue_number: 20 + i, decided_by_run_id: String(200 + i),
});
const repoRecord = (login, i) => ({
  schema_version: 1, assignment_id: ID, github_login: login, repo_id: 7100 + i,
  repo_name: `${ORG}/${ID}-${login}`, repo_url: `https://github.com/${ORG}/${ID}-${login}`,
});

async function open(page) {
  // Two minutes ago and not in the report yet: the newest of all.
  const latecomer = at(2);
  const reported = report().students.filter((s) => s.accepted_at);
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment() },
    reports: { [ID]: report() },
    controlAcceptances: { [ID]: [...reported.map((s, i) => record(s.github_login, i, s.accepted_at)), record('ZoeLatecomerPXL', 9, latecomer)] },
    controlRepositories: { [ID]: [...reported.map((s, i) => repoRecord(s.github_login, i)), repoRecord('ZoeLatecomerPXL', 9)] },
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.locator('tr', { hasText: 'ZoeLatecomerPXL' }).first()).toBeVisible({ timeout: 15000 });
}

const logins = (page) => page.locator('.cohort-table tbody tr, table tbody tr').evaluateAll((trs) =>
  trs.map((tr) => tr.querySelector('td')?.textContent?.trim().split(/\s+/)[0]).filter(Boolean));

test.describe('121 - Acceptance sorts by when each student accepted', () => {
  test('the first click puts the newest arrival on top, the second the earliest, and nobody who has not accepted moves up', async ({ page }) => {
    await open(page);
    const heading = page.getByRole('columnheader', { name: /Acceptance/ });
    await expect(heading).toHaveAttribute('title', 'Sort by when each student accepted, newest first');

    await heading.click();
    await expect.poll(() => logins(page)).toEqual(['ZoeLatecomerPXL', 'ArchmageXtentral', 'BramPeetersPXL', 'AlexanderGalbertPXL', 'CelineNotYetPXL']);

    await heading.click();
    await expect.poll(() => logins(page)).toEqual(['AlexanderGalbertPXL', 'BramPeetersPXL', 'ArchmageXtentral', 'ZoeLatecomerPXL', 'CelineNotYetPXL']);
  });

  test('hovering the acceptance says when, in the assignment\'s time zone; a student who has not accepted says nothing', async ({ page }) => {
    await open(page);
    const archmage = page.locator('tr', { hasText: 'ArchmageXtentral' }).first().locator('[data-accepted-at]');
    await expect(archmage).toHaveAttribute('title', /^Accepted \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} (CET|CEST|GMT\+1|GMT\+2)$/);
    const celine = page.locator('tr', { hasText: 'CelineNotYetPXL' }).first().locator('[data-accepted-at]');
    await expect(celine).not.toHaveAttribute('title', /.+/);
  });
});
