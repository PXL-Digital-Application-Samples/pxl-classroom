// 99 - A Teams change is applied to the team AS STORED, at the click.
//
// Three findings from the review of 2026-10-06, all older than 2.0 and all the
// same shape: the Teams tab acted on what the page had read when it loaded.
//   * Save wrote the member list on screen, dropping anyone who joined while
//     Manage was open - out of the team file, keeping their access.
//   * Delete judged "vacant" from the page as loaded, and deleted a team a
//     student had just joined.
//   * A move read the student's records at the team file's spelling of their
//     username (`ella-dev`) while acceptance filed them at GitHub's
//     (`Ella-Dev.json`): it read "no record" and wrote a second one beside the
//     real one, which still named the old team.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, answerConfirm } from '../fixtures/e2e-fixtures.mjs';

const ID = 'teams-stored';

const assignment = () => ({
  schema_version: 1,
  id: ID,
  title: 'Stored Teams Lab',
  organization: ORG,
  assignment_type: 'group',
  roster_mode: 'enforced',
  state: 'published',
  template: { owner: ORG, repository: 'group-template' },
  repository_name_pattern: `${ID}-{team_slug}`,
  opens_at: '2026-08-01T08:00:00.000Z',
  deadline_at: '2026-12-31T22:00:00.000Z',
  group_config: { max_team_size: 3, min_team_size: 1, allow_team_creation: true },
});

const team = (slug, name, members, extra = {}) => ({
  schema_version: 1,
  assignment_id: ID,
  team_slug: slug,
  team_name: name,
  members,
  max_members: 3,
  created_at: '2026-08-01T09:00:00.000Z',
  created_by: 'lecturer',
  ...(members.length ? {} : { vacant: true }),
  ...extra,
});

const roster = ['stud1', 'stud2', 'stud3', 'stud4'].map((login, i) => ({
  student_number: String(100 + i), full_name: `Student ${i + 1}`, github_login: login,
}));

async function open(page, { teams, extra = {} }) {
  const gitCommits = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment() },
    reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: [] } },
    controlTeams: { [ID]: teams },
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

/** From now on the team file on GitHub says this - somebody else's write. */
async function storedNow(page, doc) {
  await page.route(`**/pxl-classroom-control/contents/teams/${ID}/${doc.team_slug}.json*`, (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({ content: Buffer.from(JSON.stringify(doc)).toString('base64'), encoding: 'base64', sha: 'theirs' }),
    }));
}

const teamWrite = (commits, slug) => {
  for (const c of [...commits].reverse()) {
    const f = c.files.find((x) => x.path === `teams/${ID}/${slug}.json`);
    if (f) return f.content === null ? null : JSON.parse(f.content);
  }
  return undefined;
};

