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
});
