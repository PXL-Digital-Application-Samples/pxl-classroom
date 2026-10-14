// 108 - A team is renamed on the Teams tab, while nobody in it has accepted.
//
// Asked 2026-10-12: teams copied from another assignment carried one wrong
// name, and the only fix was create, move every member, delete. Before anyone
// accepts nothing hangs on the name, so the name and the slug (and with it the
// repository the team will get) change in one commit. After that it says why
// not. lib/team-rename.mjs decides; tests/team-rename.test.mjs covers the rules.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'teams-rename';

const assignment = () => ({
  schema_version: 1,
  id: ID,
  title: 'Rename Lab',
  organization: ORG,
  assignment_type: 'group',
  roster_mode: 'enforced',
  state: 'published',
  template: { owner: ORG, repository: 'group-template' },
  repository_name_pattern: `${ID}-{team_slug}`,
  opens_at: '2026-08-01T08:00:00.000Z',
  deadline_at: '2026-12-31T22:00:00.000Z',
  group_config: { max_team_size: 3, min_team_size: 1, formation_mode: 'pre-assigned' },
});

const team = (slug, name, members) => ({
  schema_version: 1,
  assignment_id: ID,
  team_slug: slug,
  team_name: name,
  members,
  max_members: 3,
  created_at: '2026-08-01T09:00:00.000Z',
  created_by: 'lecturer',
});

const roster = ['stud1', 'stud2', 'stud3'].map((login, i) => ({
  student_number: String(100 + i), full_name: `Student ${i + 1}`, github_login: login,
}));

// A report row per roster student, none accepted - so the page itself knows
// nobody has (an empty report is not evidence, and blocks the rename).
const students = (accepted = []) => roster.map((s) => ({
  github_login: s.github_login,
  acceptance_state: accepted.includes(s.github_login) ? 'provisioned' : 'not-accepted',
  submission_status: 'no-submission',
}));

async function open(page, { accepted = [], extra = {} } = {}) {
  const gitCommits = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment() },
    reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: students(accepted) } },
    controlTeams: { [ID]: [team('krusty-krab', 'Krusty Krab', ['stud1', 'stud2']), team('pod-pirates', 'Pod Pirates', ['stud3'])] },
    roster,
    gitCommits,
    ...extra,
  });
  await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
  return gitCommits;
}

async function manage(page, name) {
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'Manage' }).click();
  const modal = page.locator('.modal.card', { hasText: `Manage ${name}` });
  await expect(modal).toBeVisible();
  return modal;
}

const writesTo = (commits) => commits.flatMap((c) => c.files.map((f) => [f.path, f.content === null ? null : JSON.parse(f.content)]));

