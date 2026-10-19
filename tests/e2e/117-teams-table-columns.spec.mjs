// 117 - The Teams table sorts on every column, and draws its cells the way the
// Progress table does (asked 2026-10-20).
//
// It sorted on nothing, spelled the repository out as text, had no Last commit
// and a Preserved column of its own. It uses the same parts as the Progress
// table now: SortableTh, RepoIconLink, LastCommitCell and ArchiveLink.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'teams-table-columns';

const assignment = {
  schema_version: 1, id: ID, title: 'Teams Columns Lab', organization: ORG, assignment_type: 'group', roster_mode: 'enforced',
  state: 'published', template: { owner: ORG, repository: 'group-template' }, repository_name_pattern: `grp-{team_slug}`,
  opens_at: '2026-08-01T08:00:00.000Z', deadline_at: '2026-12-31T22:00:00.000Z',
  group_config: { max_team_size: 3, min_team_size: 2, formation_mode: 'pre-assigned' },
};
const manifest = (slug, name, members) => ({
  schema_version: 1, assignment_id: ID, team_slug: slug, team_name: name, members, max_members: 3,
  repo_name: `${ORG}/grp-${slug}`, repo_url: `https://github.com/${ORG}/grp-${slug}`,
  created_at: '2026-08-01T09:00:00.000Z', created_by: 'lecturer',
});
// Three teams whose columns all disagree on the order, so every sort is seen.
const MANIFESTS = [
  manifest('bravo', 'Bravo', ['zed', 'amy', 'cal']),
  manifest('alpha', 'Alpha', ['max']),
  manifest('charlie', 'Charlie', ['bea', 'dov']),
];
const reportTeam = (slug, extra) => ({ team_slug: slug, team_name: slug, members: [], repo_name: `${ORG}/grp-${slug}`, repo_url: `https://github.com/${ORG}/grp-${slug}`, ...extra });
const REPORT = {
  schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(),
  teams: [
    reportTeam('bravo', { submission_status: 'on-time', commit_count: 2, latest_observed_sha: 'bbbbbbb1111' }),
    reportTeam('alpha', { submission_status: 'late', commit_count: 30, latest_observed_sha: 'aaaaaaa1111', preservation_status: 'preserved', preserved_sha: 'aaaaaaa1111' }),
    reportTeam('charlie', { submission_status: 'no-submission', commit_count: 9, latest_observed_sha: 'ccccccc1111' }),
  ],
  students: [
    { github_login: 'zed', acceptance_state: 'provisioned', repo_name: `${ORG}/grp-bravo`, repo_url: `https://github.com/${ORG}/grp-bravo`, latest_observed_sha: 'bbbbbbb1111', commit_date: '2026-10-01T10:00:00Z', commit_message: 'Bravo work' },
    { github_login: 'max', acceptance_state: 'provisioned', repo_name: `${ORG}/grp-alpha`, repo_url: `https://github.com/${ORG}/grp-alpha`, latest_observed_sha: 'aaaaaaa1111', commit_date: '2026-10-15T10:00:00Z', commit_message: 'Alpha work' },
    { github_login: 'bea', acceptance_state: 'provisioned', repo_name: `${ORG}/grp-charlie`, repo_url: `https://github.com/${ORG}/grp-charlie`, latest_observed_sha: 'ccccccc1111', commit_date: '2026-10-08T10:00:00Z', commit_message: 'Charlie work' },
  ],
};

async function open(page) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment },
    reports: { [ID]: REPORT },
    controlTeams: { [ID]: MANIFESTS },
  });
  await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
  await expect(page.locator('.teams-table-component tbody tr')).toHaveCount(3, { timeout: 15000 });
}

const names = (page) => page.locator('.teams-table-component tbody tr .team-title').allTextContents();
const heading = (page, name) => page.locator('.teams-table-component thead th', { hasText: name }).first();

test.describe('117 - the Teams table', () => {
  test('sorts on every column, both ways, from the mouse and the keyboard', async ({ page }) => {
    await open(page);
    // By team name to start with, and the heading says so.
    expect(await names(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await expect(heading(page, 'Team')).toHaveAttribute('aria-sort', 'ascending');

    await heading(page, 'Team').click();
    expect(await names(page)).toEqual(['Charlie', 'Bravo', 'Alpha']);
    await expect(heading(page, 'Team')).toHaveAttribute('aria-sort', 'descending');

    const cases = [
      // [heading, ascending order]
      // The first member each cell shows: @bea (Charlie), @max (Alpha), @zed (Bravo).
      ['Members', ['Charlie', 'Alpha', 'Bravo']],
      ['Capacity', ['Alpha', 'Charlie', 'Bravo']],
      ['Repo', ['Alpha', 'Bravo', 'Charlie']],
      ['Last commit', ['Bravo', 'Charlie', 'Alpha']],
      // 2, 9, 30: as numbers, not as text.
      ['Commits', ['Bravo', 'Charlie', 'Alpha']],
      // Late, No submission, On time.
      ['Status', ['Alpha', 'Charlie', 'Bravo']],
    ];
    for (const [h, asc] of cases) {
      await heading(page, h).click();
      await expect(heading(page, h)).toHaveAttribute('aria-sort', 'ascending');
      expect(await names(page), `${h} ascending`).toEqual(asc);
      await heading(page, h).press('Enter');
      await expect(heading(page, h)).toHaveAttribute('aria-sort', 'descending');
      expect(await names(page), `${h} descending`).toEqual([...asc].reverse());
    }

    // Space sorts too, and only one heading claims the order.
    await heading(page, 'Team').press('Space');
    await expect(heading(page, 'Team')).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('.teams-table-component thead th[aria-sort="none"]')).toHaveCount(6);
  });

  test('the repository is an icon, Last commit is shown, and preservation is under the status', async ({ page }) => {
    await open(page);
    await expect(page.locator('.teams-table-component thead th', { hasText: /^Preserved$/ })).toHaveCount(0);
    await expect(page.locator('.teams-table-component thead th', { hasText: /^Repository$/ })).toHaveCount(0);

    const alpha = page.locator('.teams-table-component tbody tr', { hasText: 'Alpha' });
    const repo = alpha.locator('a.repo-icon-link');
    await expect(repo).toHaveAttribute('href', `https://github.com/${ORG}/grp-alpha`);
    await expect(repo).toHaveAttribute('aria-label', 'Repository grp-alpha');
    await expect(repo).toHaveText('');

    // The commit of the member row on the team's repository: its SHA links to it.
    const sha = alpha.locator('a.sha');
    await expect(sha).toHaveText('aaaaaaa');
    await expect(sha).toHaveAttribute('href', `https://github.com/${ORG}/grp-alpha/commit/aaaaaaa1111`);
    await expect(sha).toHaveAttribute('title', 'Alpha work');
    await expect(alpha.locator('.commit-time-top')).toBeVisible();

    await expect(alpha.locator('a.archive-link')).toContainText('archive (aaaaaaa)');
    await expect(page.locator('.teams-table-component tbody tr', { hasText: 'Bravo' }).locator('a.archive-link')).toHaveCount(0);
  });
});
