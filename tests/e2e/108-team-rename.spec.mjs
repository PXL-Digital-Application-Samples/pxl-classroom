// 108 - A team is renamed on the Teams tab, while nobody in it has accepted.
//
// Asked 2026-10-12: teams copied from another assignment carried one wrong
// name, and the only fix was create, move every member, delete. Before anyone
// accepts nothing hangs on the name, so the name and the slug (and with it the
// repository the team will get) change in one commit. After that it says why
// not. lib/team-rename.mjs decides; tests/team-rename.test.mjs covers the rules.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, inviteToken } from '../fixtures/e2e-fixtures.mjs';

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

  test('TA-6 (T7): saved but not published: no success said, the failure is, and the team shows its new name', async ({ page }) => {
    const commits = await open(page);
    await page.route('**/actions/workflows/regenerate-dashboard.yml/dispatches', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Server Error' }) }));
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Krusty Krabs');
    await modal.locator('#team-rename-input').press('Enter');
    await expect.poll(() => commits.length, { timeout: 15000 }).toBe(1);
    await expect(page.locator('.toast', { hasText: 'Saved, but publishing the change to students failed' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.toast', { hasText: 'Renamed to' })).toHaveCount(0);
  });

  test('TA-6: the button says "Renaming…" while the commit is on its way, and nothing can be pressed twice', async ({ page }) => {
    const commits = await open(page);
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route('**/git/refs/heads/main', async (route) => {
      if (route.request().method() === 'PATCH') await held;
      return route.fallback();
    });
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Krusty Krabs');
    await modal.locator('#team-rename-input').press('Enter');
    const button = modal.locator('[data-team-rename]').getByRole('button', { name: 'Renaming…' });
    await expect(button).toBeVisible({ timeout: 15000 });
    await expect(button).toBeDisabled();
    await expect(modal.locator('#team-rename-input')).toBeDisabled();
    release();
    await expect.poll(() => commits.length, { timeout: 15000 }).toBe(1);
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

  // Review 2026-10-14 (P2-16): under open enrolment the report has no rows
  // until somebody accepts, and "no rows" counted as everybody accepted - so
  // every rename said "@stud1 has accepted" while nobody had.
  for (const [label, acceptances, renamed] of [
    ['published, open, nobody accepted yet: offered, and renamed', [], true],
    ['published, open, a member has a record: offered, and stopped at the click by that record', [{
      schema_version: 1, assignment_id: ID, github_login: 'stud1', github_id: 11,
      accepted_at: '2026-08-02T08:59:00Z', status: 'provisioned', team_slug: 'krusty-krab', team_name: 'Krusty Krab',
    }], false],
  ]) {
    test(`P2-16: ${label}`, async ({ page }) => {
      const gitCommits = [];
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, {
        currentUser: LECTURER,
        assignments: { [ID]: { ...assignment(), roster_mode: 'open' } },
        reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: [] } },
        controlTeams: { [ID]: [team('krusty-krab', 'Krusty Krab', ['stud1'])] },
        ...(acceptances.length ? { controlAcceptances: { [ID]: acceptances } } : {}),
        roster,
        gitCommits,
      });
      await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
      const modal = await manage(page, 'Krusty Krab');
      await expect(modal.locator('[data-team-rename]')).not.toContainText('has accepted');
      await modal.getByRole('button', { name: 'Rename team' }).click();
      await modal.locator('#team-rename-input').fill('Krusty Krabs');
      await modal.locator('#team-rename-input').press('Enter');
      if (renamed) {
        await expect.poll(() => gitCommits.length, { timeout: 15000 }).toBe(1);
      } else {
        await expect(modal.locator('[data-team-rename] [role="alert"]')).toContainText('@stud1 has accepted');
        expect(gitCommits).toEqual([]);
      }
    });
  }

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
    await expect(modal.locator('[data-team-rename] [role="alert"]')).toContainText('this assignment already has a team called krusty-krabs, which may be one everybody left. Nothing was changed.', { timeout: 15000 });
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
    // Focus goes back to what opened the box, not to nowhere.
    await expect(modal.getByRole('button', { name: 'Rename team' })).toBeFocused();
    expect(commits).toEqual([]);
  });

  test('a member removed in Manage and not saved: rename is not offered until that is saved or undone', async ({ page }) => {
    // Review 2026-10-14: the rename writes from the stored file and closes
    // Manage, so the unsaved removal was dropped behind a "Renamed" toast.
    const commits = await open(page);
    const modal = await manage(page, 'Krusty Krab');
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).getByRole('button', { name: 'Remove' }).click();
    await expect(modal.getByRole('button', { name: 'Rename team' })).toHaveCount(0);
    await expect(modal.locator('[data-team-rename]')).toContainText('Save or undo the member changes first, then rename.');
    expect(commits).toEqual([]);
  });

  test('a new team may not take the name another team had before its rename', async ({ page }) => {
    // A page loaded before the rename still sends the old slug, and acceptance
    // takes it as the renamed team for its members: the old name stays theirs.
    const renamed = { ...team('krusty-krabs', 'Krusty Krabs', ['stud1']), renamed_from: ['krusty-krab'] };
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: students() } },
      controlTeams: { [ID]: [renamed] },
      roster,
    });
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    await page.getByRole('button', { name: /Create Team/i }).first().click();
    await page.locator('#create-team-name').fill('Krusty Krab');
    await expect(page.locator('[data-new-slug-problem]')).toContainText('"Krusty Krabs" was called krusty-krab until it was renamed');
    await expect(page.locator('.modal-foot').getByRole('button', { name: 'Create Team' })).toBeDisabled();
  });

  test('TA-5 (PG1): a name with an email address is refused in Create Team and in the rename box, and nothing is written', async ({ page }) => {
    // Published on every student page, and one address failed the Pages
    // deploy for every organization (lib/public-text.mjs).
    const commits = await open(page);
    await page.getByRole('button', { name: /Create Team/i }).first().click();
    await page.locator('#create-team-name').fill('ann.dewit@student.pxl.be');
    await expect(page.locator('[data-new-slug-problem]')).toContainText('A team name is shown on a public page, so it cannot contain an email address.');
    await expect(page.locator('.modal-foot').getByRole('button', { name: 'Create Team' })).toBeDisabled();
    await page.locator('.modal-foot').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#create-team-name')).toHaveCount(0);

    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Mail ann.dewit@student.pxl.be');
    await modal.locator('#team-rename-input').press('Enter');
    await expect(modal.locator('[data-team-rename]')).toContainText('cannot contain an email address', { timeout: 15000 });
    expect(commits).toEqual([]);
  });

  test('the Teams dialogs are dialogs: focus goes in, Escape closes them, and focus comes back', async ({ page }) => {
    // Found writing the test above: neither had a dialog role, Escape did
    // nothing, and focus stayed on the button behind the overlay.
    await open(page);
    const create = page.getByRole('button', { name: /Create Team/i }).first();
    await create.click();
    await expect(page.getByRole('dialog', { name: /Create a team in/ })).toBeVisible();
    await expect(page.locator('#create-team-name')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /Create a team in/ })).toHaveCount(0);
    await expect(create).toBeFocused();

    const modal = await manage(page, 'Krusty Krab');
    await expect(page.getByRole('dialog', { name: /Manage Krusty Krab/ })).toBeVisible();
    // Escape in the rename box closes the box, not the dialog.
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').press('Escape');
    await expect(page.getByRole('dialog', { name: /Manage Krusty Krab/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /Manage Krusty Krab/ })).toHaveCount(0);
    await expect(page.locator('tr', { hasText: 'Krusty Krab' }).getByRole('button', { name: 'Manage' })).toBeFocused();
  });

  // Review 2026-10-14 (P2-18): Create Team wrote from the page's copy of the
  // teams - over a file made since, or under a name another tab had renamed away.
  test('P2-18: Create Team reads the teams again at the click: a name renamed away since is refused', async ({ page }) => {
    let renamedSince = false;
    const gitCommits = [];
    const writes = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: students() } },
      controlTeams: { [ID]: [team('krusty-krab', 'Krusty Krab', ['stud1'])] },
      roster,
      gitCommits,
    });
    // Made and renamed in another tab after this page read the teams: this
    // page has never seen "Gamma", which was called beta.
    const renamed = { ...team('gamma', 'Gamma', ['stud2']), renamed_from: ['beta'] };
    await page.route(new RegExp(`/contents/teams/${ID}(\\?|$)`), (route) => {
      if (!renamedSince) return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { name: 'krusty-krab.json', path: `teams/${ID}/krusty-krab.json`, type: 'file' },
        { name: 'gamma.json', path: `teams/${ID}/gamma.json`, type: 'file' },
      ]) });
    });
    await page.route(new RegExp(`/contents/teams/${ID}/gamma\\.json`), (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: Buffer.from(JSON.stringify(renamed)).toString('base64'), encoding: 'base64' }) }));
    await page.route(new RegExp(`/contents/teams/${ID}/beta\\.json`), (route) => {
      if (route.request().method() === 'PUT') writes.push(route.request().url());
      return route.fallback();
    });
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    await expect(page.locator('tr', { hasText: 'Krusty Krab' })).toBeVisible({ timeout: 15000 });
    renamedSince = true;
    await page.getByRole('button', { name: /Create Team/i }).first().click();
    await page.locator('#create-team-name').fill('Beta');
    await page.locator('.modal-foot').getByRole('button', { name: 'Create Team' }).click();
    await expect(page.locator('.toast', { hasText: /"Gamma" was called beta until it was renamed/ })).toBeVisible({ timeout: 10000 });
    expect(writes).toEqual([]);
  });

  test('P2-18: a team file made at the name since is not overwritten', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: students() } },
      controlTeams: { [ID]: [team('pod-pirates', 'Pod Pirates', ['stud3'])] },
      roster,
    });
    const bodies = [];
    // GitHub's answer to a create (no sha) over a file that now exists.
    await page.route(new RegExp(`/contents/teams/${ID}/rockets\\.json`), (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }) });
    });
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    await expect(page.locator('tr', { hasText: 'Pod Pirates' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Create Team/i }).first().click();
    await page.locator('#create-team-name').fill('Rockets');
    await page.locator('.modal-foot').getByRole('button', { name: 'Create Team' }).click({ force: true });
    await expect(page.locator('.toast', { hasText: /A team called rockets was made meanwhile/ })).toBeVisible({ timeout: 10000 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].sha, 'written as new, never against a sha fetched afresh').toBeUndefined();
  });

  test('whether students see the new name is read from the page they are served, and read again on Check again (PG12)', async ({ page }) => {
    const renamed = { ...team('krusty-krabs', 'Krusty Krabs', ['stud1']), renamed_from: ['krusty-krab'] };
    let served = [{ team_slug: 'krusty-krab', team_name: 'Krusty Krab', members: ['stud1'] }];
    let reads = 0;
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: { ...assignment(), invite_key: inviteToken(ORG, ID) } },
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: students() } },
      controlTeams: { [ID]: [renamed] },
      roster,
    });
    await page.route(/\/data\/[^/]+\/i\/[^/]+\.teams\.json/, (route) => {
      reads++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: served }) });
    });
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    const line = page.locator('[data-note="renamed-served"]');
    await expect(line).toHaveAttribute('data-state', 'stale');
    await expect(line).toContainText('Students do not see "Krusty Krabs" yet, they see "Krusty Krab": the student pages have not been rebuilt since the rename.');
    await expect(line.getByRole('button', { name: 'Update the student pages' })).toBeVisible();

    served = [{ team_slug: 'krusty-krabs', team_name: 'Krusty Krabs', members: ['stud1'], renamed_from: ['krusty-krab'] }];
    const before = reads;
    await line.getByRole('button', { name: 'Check again' }).click();
    await expect(line).toHaveAttribute('data-state', 'current');
    await expect(line).toContainText('Students see every renamed team under its new name.');
    expect(reads).toBe(before + 1);
    await expect(line.getByRole('button', { name: 'Update the student pages' })).toHaveCount(0);
  });
});
