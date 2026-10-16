// Moving a student between teams, in one gesture and one commit.
//
// TEAMS-PLAN promised a lecturer "Move Student" action and it was never built.
// The two-step alternative - remove in one team's modal, add in another's - is
// two commits with a window in between where the student belongs to no team at
// all, and if the second half fails they are simply lost from the grouping.
//
// The interesting assertions are not that it works but WHAT it writes: both
// manifests merged onto what was stored (so created_by, repo_id and seeded_from
// survive), in a single commit, with the emptied team marked vacant.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, answerConfirm } from '../fixtures/e2e-fixtures.mjs';

const ID = 'move-student-demo';

function assignment() {
  return {
    schema_version: 1,
    id: ID,
    title: 'Move Student Demo',
    organization: ORG,
    assignment_type: 'group',
    roster_mode: 'enforced',
    state: 'published',
    template: { owner: ORG, repository: 'group-template' },
    repository_name_pattern: `${ID}-{team_slug}`,
    opens_at: '2026-08-01T08:00:00.000Z',
    deadline_at: '2026-12-31T22:00:00.000Z',
    group_config: { max_team_size: 3, min_team_size: 2, allow_team_creation: true },
  };
}

// The stored manifests. Both carry fields the display row does not: created_by,
// repo_id, and (on alpha) seeded_from - the provenance planUnseed keys on.
function storedAlpha() {
  return {
    schema_version: 1,
    assignment_id: ID,
    team_slug: 'alpha',
    team_name: 'Alpha',
    members: ['stud1', 'stud2'],
    max_members: 3,
    created_at: '2026-08-01T09:00:00.000Z',
    created_by: 'stud1',
    repo_name: `${ORG}/${ID}-alpha`,
    repo_id: 4001,
    repo_url: `https://github.com/${ORG}/${ID}-alpha`,
    seeded_from: {
      source: 'assignment',
      assignment_id: 'previous-group-work',
      seeded_at: '2026-07-30T08:00:00.000Z',
      seeded_by: 'lecturer',
    },
  };
}

function storedBeta() {
  return {
    schema_version: 1,
    assignment_id: ID,
    team_slug: 'beta',
    team_name: 'Beta',
    members: ['stud3'],
    max_members: 3,
    created_at: '2026-08-01T09:30:00.000Z',
    created_by: 'stud3',
    repo_name: `${ORG}/${ID}-beta`,
    repo_id: 4002,
    repo_url: `https://github.com/${ORG}/${ID}-beta`,
  };
}

function report() {
  return {
    schema_version: 1,
    assignment_id: ID,
    generated_at: new Date().toISOString(),
    teams: [
      { team_slug: 'alpha', team_name: 'Alpha', members: ['stud1', 'stud2'], repo_name: `${ORG}/${ID}-alpha`, repo_url: `https://github.com/${ORG}/${ID}-alpha` },
      { team_slug: 'beta', team_name: 'Beta', members: ['stud3'], repo_name: `${ORG}/${ID}-beta`, repo_url: `https://github.com/${ORG}/${ID}-beta` },
    ],
    students: [
      { github_login: 'stud1', team_slug: 'alpha', submission_status: 'on-time' },
      { github_login: 'stud2', team_slug: 'alpha', submission_status: 'on-time' },
      { github_login: 'stud3', team_slug: 'beta', submission_status: 'on-time' },
    ],
  };
}

async function openManageAlpha(page, captured, { overrides = {}, lockRecord = null } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    assignments: { [ID]: assignment() },
    reports: { [ID]: report() },
    controlTeams: { [ID]: [storedAlpha(), storedBeta()] },
    controlOverrides: { [ID]: overrides },
    currentUser: LECTURER,
  });
  if (lockRecord) {
    await page.route(`**/contents/lockdowns/${ID}/lockdown-record.json*`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: Buffer.from(JSON.stringify(lockRecord)).toString('base64'), encoding: 'base64' }) }));
  }
  // Each team repository's deadline variable (lib/deadline-variable.mjs), as written.
  captured.variables = captured.variables || [];
  await page.route('**/actions/variables**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
    let value = null;
    try { value = req.postDataJSON()?.value ?? null; } catch { /* a DELETE has no body */ }
    captured.variables.push({ method: req.method(), repo: req.url().split('/repos/')[1].split('/actions/')[0], value });
    return route.fulfill({ status: req.method() === 'POST' ? 201 : 204, body: '' });
  });

  // commitFiles goes through the git tree API, not PUT /contents/, so the
  // manifests appear as blobs and the atomicity claim is visible as a single
  // POST /git/trees carrying both paths.
  await page.route('**/repos/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    if (method === 'POST' && url.includes('/git/blobs')) {
      const body = req.postDataJSON();
      captured.blobs.push(Buffer.from(body.content || '', 'base64').toString('utf8'));
    }
    if (method === 'POST' && url.includes('/git/trees')) {
      const body = req.postDataJSON();
      captured.trees.push((body.tree || []).map((e) => e.path));
    }
    if (/\/collaborators\//.test(url) && (method === 'PUT' || method === 'DELETE')) {
      captured.collab.push(`${method} ${url.split('/repos/')[1]}`);
    }
    await route.fallback();
  });

  await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
  const alphaRow = page.locator('tr', { hasText: 'Alpha' });
  await expect(alphaRow).toBeVisible();
  await alphaRow.getByRole('button', { name: /Manage/i }).click();
  await expect(page.locator('.modal.card', { hasText: 'Manage Alpha' })).toBeVisible();
}

