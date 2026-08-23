import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// Carrying groups forward from one assignment to the next: the lecturer seeds
// teams from a previous grouping, and the student confirms the group they
// already worked in instead of forming a new one.
//
// The blocking cases matter more than the happy path. A seed that writes the
// wrong thing is worse than one that refuses: colliding repository patterns
// hand students last assignment's locked-down repository, and a login written
// into two team files makes acceptance pick one at random.

const PREV = 'linux-processes-2026';
const NEXT = 'linux-networking-2026';

function groupAssignment(id, overrides = {}) {
  return {
    id,
    title: id === PREV ? 'Linux Processes' : 'Linux Networking',
    organization: ORG,
    state: 'published',
    assignment_type: 'group',
    opens_at: '2026-01-01T00:00:00Z',
    deadline_at: '2099-01-01T00:00:00Z',
    repository_name_pattern: `${id}-{team_slug}`,
    template: { owner: ORG, repository: 'group-template' },
    group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
    ...overrides,
  };
}

function controlTeam(assignmentId, slug, name, members, extra = {}) {
  return {
    schema_version: 1,
    assignment_id: assignmentId,
    team_slug: slug,
    team_name: name,
    members,
    max_members: 3,
    created_at: '2026-02-01T09:00:00Z',
    created_by: members[0],
    ...extra,
  };
}

function emptyReport(assignmentId, { students = [], teams = [] } = {}) {
  return {
    schema_version: 1,
    assignment_id: assignmentId,
    assignment_title: 'Linux Networking',
    org: ORG,
    generated_at: new Date().toISOString(),
    students,
    teams,
  };
}

/** Open the assignment detail page's Teams tab and the seed modal. */
async function openSeedModal(page, assignmentId) {
  await page.goto(`/dashboard/${ORG}/${assignmentId}`);
  const teamsTab = page.locator('.tab-pill', { hasText: /Teams View/i });
  await expect(teamsTab).toBeVisible({ timeout: 15000 });
  await teamsTab.click();
  await page.locator('button', { hasText: 'Seed teams' }).first().click();
  await expect(page.locator('.seed-modal')).toBeVisible();
}