test.describe('99 - Teams changes apply to the team as stored', () => {
  test('Save keeps a member who joined while Manage was open', async ({ page }) => {
    const commits = await open(page, { teams: [team('alpha', 'Alpha', ['stud1'])] });
    const modal = await manage(page, 'Alpha');
    // stud2 accepted into Alpha after the dialog opened.
    await storedNow(page, team('alpha', 'Alpha', ['stud1', 'stud2']));

    await modal.locator('.add-member-section select').selectOption('stud3');
    await modal.locator('.add-member-section').getByRole('button', { name: 'Add' }).click();
    await modal.getByRole('button', { name: /Save Changes/ }).click();

    await expect.poll(() => teamWrite(commits, 'alpha'), { timeout: 15000 }).toBeTruthy();
    expect(teamWrite(commits, 'alpha').members).toEqual(['stud1', 'stud2', 'stud3']);
  });

  test('Save that would put the team over its size since it opened is refused, and writes nothing', async ({ page }) => {
    const commits = await open(page, { teams: [team('alpha', 'Alpha', ['stud1'])] });
    const modal = await manage(page, 'Alpha');
    await storedNow(page, team('alpha', 'Alpha', ['stud1', 'stud2', 'stud4']));

    await modal.locator('.add-member-section select').selectOption('stud3');
    await modal.locator('.add-member-section').getByRole('button', { name: 'Add' }).click();
    await modal.getByRole('button', { name: /Save Changes/ }).click();

    await expect(page.locator('.toast-error')).toContainText('would have 4 members, over its 3');
    expect(teamWrite(commits, 'alpha')).toBeUndefined();
  });

  test('a repository created while Manage was open is the one a removed member loses', async ({ page }) => {
    // Self-review 2026-10-06: the save took the repository from the row on
    // screen, which had none, so a removed member kept admin on the one their
    // run had just created - while their record was deleted, so lockdown
    // never touched them either.
    const collab = [];
    const commits = await open(page, { teams: [team('alpha', 'Alpha', ['stud1'])] });
    await page.route('**/collaborators/**', (route) => {
      collab.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 204, body: '' });
    });
    const modal = await manage(page, 'Alpha');
    await storedNow(page, team('alpha', 'Alpha', ['stud1'], { repo_name: `${ORG}/${ID}-alpha`, repo_id: 4001, repo_url: `https://github.com/${ORG}/${ID}-alpha` }));

    await modal.locator('.member-manage-row', { hasText: 'stud1' }).getByRole('button', { name: 'Remove' }).click();
    await modal.getByRole('button', { name: /Save Changes/ }).click();
    await expect.poll(() => teamWrite(commits, 'alpha'), { timeout: 15000 }).toBeTruthy();
    expect(collab).toContain(`DELETE /repos/${ORG}/${ID}-alpha/collaborators/stud1`);
  });

  test('Delete is refused when the team is no longer empty at the click', async ({ page }) => {
    const deletes = [];
    page.on('request', (r) => { if (r.method() === 'DELETE' && r.url().includes('/contents/teams/')) deletes.push(r.url()); });
    await open(page, { teams: [team('alpha', 'Alpha', ['stud1']), team('echo', 'Echo', [])] });
    const modal = await manage(page, 'Echo');
    await storedNow(page, team('echo', 'Echo', ['stud2']));

    await modal.getByRole('button', { name: 'Delete team' }).click();
    await answerConfirm(page);
    await expect(page.locator('.toast-error')).toContainText('"Echo" was not deleted: it has a member now');
    expect(deletes).toEqual([]);
  });

  test("a move rewrites the records filed under GitHub's spelling, not a second set", async ({ page }) => {
    const commits = await open(page, {
      teams: [team('alpha', 'Alpha', ['stud1', 'ella-dev'], { repo_name: `${ORG}/${ID}-alpha`, repo_id: 4001, repo_url: `https://github.com/${ORG}/${ID}-alpha` }),
        team('beta', 'Beta', ['stud3'], { repo_name: `${ORG}/${ID}-beta`, repo_id: 4002, repo_url: `https://github.com/${ORG}/${ID}-beta` })],
      extra: {
        controlRepositories: {
          [ID]: [{
            schema_version: 1, assignment_id: ID, github_login: 'Ella-Dev',
            repo_id: 4001, repo_name: `${ORG}/${ID}-alpha`, repo_url: `https://github.com/${ORG}/${ID}-alpha`,
            created_at: '2026-08-02T09:00:00Z', student_permission: 'admin', access_state: 'invited',
            last_checked_at: null, feedback_pr_number: null, feedback_pr_url: null, feedback_pr_baseline_sha: null,
            team_slug: 'alpha',
          }],
        },
        controlAcceptances: {
          [ID]: [{
            schema_version: 1, assignment_id: ID, github_login: 'Ella-Dev', github_id: 7,
            accepted_at: '2026-08-02T08:59:00Z', status: 'provisioned', team_slug: 'alpha', team_name: 'Alpha',
          }],
        },
      },
    });
    const modal = await manage(page, 'Alpha');
    await modal.locator('.member-manage-row', { hasText: 'ella-dev' }).locator('select').selectOption('beta');
    await answerConfirm(page);
    await expect(page.locator('.toast', { hasText: /moved to "Beta"/i })).toBeVisible({ timeout: 15000 });

    const move = commits.find((c) => c.files.some((f) => f.path === `teams/${ID}/beta.json`));
    const paths = move.files.map((f) => f.path);
    expect(paths).toContain(`repositories/${ID}/Ella-Dev.json`);
    expect(paths).toContain(`acceptances/${ID}/Ella-Dev.json`);
    expect(paths.filter((p) => /\/ella-dev\.json$/.test(p)), 'no second set at the team file spelling').toEqual([]);
    const rec = JSON.parse(move.files.find((f) => f.path === `repositories/${ID}/Ella-Dev.json`).content);
    expect(rec.team_slug).toBe('beta');
  });
});