test.describe('108 - Rename a team before anyone in it accepts', () => {
  test('renames name and slug in one commit: the new file written, the old one removed', async ({ page }) => {
    const commits = await open(page);
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    const box = modal.locator('#team-rename-input');
    await expect(box).toBeFocused();
    await box.fill('Krusty Krabs');
    await expect(modal.locator('[data-team-rename]')).toContainText(`${ID}-krusty-krabs`);
    await modal.locator('[data-team-rename]').getByRole('button', { name: 'Rename', exact: true }).click();

    await expect.poll(() => commits.length, { timeout: 15000 }).toBe(1);
    const files = writesTo(commits);
    expect(files.map(([p, d]) => [p, d === null ? null : 'doc'])).toEqual([
      [`teams/${ID}/krusty-krabs.json`, 'doc'],
      [`teams/${ID}/krusty-krab.json`, null],
    ]);
    const doc = files[0][1];
    expect(doc.team_name).toBe('Krusty Krabs');
    expect(doc.team_slug).toBe('krusty-krabs');
    expect(doc.members).toEqual(['stud1', 'stud2']);
    await expect(page.locator('.toast', { hasText: 'Renamed to "Krusty Krabs"' })).toBeVisible();
  });

  test('a name another team has is refused, and nothing is written', async ({ page }) => {
    const commits = await open(page);
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Pod-Pirates');
    await modal.locator('#team-rename-input').press('Enter');
    await expect(modal.locator('[data-team-rename] [role="alert"]')).toContainText('another team in this assignment is already called that');
    expect(commits).toEqual([]);
  });

  test('once a member has accepted it is not offered, and says why', async ({ page }) => {
    await open(page, { accepted: ['stud2'] });
    const modal = await manage(page, 'Krusty Krab');
    await expect(modal.getByRole('button', { name: 'Rename team' })).toHaveCount(0);
    await expect(modal.locator('[data-team-rename]')).toContainText('Cannot be renamed: @stud2 has accepted');
  });

  test('a member who accepted after the page loaded stops it at the click', async ({ page }) => {
    // The page read the report before stud1 accepted; their record is there now.
    const commits = await open(page, {
      extra: {
        controlAcceptances: {
          [ID]: [{
            schema_version: 1, assignment_id: ID, github_login: 'Stud1', github_id: 11,
            accepted_at: '2026-08-02T08:59:00Z', status: 'provisioned', team_slug: 'krusty-krab', team_name: 'Krusty Krab',
          }],
        },
      },
    });
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Krusty Krabs');
    await modal.locator('#team-rename-input').press('Enter');
    await expect(modal.locator('[data-team-rename] [role="alert"]')).toContainText('@stud1 has accepted');
    expect(commits).toEqual([]);
  });

  test('on a draft nobody can have accepted, so it is offered even with no report rows', async ({ page }) => {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: { ...assignment(), state: 'draft' } },
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: [] } },
      controlTeams: { [ID]: [team('krusty-krab', 'Krusty Krab', ['stud1'])] },
      roster,
      gitCommits,
    });
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Krusty Krabs');
    await modal.locator('#team-rename-input').press('Enter');
    await expect.poll(() => gitCommits.length, { timeout: 15000 }).toBe(1);
  });

  test('a repository created after the page loaded stops it at the click', async ({ page }) => {
    const commits = await open(page);
    const modal = await manage(page, 'Krusty Krab');
    // The first member's run provisioned it meanwhile; the manifest says so.
    await page.route(`**/pxl-classroom-control/contents/teams/${ID}/krusty-krab.json*`, (route) => route.fulfill({
      status: 200,
      body: JSON.stringify({
        content: Buffer.from(JSON.stringify({ ...team('krusty-krab', 'Krusty Krab', ['stud1', 'stud2']), repo_name: `${ORG}/${ID}-krusty-krab`, repo_id: 9001 })).toString('base64'),
        encoding: 'base64', sha: 'theirs',
      }),
    }));
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Krusty Krabs');
    await modal.locator('#team-rename-input').press('Enter');
    await expect(modal.locator('[data-team-rename] [role="alert"]')).toContainText('its repository already exists');
    expect(commits).toEqual([]);
  });

  test('records that cannot be read refuse it, rather than reading as nobody accepted', async ({ page }) => {
    const commits = await open(page);
    const modal = await manage(page, 'Krusty Krab');
    await page.route(`**/pxl-classroom-control/contents/acceptances/${ID}*`, (route) => route.fulfill({ status: 500, body: JSON.stringify({ message: 'Server Error' }) }));
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Krusty Krabs');
    await modal.locator('#team-rename-input').press('Enter');
    await expect(modal.locator('[data-team-rename] [role="alert"]')).toContainText('Could not rename the team');
    expect(commits).toEqual([]);
  });

  test('a team file already at the new name, even one not on the page, refuses it', async ({ page }) => {
    const commits = await open(page);
    const modal = await manage(page, 'Krusty Krab');
    await page.route(`**/pxl-classroom-control/contents/teams/${ID}/krusty-krabs.json*`, (route) => route.fulfill({
      status: 200,
      body: JSON.stringify({ content: Buffer.from(JSON.stringify(team('krusty-krabs', 'Krusty Krabs', []))).toString('base64'), encoding: 'base64', sha: 'x' }),
    }));
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Krusty Krabs');
    await modal.locator('#team-rename-input').press('Enter');
    await expect(modal.locator('[data-team-rename] [role="alert"]')).toContainText('a team file called krusty-krabs already exists');
    expect(commits).toEqual([]);
  });

  test('a new spelling with the same slug rewrites the one file, and the repository name it shows does not change', async ({ page }) => {
    const commits = await open(page);
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('KRUSTY krab');
    await expect(modal.locator('[data-team-rename]')).toContainText(`${ID}-krusty-krab`);
    await modal.locator('#team-rename-input').press('Enter');
    await expect.poll(() => commits.length, { timeout: 15000 }).toBe(1);
    expect(writesTo(commits).map(([p, d]) => [p, d?.team_name])).toEqual([[`teams/${ID}/krusty-krab.json`, 'KRUSTY krab']]);
  });

  test('Escape closes the box and writes nothing', async ({ page }) => {
    const commits = await open(page);
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Something Else');
    await modal.locator('#team-rename-input').press('Escape');
    await expect(modal.locator('#team-rename-input')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Rename team' })).toBeVisible();
    expect(commits).toEqual([]);
  });
});
