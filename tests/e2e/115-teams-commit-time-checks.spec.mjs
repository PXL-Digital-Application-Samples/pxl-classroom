// 115 - The Teams tab asks again at the commit it lands on.
//
// Every Teams-tab write decided from what it read carries a precondition that
// reads the files again AT THE PARENT COMMIT (lib/team-write-guard.mjs). The
// shared fixture answers a file the same whatever `?ref=` asks for, so no
// browser test could ever see one refuse (review 2026-10-14, TA-12). Here the
// read at the click and the read at the commit differ: a route answers the
// `?ref=` read - only the precondition sends one - with the file as somebody
// else's write left it.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, answerConfirm } from '../fixtures/e2e-fixtures.mjs';

const ID = 'teams-commit-checks';

const assignment = (over = {}) => ({
  schema_version: 1, id: ID, title: 'Commit Checks Lab', organization: ORG, assignment_type: 'group', roster_mode: 'enforced',
  state: 'published', template: { owner: ORG, repository: 'group-template' }, repository_name_pattern: `${ID}-{team_slug}`,
  opens_at: '2026-08-01T08:00:00.000Z', deadline_at: '2026-12-31T22:00:00.000Z',
  group_config: { max_team_size: 3, min_team_size: 1, formation_mode: 'pre-assigned' },
  ...over,
});
const team = (slug, name, members, extra = {}) => ({
  schema_version: 1, assignment_id: ID, team_slug: slug, team_name: name, members, max_members: 3,
  created_at: '2026-08-01T09:00:00.000Z', created_by: 'lecturer', ...extra,
});
const roster = ['stud1', 'stud2', 'stud3', 'stud4'].map((login, i) => ({ student_number: String(100 + i), full_name: `Student ${i + 1}`, github_login: login }));
const students = () => roster.map((s) => ({ github_login: s.github_login, acceptance_state: 'not-accepted', submission_status: 'no-submission' }));
const b64 = (o) => Buffer.from(JSON.stringify(o, null, 2) + '\n').toString('base64');

async function open(page, teams, { over = {} } = {}) {
  const gitCommits = [];
  const reads = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment(over) },
    reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: students() } },
    controlTeams: { [ID]: teams },
    roster,
    gitCommits,
  });
  page.on('request', (req) => { if (req.url().includes(`/contents/teams/${ID}`)) reads.push(req.url()); });
  await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
  return { gitCommits, reads };
}

/** At the commit (`?ref=` reads only), `path` is `doc` - or absent when doc is null. */
async function changedAtCommit(page, path, doc) {
  await page.route(`**/pxl-classroom-control/contents/${path}?ref=*`, (route) =>
    doc === null
      ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: b64(doc), encoding: 'base64', sha: 'changed' }) }));
}

async function manage(page, name) {
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'Manage' }).click();
  const modal = page.getByRole('dialog', { name: `Manage ${name}` });
  await expect(modal).toBeVisible();
  return modal;
}