test.describe('48 - a move after the deadline and with extensions (review 2026-10-16)', () => {
  test('R7-5: into a team the lock left read-only, the student gets read, not the assignment\'s admin', async ({ page }) => {
    const captured = { blobs: [], trees: [], collab: [] };
    await openManageAlpha(page, captured, {
      lockRecord: { schema_version: 1, assignment_id: ID, results: [{ github_login: 'stud3', repo_name: `${ORG}/${ID}-beta`, snapshot_sha: 'a'.repeat(40), lock_method: 'demotion', verified: true }] },
    });
    // stud2 already a collaborator there: GitHub answers 204 at the permission sent.
    const granted = [];
    await page.route(`**/repos/${ORG}/${ID}-beta/collaborators/stud2`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      granted.push(route.request().postDataJSON()?.permission ?? null);
      return route.fulfill({ status: 204, body: '' });
    });
    const modal = page.locator('.modal.card', { hasText: 'Manage Alpha' });
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select').selectOption('beta');
    await answerConfirm(page);
    await expect(page.locator('.toast', { hasText: /moved to "Beta"/i })).toContainText(`read access to ${ID}-beta, as the deadline's lock left it`);
    expect(granted).toEqual(['pull']);
  });

  // R7-44: unreadable is held - the safe answer - and said as unread, never as
  // a lock that may not exist.
  test('R7-44: with the lock record unreadable, the student gets read and the note says it could not be read', async ({ page }) => {
    const captured = { blobs: [], trees: [], collab: [] };
    await openManageAlpha(page, captured);
    await page.route(`**/contents/lockdowns/${ID}/lockdown-record.json*`, (route) =>
      route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ message: 'Bad Gateway' }) }));
    const granted = [];
    await page.route(`**/repos/${ORG}/${ID}-beta/collaborators/stud2`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      granted.push(route.request().postDataJSON()?.permission ?? null);
      return route.fulfill({ status: 204, body: '' });
    });
    const modal = page.locator('.modal.card', { hasText: 'Manage Alpha' });
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select').selectOption('beta');
    await answerConfirm(page);
    const toast = page.locator('.toast', { hasText: /moved to "Beta"/i });
    await expect(toast).toContainText(`read access to ${ID}-beta for now: whether the deadline's lock holds it could not be read`);
    await expect(toast).not.toContainText('as the deadline\'s lock left it');
    expect(granted).toEqual(['pull']);
  });

  test('R7-14: both teams\' deadlines are written again from their members after the move', async ({ page }) => {
    const ext = '2027-01-05T22:00:00.000Z';
    const captured = { blobs: [], trees: [], collab: [] };
    await openManageAlpha(page, captured, {
      overrides: { stud2: { schema_version: 1, assignment_id: ID, github_login: 'stud2', overrides: [{ type: 'deadline_extension', value: ext, reason: 'r', overridden_by: 'admin-panel', overridden_at: '2026-10-16T10:00:00Z' }] } },
    });
    const modal = page.locator('.modal.card', { hasText: 'Manage Alpha' });
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select').selectOption('beta');
    await answerConfirm(page);
    await expect(page.locator('.toast', { hasText: /moved to "Beta"/i })).toBeVisible();
    // Beta now carries stud2's extension; Alpha, without them, carries none.
    await expect.poll(() => captured.variables.map((v) => `${v.repo} ${v.value ?? 'none'}`).sort()).toEqual([
      `${ORG}/${ID}-alpha none`,
      `${ORG}/${ID}-beta ${ext}`,
    ]);
  });
});