test.describe('26 - Carrying groups forward between assignments', () => {
  // -------------------------------------------------------------- lecturer --

  test('Happy path: previous grouping is previewed, then written in one commit and republished', async ({ page }) => {
    const gitCommits = [];
    const workflowDispatches = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      workflowDispatches,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        [PREV]: [
          controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login, STUDENT_2.login]),
          controlTeam(PREV, 'beta', 'Beta Team', ['carol']),
        ],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);

    // Preview: the plan, before anything is written.
    await expect(page.locator('.seed-summary')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.seed-summary')).toContainText('2');
    await expect(page.locator('.seed-preview-row')).toHaveCount(2);
    await expect(page.locator('.seed-preview-row').first()).toContainText('Alpha Team');
    await expect(page.locator('.seed-preview-row').first()).toContainText(`@${STUDENT_1.login}`);
    expect(gitCommits).toHaveLength(0);

    await page.locator('.modal-foot button', { hasText: /Seed 2 team/ }).click();
    await expect(page.locator('.seed-modal')).toBeHidden({ timeout: 10000 });

    // One commit, both files, target assignment id rewritten.
    expect(gitCommits).toHaveLength(1);
    expect(gitCommits[0].files.map((f) => f.path).sort()).toEqual([
      `teams/${NEXT}/alpha.json`,
      `teams/${NEXT}/beta.json`,
    ]);
    const alpha = JSON.parse(gitCommits[0].files.find((f) => f.path.endsWith('alpha.json')).content);
    expect(alpha.assignment_id).toBe(NEXT);
    expect(alpha.members).toEqual([STUDENT_1.login, STUDENT_2.login]);
    expect(alpha.seeded_from.assignment_id).toBe(PREV);
    expect(alpha.repo_url).toBeUndefined();

    // Students read the generated public file, so the seed must republish.
    expect(workflowDispatches.some((d) => d.workflow === 'regenerate-dashboard.yml')).toBe(true);
  });

  test('Blocked: a team larger than the target maximum refuses the whole seed', async ({ page }) => {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: {
        [PREV]: groupAssignment(PREV),
        [NEXT]: groupAssignment(NEXT, { group_config: { max_team_size: 2, formation_mode: 'self-service' } }),
      },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login, STUDENT_2.login, 'carol'])],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);

    await expect(page.locator('.seed-banner-danger')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.seed-banner-danger')).toContainText('maximum team size (2)');
    await expect(page.locator('.seed-banner-danger')).toContainText('alpha (3)');
    await expect(page.locator('.modal-foot .btn-primary')).toBeDisabled();
    expect(gitCommits).toHaveLength(0);
  });

  test('Blocked: a shared repository name pattern would hand over the old repositories', async ({ page }) => {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: {
        [PREV]: groupAssignment(PREV),
        // Same pattern as PREV: provisioning is idempotent on repo existence,
        // so every team would be handed the previous assignment's repository.
        [NEXT]: groupAssignment(NEXT, { repository_name_pattern: `${PREV}-{team_slug}` }),
      },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: { [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login])] },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);

    await expect(page.locator('.seed-banner-danger')).toContainText('share the repository name pattern', { timeout: 10000 });
    await expect(page.locator('.modal-foot .btn-primary')).toBeDisabled();
    expect(gitCommits).toHaveLength(0);
  });

  test('Blocked: a repository pattern without {team_slug} refuses the seed', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        [PREV]: groupAssignment(PREV),
        [NEXT]: groupAssignment(NEXT, { repository_name_pattern: `${NEXT}-{github_login}` }),
      },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: { [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login])] },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-banner-danger')).toContainText('{team_slug}', { timeout: 10000 });
  });

  test('Blocked: a source assignment with no populated teams', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        [PREV]: [controlTeam(PREV, 'ghost', 'Ghost Team', [], { vacant: true })],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-banner-danger')).toContainText('no teams with members', { timeout: 10000 });
  });

  test('Existing student-formed team is kept, and a member it already holds is not re-seeded', async ({ page }) => {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        [PREV]: [
          controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login, STUDENT_2.login]),
          controlTeam(PREV, 'beta', 'Beta Team', ['carol']),
        ],
        // Students already started forming teams in the target.
        [NEXT]: [controlTeam(NEXT, 'alpha', 'Alpha (already formed)', ['zoe'])],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);

    await expect(page.locator('.seed-banner-warn')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.seed-banner-warn')).toContainText('already exist with members');
    // Only beta is planned; alpha belongs to the students who formed it.
    await expect(page.locator('.seed-preview-row')).toHaveCount(1);
    await expect(page.locator('.seed-preview-row')).toContainText('Beta Team');

    await page.locator('.modal-foot .btn-primary').click();
    await expect(page.locator('.seed-modal')).toBeHidden({ timeout: 10000 });
    expect(gitCommits[0].files.map((f) => f.path)).toEqual([`teams/${NEXT}/beta.json`]);
  });

  test('A login is never written into two teams of the same assignment', async ({ page }) => {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login, STUDENT_2.login])],
        // STUDENT_2 has already joined a different team in the target.
        [NEXT]: [controlTeam(NEXT, 'gamma', 'Gamma Team', [STUDENT_2.login])],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);

    await expect(page.locator('.seed-banner-warn')).toContainText('already belong to another team', { timeout: 10000 });
    await page.locator('.modal-foot .btn-primary').click();
    await expect(page.locator('.seed-modal')).toBeHidden({ timeout: 10000 });

    const alpha = JSON.parse(gitCommits[0].files[0].content);
    expect(alpha.members).toEqual([STUDENT_1.login]);
  });

  test('Warns about carried-over students who are no longer on the roster', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      roster: [{ student_number: '1', full_name: 'Student One', github_login: STUDENT_1.login }],
      controlTeams: {
        [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login, 'graduated-student'])],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-banner-warn')).toContainText('not on the roster', { timeout: 10000 });
    await expect(page.locator('.seed-banner-warn')).toContainText('@graduated-student');
    // A warning does not block: the seed is still applicable.
    await expect(page.locator('.modal-foot .btn-primary')).toBeEnabled();
  });

  test('Roster team columns work as a source when no previous assignment exists', async ({ page }) => {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      roster: [
        { student_number: '1', full_name: 'Student One', github_login: STUDENT_1.login, team_slug: 'lab-pair-1', team_name: 'Lab Pair 1' },
        { student_number: '2', full_name: 'Student Two', github_login: STUDENT_2.login, team_slug: 'lab-pair-1' },
        { student_number: '3', full_name: 'Carol', github_login: 'carol', team_slug: 'lab-pair-2', team_name: 'Lab Pair 2' },
        { student_number: '4', full_name: 'Ungrouped', github_login: 'dave' },
      ],
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption('roster');

    await expect(page.locator('.seed-preview-row')).toHaveCount(2, { timeout: 10000 });
    await page.locator('.modal-foot .btn-primary').click();
    await expect(page.locator('.seed-modal')).toBeHidden({ timeout: 10000 });

    const pair1 = JSON.parse(gitCommits[0].files.find((f) => f.path.includes('lab-pair-1')).content);
    expect(pair1.members).toEqual([STUDENT_1.login, STUDENT_2.login]);
    expect(pair1.seeded_from.source).toBe('roster');
    expect(pair1.seeded_from.assignment_id).toBeUndefined();
  });

  test('Teams tab shows the provenance line and flags members who have not accepted', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      reports: {
        [NEXT]: emptyReport(NEXT, {
          students: [
            { github_login: STUDENT_1.login, acceptance_state: 'accepted', team_slug: 'alpha', submission_status: 'no-submission' },
            { github_login: STUDENT_2.login, acceptance_state: 'not-accepted', team_slug: 'alpha', submission_status: 'no-submission' },
          ],
          teams: [
            {
              team_slug: 'alpha',
              team_name: 'Alpha Team',
              members: [STUDENT_1.login, STUDENT_2.login],
              submission_status: 'no-submission',
              seeded_from: { source: 'assignment', assignment_id: PREV, assignment_title: 'Linux Processes' },
            },
          ],
        }),
      },
    });

    await page.goto(`/dashboard/${ORG}/${NEXT}`);
    await page.locator('.tab-pill', { hasText: /Teams View/i }).click();

    await expect(page.locator('.seeded-note')).toContainText('carried over from Linux Processes');
    await expect(page.locator('.member-pending-note')).toContainText('1 not accepted yet');
    await expect(page.locator('.member-pill.member-pending')).toHaveCount(1);
    await expect(page.locator('.member-pill.member-pending')).toContainText(STUDENT_2.login);
  });

  test('A draft assignment shows its seeded teams for review before publishing', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      // Draft: no interim report is ever generated for one, so the Teams tab has
      // to read the manifests directly or "seed, review, publish" reviews nothing.
      assignments: { [NEXT]: groupAssignment(NEXT, { state: 'draft' }) },
      controlTeams: {
        [NEXT]: [
          controlTeam(NEXT, 'alpha', 'Alpha Team', [STUDENT_1.login, STUDENT_2.login], {
            seeded_from: { source: 'assignment', assignment_id: PREV, assignment_title: 'Linux Processes', seeded_at: '2026-09-01T10:00:00Z' },
          }),
          controlTeam(NEXT, 'beta', 'Beta Team', ['carol'], {
            seeded_from: { source: 'assignment', assignment_id: PREV, assignment_title: 'Linux Processes', seeded_at: '2026-09-01T10:00:00Z' },
          }),
        ],
      },
    });

    await page.goto(`/dashboard/${ORG}/${NEXT}`);
    await page.locator('.tab-pill', { hasText: /Teams View/i }).click();

    await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
    await expect(page.locator('.seeded-note').first()).toContainText('carried over from Linux Processes');
    await expect(page.locator('.seeded-note').nth(1)).toContainText('students cannot see these teams until');
  });

  test('A team seeded after the last report still appears in the Teams tab', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      // The report knows about one team; a second was seeded seconds ago and the
      // dashboard regeneration has not landed yet.
      reports: {
        [NEXT]: emptyReport(NEXT, {
          teams: [{ team_slug: 'alpha', team_name: 'Alpha Team', members: [STUDENT_1.login], submission_status: 'on-time' }],
        }),
      },
      controlTeams: {
        [NEXT]: [
          controlTeam(NEXT, 'alpha', 'Alpha Team', [STUDENT_1.login]),
          controlTeam(NEXT, 'gamma', 'Gamma Team', ['carol', 'dave']),
        ],
      },
    });

    await page.goto(`/dashboard/${ORG}/${NEXT}`);
    await page.locator('.tab-pill', { hasText: /Teams View/i }).click();

    await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
    await expect(page.locator('.data-table')).toContainText('Gamma Team');
    // The report's own row keeps its computed status; the merged one is neutral.
    await expect(page.locator('tr', { hasText: 'Gamma Team' })).toContainText('no-submission');
  });

  test('An assignment with no teams offers seeding from its empty state', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
    });

    await page.goto(`/dashboard/${ORG}/${NEXT}`);
    await page.locator('.tab-pill', { hasText: /Teams View/i }).click();
    await expect(page.locator('.empty-state')).toContainText('Seed teams from a previous assignment');
  });

  test('Admin form: seeding waits for the first save, and the fallback toggle is pre-assigned only', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [PREV]: groupAssignment(PREV) },
    });

    await page.goto(`/dashboard/${ORG}/admin?new=1`);
    await page.locator('input[type="radio"][value="group"]').check();

    const seedBtn = page.locator('button', { hasText: 'Seed teams from…' });
    await expect(seedBtn).toBeDisabled();
    await expect(page.locator('text=Save this assignment first')).toBeVisible();

    // The fallback only means anything when the lecturer owns the grouping.
    await expect(page.locator('text=Let students with no assigned team form their own')).toBeHidden();
    await page.locator('select').filter({ hasText: /Formation Mode|Self-Service/ }).first().selectOption('pre-assigned');
    await expect(page.locator('text=Let students with no assigned team form their own')).toBeVisible();
  });

  // --------------------------------------------------------------- student --

  test('A carried-over group is offered for confirmation, with its provenance', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      teams: {
        [NEXT]: [
          {
            team_slug: 'alpha',
            team_name: 'Alpha Team',
            members: [STUDENT_1.login, STUDENT_2.login],
            member_count: 2,
            max_members: 3,
            is_full: false,
            seeded_from: { source: 'assignment', assignment_id: PREV, assignment_title: 'Linux Processes' },
          },
        ],
      },
    });

    await page.goto(`/${ORG}/a/${NEXT}`);
    const card = page.locator('.preassigned-flow');
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText('Your group: Alpha Team');
    await expect(card).toContainText('Carried over from');
    await expect(card).toContainText('Linux Processes');
    await expect(card.locator('.member-chip')).toHaveCount(2);
    await expect(card.locator('button', { hasText: 'Accept & Join Team' })).toBeEnabled();
  });

  test('A full carried-over group is still confirmable by its own members', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      teams: {
        [NEXT]: [
          {
            team_slug: 'alpha',
            team_name: 'Alpha Team',
            members: [STUDENT_1.login, STUDENT_2.login, 'carol'],
            member_count: 3,
            max_members: 3,
            is_full: true,
            seeded_from: { source: 'assignment', assignment_id: PREV, assignment_title: 'Linux Processes' },
          },
        ],
      },
    });

    await page.goto(`/${ORG}/a/${NEXT}`);
    // The hero confirms it…
    await expect(page.locator('.preassigned-flow button', { hasText: 'Accept & Join Team' })).toBeEnabled({ timeout: 15000 });

    // …and so does the list, once they go looking at the alternatives.
    await page.locator('button', { hasText: 'Choose a different group' }).click();
    const ownCard = page.locator('.team-item-card', { hasText: 'Alpha Team' });
    await expect(ownCard.locator('button', { hasText: 'My group' })).toBeEnabled();
  });

  test('A full group the student does not belong to stays closed', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      teams: {
        [NEXT]: [
          {
            team_slug: 'beta',
            team_name: 'Beta Team',
            members: ['carol', 'dave', 'erin'],
            member_count: 3,
            max_members: 3,
            is_full: true,
          },
        ],
      },
    });

    await page.goto(`/${ORG}/a/${NEXT}`);
    const betaCard = page.locator('.team-item-card', { hasText: 'Beta Team' });
    await expect(betaCard.locator('button', { hasText: 'Full' })).toBeDisabled({ timeout: 15000 });
  });

  test('Switching away from a carried-over group, and back again', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      teams: {
        [NEXT]: [
          { team_slug: 'alpha', team_name: 'Alpha Team', members: [STUDENT_1.login], member_count: 1, max_members: 3, is_full: false, seeded_from: { source: 'assignment', assignment_id: PREV } },
          { team_slug: 'beta', team_name: 'Beta Team', members: ['carol'], member_count: 1, max_members: 3, is_full: false },
        ],
      },
    });

    await page.goto(`/${ORG}/a/${NEXT}`);
    await page.locator('button', { hasText: 'Choose a different group' }).click();

    await expect(page.locator('.team-item-card', { hasText: 'Beta Team' })).toBeVisible();
    await page.locator('button', { hasText: /Back to my group/ }).click();
    await expect(page.locator('.preassigned-flow')).toContainText('Alpha Team');
  });

  test('Pre-assigned groups cannot be swapped by the student', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        [NEXT]: groupAssignment(NEXT, {
          group_config: { max_team_size: 3, formation_mode: 'pre-assigned' },
        }),
      },
      teams: {
        [NEXT]: [
          { team_slug: 'exam-pair-1', team_name: 'Exam Pair 1', members: [STUDENT_1.login], member_count: 1, max_members: 3, is_full: false },
        ],
      },
    });

    await page.goto(`/${ORG}/a/${NEXT}`);
    await expect(page.locator('.preassigned-flow')).toContainText('Pre-Assigned Team: Exam Pair 1', { timeout: 15000 });
    await expect(page.locator('button', { hasText: 'Choose a different group' })).toHaveCount(0);
  });

  test('Unassigned under pre-assigned: blocked by default', async ({ page }) => {
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: {
        [NEXT]: groupAssignment(NEXT, {
          group_config: { max_team_size: 3, formation_mode: 'pre-assigned' },
        }),
      },
      teams: { [NEXT]: [{ team_slug: 'exam-pair-1', team_name: 'Exam Pair 1', members: [STUDENT_1.login], member_count: 1, max_members: 3, is_full: false }] },
    });

    await page.goto(`/${ORG}/a/${NEXT}`);
    await expect(page.locator('.preassigned-flow')).toContainText('No Pre-Assigned Team', { timeout: 15000 });
    await expect(page.locator('.tab-pill', { hasText: /Join Existing Team/ })).toHaveCount(0);
  });

  test('Unassigned under pre-assigned: the fallback lets a late enroller self-enrol', async ({ page }) => {
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: {
        [NEXT]: groupAssignment(NEXT, {
          group_config: {
            max_team_size: 3,
            formation_mode: 'pre-assigned',
            unassigned_fallback: 'self-service',
            allow_team_creation: true,
          },
        }),
      },
      teams: { [NEXT]: [{ team_slug: 'exam-pair-1', team_name: 'Exam Pair 1', members: [STUDENT_1.login], member_count: 1, max_members: 3, is_full: false }] },
    });

    await page.goto(`/${ORG}/a/${NEXT}`);
    await expect(page.locator('.tab-pill', { hasText: /Join Existing Team/ })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=No Pre-Assigned Team')).toHaveCount(0);
  });

  test('An assigned student is unaffected by the fallback being open', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        [NEXT]: groupAssignment(NEXT, {
          group_config: {
            max_team_size: 3,
            formation_mode: 'pre-assigned',
            unassigned_fallback: 'self-service',
          },
        }),
      },
      teams: { [NEXT]: [{ team_slug: 'exam-pair-1', team_name: 'Exam Pair 1', members: [STUDENT_1.login], member_count: 1, max_members: 3, is_full: false }] },
    });

    await page.goto(`/${ORG}/a/${NEXT}`);
    await expect(page.locator('.preassigned-flow')).toContainText('Exam Pair 1', { timeout: 15000 });
    await expect(page.locator('button', { hasText: 'Choose a different group' })).toHaveCount(0);
  });

  // ------------------------------------------------------------ undo a seed --
  //
  // A bulk write needs a bulk undo: deleting 33 teams one at a time is ~100
  // clicks, and deleteVacantTeam refuses any team that still has members.

  /** Open the Teams tab, answering the next window.confirm. */
  async function openTeamsTab(page, assignmentId, { acceptConfirm = true } = {}) {
    page.on('dialog', (d) => (acceptConfirm ? d.accept() : d.dismiss()));
    await page.goto(`/dashboard/${ORG}/${assignmentId}`);
    await page.locator('.tab-pill', { hasText: /Teams View/i }).click();
    await page.waitForTimeout(300);
  }

  const SEEDED = { source: 'assignment', assignment_id: PREV, assignment_title: 'Linux Processes', seeded_at: '2026-09-01T10:00:00Z' };

  function seededReportTeam(slug, name, members, extra = {}) {
    return {
      team_slug: slug,
      team_name: name,
      members,
      submission_status: 'no-submission',
      seeded_from: SEEDED,
      ...extra,
    };
  }

  test('Undo removes every carried-over team of a draft in one commit', async ({ page }) => {
    const gitCommits = [];
    const workflowDispatches = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      workflowDispatches,
      assignments: { [NEXT]: groupAssignment(NEXT, { state: 'draft' }) },
      controlTeams: {
        [NEXT]: [
          controlTeam(NEXT, 'alpha', 'Alpha Team', [STUDENT_1.login], { seeded_from: SEEDED }),
          controlTeam(NEXT, 'beta', 'Beta Team', ['carol'], { seeded_from: SEEDED }),
        ],
      },
    });

    await openTeamsTab(page, NEXT);
    const undo = page.locator('button', { hasText: /Undo seed/ });
    await expect(undo).toContainText('Undo seed (2)');
    await undo.click();
    await expect.poll(() => gitCommits.length, { timeout: 10000 }).toBe(1);

    // A multi-file DELETE: one commit, null content per path.
    expect(gitCommits[0].files.map((f) => f.path).sort()).toEqual([
      `teams/${NEXT}/alpha.json`,
      `teams/${NEXT}/beta.json`,
    ]);
    expect(gitCommits[0].files.every((f) => f.content === null)).toBe(true);
    expect(workflowDispatches.some((d) => d.workflow === 'regenerate-dashboard.yml')).toBe(true);
  });

  test('Undo keeps a carried-over team a student has already accepted into', async ({ page }) => {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      reports: {
        [NEXT]: emptyReport(NEXT, {
          students: [
            { github_login: STUDENT_1.login, acceptance_state: 'accepted', team_slug: 'alpha' },
            { github_login: 'carol', acceptance_state: 'not-accepted', team_slug: 'beta' },
          ],
          teams: [
            seededReportTeam('alpha', 'Alpha Team', [STUDENT_1.login]),
            seededReportTeam('beta', 'Beta Team', ['carol']),
          ],
        }),
      },
    });

    await openTeamsTab(page, NEXT);
    await expect(page.locator('button', { hasText: /Undo seed/ })).toContainText('Undo seed (1)');
    await page.locator('button', { hasText: /Undo seed/ }).click();
    await expect.poll(() => gitCommits.length, { timeout: 10000 }).toBe(1);
    expect(gitCommits[0].files.map((f) => f.path)).toEqual([`teams/${NEXT}/beta.json`]);
  });

  test('Undo never touches a team that already has a repository', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      reports: {
        [NEXT]: emptyReport(NEXT, {
          students: [{ github_login: 'zoe', acceptance_state: 'not-accepted' }],
          teams: [
            seededReportTeam('alpha', 'Alpha Team', [STUDENT_1.login], {
              repo_url: `https://github.com/${ORG}/${NEXT}-alpha`,
              repo_name: `${ORG}/${NEXT}-alpha`,
            }),
          ],
        }),
      },
    });

    await openTeamsTab(page, NEXT);
    await expect(page.locator('button', { hasText: /Undo seed/ })).toHaveCount(0);
  });

  test('Undo is absent when the teams were formed by students', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      reports: {
        [NEXT]: emptyReport(NEXT, {
          teams: [{ team_slug: 'self', team_name: 'Self Made', members: ['carol'], submission_status: 'no-submission' }],
        }),
      },
    });

    await openTeamsTab(page, NEXT);
    await expect(page.locator('button', { hasText: /Undo seed/ })).toHaveCount(0);
    await expect(page.locator('.seeded-note', { hasText: 'carried over' })).toHaveCount(0);
  });

  test('Dismissing the undo confirmation writes nothing', async ({ page }) => {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: { [NEXT]: groupAssignment(NEXT, { state: 'draft' }) },
      controlTeams: {
        [NEXT]: [controlTeam(NEXT, 'alpha', 'Alpha Team', [STUDENT_1.login], { seeded_from: SEEDED })],
      },
    });

    await openTeamsTab(page, NEXT, { acceptConfirm: false });
    await page.locator('button', { hasText: /Undo seed/ }).click();
    await page.waitForTimeout(600);
    expect(gitCommits).toHaveLength(0);
    await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  });

  // -------------------------------------------------- unplaced students -----

  test('The Teams tab names roster students who have no team', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      roster: [
        { student_number: '1', full_name: 'One', github_login: STUDENT_1.login },
        { student_number: '2', full_name: 'Two', github_login: STUDENT_2.login },
        { student_number: '3', full_name: 'Three', github_login: 'carol' },
      ],
      reports: {
        [NEXT]: emptyReport(NEXT, {
          teams: [{ team_slug: 'alpha', team_name: 'Alpha Team', members: [STUDENT_1.login], submission_status: 'no-submission' }],
        }),
      },
    });

    await openTeamsTab(page, NEXT);
    const note = page.locator('.seeded-note', { hasText: 'no team' });
    await expect(note).toContainText('2 students on the roster have no team');
    await expect(note).toContainText(`@${STUDENT_2.login}`);
    await expect(note).toContainText('@carol');
  });

  test('No unplaced line once every roster student has a team', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      roster: [{ student_number: '1', full_name: 'One', github_login: STUDENT_1.login }],
      reports: {
        [NEXT]: emptyReport(NEXT, {
          teams: [{ team_slug: 'alpha', team_name: 'Alpha Team', members: [STUDENT_1.login], submission_status: 'no-submission' }],
        }),
      },
    });

    await openTeamsTab(page, NEXT);
    await expect(page.locator('.seeded-note', { hasText: 'no team' })).toHaveCount(0);
  });

  test('A long unplaced list is truncated rather than flooding the tab', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      roster: Array.from({ length: 20 }, (_, i) => ({
        student_number: String(i), full_name: `S${i}`, github_login: `student${i}`,
      })),
      reports: { [NEXT]: emptyReport(NEXT, { teams: [] }) },
    });

    await openTeamsTab(page, NEXT);
    const note = page.locator('.seeded-note', { hasText: 'no team' });
    await expect(note).toContainText('20 students on the roster have no team');
    await expect(note).toContainText('and 12 more');
  });

  test('The seed plan counts and names the students it will not place', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      roster: [
        { student_number: '1', full_name: 'One', github_login: STUDENT_1.login },
        { student_number: '2', full_name: 'Two', github_login: STUDENT_2.login },
        { student_number: '3', full_name: 'Latecomer', github_login: 'late-joiner' },
      ],
      controlTeams: {
        [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login, STUDENT_2.login])],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);

    await expect(page.locator('.seed-summary')).toContainText('still without a team', { timeout: 10000 });
    await expect(page.locator('.seed-banner-warn')).toContainText('will still have no team');
    await expect(page.locator('.seed-banner-warn')).toContainText('@late-joiner');
    // Not a blocker - the seed is still worth applying.
    await expect(page.locator('.modal-foot .btn-primary')).toBeEnabled();
  });

  test('A kept team names the students it strands', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login, STUDENT_2.login])],
        [NEXT]: [controlTeam(NEXT, 'alpha', 'Alpha (student-formed)', ['zoe'])],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-banner-warn')).toContainText('were therefore not placed', { timeout: 10000 });
    await expect(page.locator('.seed-banner-warn')).toContainText(`@${STUDENT_1.login}`);
  });

  test('A draft does not mark every member as "not accepted yet"', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT, { state: 'draft' }) },
      controlTeams: {
        [NEXT]: [controlTeam(NEXT, 'alpha', 'Alpha Team', [STUDENT_1.login, STUDENT_2.login])],
      },
    });

    await openTeamsTab(page, NEXT);
    await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
    await expect(page.locator('.member-pending')).toHaveCount(0);
    await expect(page.locator('.member-pending-note')).toHaveCount(0);
    await expect(page.locator('.seeded-note', { hasText: 'cannot see these teams' })).toBeVisible();
  });

  // ------------------------------------------------- the modal's own edges --

  test('Switching source mid-read never leaves the previous source on screen', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        [PREV]: groupAssignment(PREV),
        slow: groupAssignment('slow'),
        [NEXT]: groupAssignment(NEXT),
      },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        slow: [controlTeam('slow', 'slowpoke', 'Slowpoke Team', ['zoe'])],
        [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login])],
      },
    });

    // Make the first source answer last. Registered after the fixture, so it
    // wins, and falls through to it once the delay has elapsed.
    await page.route(
      (url) => url.href.includes(`/contents/teams/slow`),
      async (route) => {
        await new Promise((r) => setTimeout(r, 2500));
        await route.fallback();
      }
    );

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption('assignment:slow');
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);

    await expect(page.locator('.seed-preview-row')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('.seed-preview-row')).toContainText('Alpha Team');

    // The slow read lands well after; it must not repaint the preview.
    await page.waitForTimeout(3000);
    await expect(page.locator('.seed-preview-row')).toContainText('Alpha Team');
    await expect(page.locator('.seed-preview-row')).toHaveCount(1);
    await expect(page.locator('.seed-status')).toHaveCount(0);
  });

  test('A target that changed while you were reviewing blocks the write', async ({ page }) => {
    const gitCommits = [];
    let reads = 0;
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: { [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login])] },
    });

    // The second read of the source team - the one apply() makes - sees a
    // membership that moved underneath the preview.
    await page.route(
      (url) => url.href.includes(`/contents/teams/${PREV}/alpha.json`),
      async (route) => {
        reads += 1;
        const members = reads === 1 ? [STUDENT_1.login] : [STUDENT_1.login, STUDENT_2.login];
        const doc = controlTeam(PREV, 'alpha', 'Alpha Team', members);
        await route.fulfill({
          status: 200,
          body: JSON.stringify({
            content: Buffer.from(JSON.stringify(doc)).toString('base64'),
            encoding: 'base64',
            sha: 'x',
          }),
        });
      }
    );

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-preview-row')).toHaveCount(1, { timeout: 10000 });

    await page.locator('.modal-foot .btn-primary').click();

    // Nothing written, modal still open, plan re-rendered with the new truth.
    await expect(page.locator('.toast-warning')).toContainText('changed while you were reviewing', { timeout: 10000 });
    expect(gitCommits).toHaveLength(0);
    await expect(page.locator('.seed-modal')).toBeVisible();
    await expect(page.locator('.seed-preview-row')).toContainText(`@${STUDENT_2.login}`);

    // Applying the plan now on screen goes through.
    await page.locator('.modal-foot .btn-primary').click();
    await expect.poll(() => gitCommits.length, { timeout: 10000 }).toBe(1);
  });

  test('A failed dashboard regeneration is reported, not swallowed', async ({ page }) => {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      gitCommits,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: { [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login])] },
    });

    await page.route(
      (url) => url.href.includes('regenerate-dashboard.yml/dispatches'),
      async (route) => {
        await route.fulfill({
          status: 403,
          body: JSON.stringify({ message: 'Resource not accessible by integration' }),
        });
      }
    );

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-preview-row')).toHaveCount(1, { timeout: 10000 });
    await page.locator('.modal-foot .btn-primary').click();

    // The teams WERE written - saying "seeded" alone would be a lie about what
    // students can see.
    await expect.poll(() => gitCommits.length, { timeout: 10000 }).toBe(1);
    const toastEl = page.locator('.toast-error');
    await expect(toastEl).toContainText('publishing them to students failed');
    await expect(toastEl).toContainText('actions:write');
    await expect(toastEl.locator('a')).toHaveAttribute('href', /regenerate-dashboard\.yml/);
    await expect(page.locator('.toast-success')).toHaveCount(0);
  });

  test('Escape closes the modal, and the source select takes focus', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
    });

    await openSeedModal(page, NEXT);
    await expect(page.locator('#seed-source')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.seed-modal')).toHaveCount(0);
  });

  test('Skipped teams are explained rather than left as a bare count', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        [PREV]: [
          controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login]),
          controlTeam(PREV, 'gone', 'Gone Team', ['zoe'], { vacant: true }),
          controlTeam(PREV, 'empty', 'Empty Team', []),
        ],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-summary')).toContainText('skipped', { timeout: 10000 });
    const footnote = page.locator('.seed-footnote', { hasText: 'Skipped 2' });
    await expect(footnote).toContainText('gone (already empty in the source)');
    await expect(footnote).toContainText('empty (had no members)');
  });

  test('Re-seeding the same source offers nothing and cannot be applied', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login])],
        [NEXT]: [controlTeam(NEXT, 'alpha', 'Alpha Team', [STUDENT_1.login])],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-footnote', { hasText: 'Nothing left to seed' })).toBeVisible({ timeout: 10000 });
    const apply = page.locator('.modal-foot .btn-primary');
    await expect(apply).toContainText('Nothing to seed');
    await expect(apply).toBeDisabled();
  });

  test('Seeding from the assignment editor raises exactly one toast', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      controlTeams: { [PREV]: [controlTeam(PREV, 'alpha', 'Alpha Team', [STUDENT_1.login])] },
    });

    await page.goto(`/dashboard/${ORG}/admin?edit=${NEXT}`);
    const seedBtn = page.locator('button', { hasText: 'Seed teams from…' });
    await expect(seedBtn).toBeEnabled({ timeout: 15000 });
    await seedBtn.click();

    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-preview-row')).toHaveCount(1, { timeout: 10000 });
    await page.locator('.modal-foot .btn-primary').click();

    await expect(page.locator('.toast-success')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('.toast-success')).toContainText('Seeded 1 team');
  });

  test('The modal fits a phone without scrolling sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [PREV]: groupAssignment(PREV), [NEXT]: groupAssignment(NEXT) },
      reports: { [NEXT]: emptyReport(NEXT) },
      controlTeams: {
        [PREV]: [
          controlTeam(PREV, 'a-very-long-team-slug-for-testing', 'A Very Long Team Name For Testing', [
            'student-with-a-long-login-one',
            'student-with-a-long-login-two',
            'student-with-a-long-login-three',
          ]),
        ],
      },
    });

    await openSeedModal(page, NEXT);
    await page.locator('#seed-source').selectOption(`assignment:${PREV}`);
    await expect(page.locator('.seed-preview-row')).toHaveCount(1, { timeout: 10000 });

    const overflow = await page.evaluate(() => {
      const modal = document.querySelector('.seed-modal');
      const row = document.querySelector('.seed-preview-row');
      return {
        modal: modal.scrollWidth - modal.clientWidth,
        modalRight: Math.round(modal.getBoundingClientRect().right),
        row: row.scrollWidth - row.clientWidth,
        viewport: window.innerWidth,
      };
    });
    expect(overflow.modal).toBeLessThanOrEqual(1);
    expect(overflow.row).toBeLessThanOrEqual(1);
    expect(overflow.modalRight).toBeLessThanOrEqual(overflow.viewport);
  });
});