test.describe('115 - the Teams tab asks again at the commit it lands on', () => {
  test('rename: a member joined at the commit - refused, nothing written, and the teams are read again', async ({ page }) => {
    const krusty = team('krusty-krab', 'Krusty Krab', ['stud1', 'stud2']);
    const { gitCommits, reads } = await open(page, [krusty, team('pod-pirates', 'Pod Pirates', ['stud3'])]);
    await changedAtCommit(page, `teams/${ID}/krusty-krab.json`, { ...krusty, members: ['stud1', 'stud2', 'stud4'] });
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('button', { name: 'Rename team' }).click();
    await modal.locator('#team-rename-input').fill('Krusty Krabs');
    const before = reads.filter((u) => !u.includes('ref=')).length;
    await modal.locator('#team-rename-input').press('Enter');
    await expect(modal.locator('[data-team-rename] [role="alert"]')).toContainText('Could not rename the team: the team was changed while you renamed it', { timeout: 15000 });
    expect(gitCommits).toEqual([]);
    // What the page shows may be what stopped it: read again.
    await expect.poll(() => reads.filter((u) => !u.includes('ref=')).length, { timeout: 15000 }).toBeGreaterThan(before);
  });

  test('member save: the team changed at the commit - refused, and the access already changed on GitHub is said', async ({ page }) => {
    const krusty = team('krusty-krab', 'Krusty Krab', ['stud1', 'stud2'], { repo_name: `${ORG}/${ID}-krusty-krab`, repo_id: 7 });
    const { gitCommits } = await open(page, [krusty, team('pod-pirates', 'Pod Pirates', ['stud3'])]);
    await changedAtCommit(page, `teams/${ID}/krusty-krab.json`, { ...krusty, members: ['stud1', 'stud2', 'stud4'] });
    const modal = await manage(page, 'Krusty Krab');
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).getByRole('button', { name: /Remove/i }).click();
    await modal.getByRole('button', { name: /Save Changes/i }).click();
    const toast = page.locator('.toast', { hasText: 'Could not save the team' });
    await expect(toast).toContainText('the team was changed while you saved it', { timeout: 15000 });
    await expect(toast).toContainText('Repository access was already changed on GitHub; save again to record it.');
    expect(gitCommits).toEqual([]);
  });

  test('move: the other team changed at the commit - refused, and nothing is written or granted', async ({ page }) => {
    const pirates = team('pod-pirates', 'Pod Pirates', ['stud3']);
    const { gitCommits } = await open(page, [team('krusty-krab', 'Krusty Krab', ['stud1', 'stud2']), pirates]);
    await changedAtCommit(page, `teams/${ID}/pod-pirates.json`, { ...pirates, members: ['stud3', 'stud4'] });
    const granted = [];
    page.on('request', (req) => { if (req.method() === 'PUT' && req.url().includes('/collaborators/')) granted.push(req.url()); });
    const modal = await manage(page, 'Krusty Krab');
    await modal.getByRole('combobox', { name: 'Move @stud2 to another team' }).selectOption('pod-pirates');
    await answerConfirm(page);
    await expect(page.locator('.toast', { hasText: 'Could not move @stud2' })).toContainText('one of the two teams was changed while you moved them', { timeout: 15000 });
    expect(gitCommits).toEqual([]);
    expect(granted).toEqual([]);
  });

  test('Copy teams: a planned team made at the commit (a rename into its name, say) - refused, nothing written, the plan read again', async ({ page }) => {
    const PREV = 'previous-lab';
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: { [PREV]: assignment({ id: PREV, repository_name_pattern: `${PREV}-{team_slug}` }), [ID]: assignment() },
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams: [], students: students() } },
      controlTeams: { [PREV]: [{ ...team('alpha', 'Alpha Team', ['stud1', 'stud2']), assignment_id: PREV }] },
      roster,
    });
    // At the commit `alpha` exists in this assignment, with a member.
    await changedAtCommit(page, `teams/${ID}/alpha.json`, team('alpha', 'Alpha Team', ['stud4']));
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    await page.locator('button', { hasText: 'Copy teams' }).first().click();
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await page.locator('.modal-foot button', { hasText: /Copy 1 team/ }).click();
    await expect(page.locator('[data-seed-error]')).toContainText('Alpha Team was made or joined since the plan was made', { timeout: 15000 });
    await expect(page.locator('[data-seed-error]')).toContainText('The plan below has been read again.');
    expect(gitCommits).toEqual([]);
  });

  test('Undo copy: a member accepted at the commit - refused, both copied teams kept', async ({ page }) => {
    const SEEDED = { source: 'assignment', assignment_id: 'previous', seeded_at: '2026-10-01T08:00:00Z', seeded_by: 'lecturer' };
    const { gitCommits } = await open(page, [
      team('alpha', 'Alpha Team', ['stud1'], { seeded_from: SEEDED }),
      team('beta', 'Beta Team', ['stud2'], { seeded_from: SEEDED }),
    ], { over: { state: 'draft' } });
    // At the commit, stud1 has an acceptance record.
    await page.route(`**/pxl-classroom-control/contents/acceptances/${ID}?ref=*`, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ name: 'stud1.json', path: `acceptances/${ID}/stud1.json`, type: 'file', sha: 'x' }]),
    }));
    const undo = page.locator('button', { hasText: /Undo copy/ });
    await expect(undo).toContainText('Undo copy (2)', { timeout: 15000 });
    await undo.click();
    await answerConfirm(page);
    await expect(page.locator('.toast').filter({ hasText: /stud1 accepted since the teams were read/ })).toBeVisible({ timeout: 15000 });
    expect(gitCommits).toEqual([]);
  });
});
