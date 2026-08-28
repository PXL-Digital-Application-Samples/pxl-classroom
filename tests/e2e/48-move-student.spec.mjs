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
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

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

async function openManageAlpha(page, captured) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    assignments: { [ID]: assignment() },
    reports: { [ID]: report() },
    controlTeams: { [ID]: [storedAlpha(), storedBeta()] },
    currentUser: LECTURER,
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

  await page.goto(`/dashboard/${ORG}/${ID}`);
  const alphaRow = page.locator('tr', { hasText: 'Alpha' });
  await expect(alphaRow).toBeVisible();
  await alphaRow.getByRole('button', { name: /Manage/i }).click();
  await expect(page.locator('.modal.card', { hasText: 'Manage: Alpha' })).toBeVisible();
}

test.describe('48 - Moving a student between teams', () => {
  test('both manifests land in ONE commit, merged onto what was stored', async ({ page }) => {
    const captured = { blobs: [], trees: [], collab: [] };
    await openManageAlpha(page, captured);

    page.on('dialog', (d) => d.accept());
    const modal = page.locator('.modal.card', { hasText: 'Manage: Alpha' });
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select').selectOption('beta');
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

  test('repository access follows the student in both directions', async ({ page }) => {
    const captured = { blobs: [], trees: [], collab: [] };
    await openManageAlpha(page, captured);
    page.on('dialog', (d) => d.accept());

    const modal = page.locator('.modal.card', { hasText: 'Manage: Alpha' });
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select').selectOption('beta');
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
    await page.goto(`/dashboard/${ORG}/${ID}`);
    const alphaRow = page.locator('tr', { hasText: 'Alpha' });
    await alphaRow.getByRole('button', { name: /Manage/i }).click();

    const modal = page.locator('.modal.card', { hasText: 'Manage: Alpha' });
    const select = modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select');
    // Beta is at 3/3, so it must not be an option. With no destinations at all
    // the control is not rendered - an empty picker is not a control.
    if (await select.count()) {
      await expect(select.locator('option', { hasText: 'Beta' })).toHaveCount(0);
    }
  });
});