test.describe('48 - Moving a student between teams', () => {
  test('both manifests land in ONE commit, merged onto what was stored', async ({ page }) => {
    const captured = { blobs: [], trees: [], collab: [] };
    await openManageAlpha(page, captured);

    const modal = page.locator('.modal.card', { hasText: 'Manage Alpha' });
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select').selectOption('beta');
    await answerConfirm(page);
    await expect(page.locator('.toast', { hasText: /moved to "Beta"/i })).toBeVisible();

    // ONE tree carrying BOTH team paths. Two trees would be two commits, with a
    // window in between where the student is in no team at all.
    const moveTree = captured.trees.find((paths) =>
      paths.some((p) => p.endsWith('alpha.json')) && paths.some((p) => p.endsWith('beta.json'))
    );
    expect(moveTree, `expected one tree with both manifests, saw ${JSON.stringify(captured.trees)}`).toBeTruthy();

    const written = captured.blobs.map((b) => JSON.parse(b)).filter((d) => d.team_slug);
    const alpha = written.find((d) => d.team_slug === 'alpha');
    const beta = written.find((d) => d.team_slug === 'beta');
    expect(alpha, 'alpha manifest must be written').toBeTruthy();
    expect(beta, 'beta manifest must be written').toBeTruthy();

    // The move itself.
    expect(alpha.members).toEqual(['stud1']);
    expect(beta.members).toEqual(['stud3', 'stud2']);
    expect(alpha.vacant).toBe(false); // stud1 is still there

    // MERGED, not rebuilt: these are exactly the fields the display row lacks,
    // and the fields a field-by-field rebuild silently dropped.
    expect(alpha.created_by).toBe('stud1');
    expect(alpha.repo_id).toBe(4001);
    expect(alpha.seeded_from).toEqual(storedAlpha().seeded_from);
    expect(beta.created_by).toBe('stud3');
    expect(beta.repo_id).toBe(4002);
  });

  test("the student's repository record and acceptance move in the SAME commit", async ({ page }) => {
    // Only the manifests moved, so the collector kept reading alpha's
    // repository for stud2 and lockdown demoted them there - re-inviting them -
    // while leaving them admin on beta's after the deadline.
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [ID]: assignment() },
      reports: { [ID]: report() },
      controlTeams: { [ID]: [storedAlpha(), storedBeta()] },
      controlRepositories: {
        [ID]: [{
          schema_version: 1, assignment_id: ID, github_login: 'stud2',
          repo_id: 4001, repo_name: `${ORG}/${ID}-alpha`, repo_url: `https://github.com/${ORG}/${ID}-alpha`,
          created_at: '2026-08-02T09:00:00Z', student_permission: 'admin', access_state: 'invited',
          last_checked_at: null, feedback_pr_number: 7, feedback_pr_url: null, feedback_pr_baseline_sha: null,
          team_slug: 'alpha',
        }],
      },
      controlAcceptances: {
        [ID]: [{
          schema_version: 1, assignment_id: ID, github_login: 'stud2', github_id: 2,
          accepted_at: '2026-08-02T08:59:00Z', status: 'provisioned', team_slug: 'alpha', team_name: 'Alpha',
        }],
      },
      currentUser: LECTURER,
      gitCommits,
    });
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    await page.locator('tr', { hasText: 'Alpha' }).getByRole('button', { name: /Manage/i }).click();
    const modal = page.locator('.modal.card', { hasText: 'Manage Alpha' });
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select').selectOption('beta');
    await answerConfirm(page);
    await expect(page.locator('.toast', { hasText: /moved to "Beta"/i })).toBeVisible();

    const move = gitCommits.find((c) => c.files.some((f) => f.path.endsWith('beta.json')));
    const files = new Map(move.files.map((f) => [f.path, f.content]));
    const rec = JSON.parse(files.get(`repositories/${ID}/stud2.json`));
    expect(rec.repo_name).toBe(`${ORG}/${ID}-beta`);
    expect(rec.repo_id).toBe(4002);
    expect(rec.team_slug).toBe('beta');
    expect(rec.feedback_pr_number).toBeNull();
    const acc = JSON.parse(files.get(`acceptances/${ID}/stud2.json`));
    expect(acc.team_slug).toBe('beta');
    expect(acc.accepted_at).toBe('2026-08-02T08:59:00Z');
  });

  test('repository access follows the student in both directions', async ({ page }) => {
    const captured = { blobs: [], trees: [], collab: [] };
    await openManageAlpha(page, captured);

    const modal = page.locator('.modal.card', { hasText: 'Manage Alpha' });
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select').selectOption('beta');
    await answerConfirm(page);
    await expect(page.locator('.toast', { hasText: /moved to "Beta"/i })).toBeVisible();

    expect(captured.collab.some((c) => c.startsWith('DELETE') && c.includes('-alpha'))).toBe(true);
    expect(captured.collab.some((c) => c.startsWith('PUT') && c.includes('-beta'))).toBe(true);
  });

  test('a full team is not offered as a destination', async ({ page }) => {
    await injectAuth(page, LECTURER);
    const fullBeta = { ...storedBeta(), members: ['stud3', 'stud4', 'stud5'] };
    const fullReport = report();
    fullReport.teams[1].members = ['stud3', 'stud4', 'stud5'];

    await setupStandardMockRoutes(page, {
      assignments: { [ID]: assignment() },
      reports: { [ID]: fullReport },
      controlTeams: { [ID]: [storedAlpha(), fullBeta] },
      currentUser: LECTURER,
    });
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    const alphaRow = page.locator('tr', { hasText: 'Alpha' });
    await alphaRow.getByRole('button', { name: /Manage/i }).click();

    const modal = page.locator('.modal.card', { hasText: 'Manage Alpha' });
    const select = modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select');
    // Beta is at 3/3, so it must not be an option. With no destinations at all
    // the control is not rendered - an empty picker is not a control.
    if (await select.count()) {
      await expect(select.locator('option', { hasText: 'Beta' })).toHaveCount(0);
    }
  });
});
