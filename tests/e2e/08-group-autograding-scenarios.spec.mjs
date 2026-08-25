import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// Scores reach the table by being JOINED from grading/<id>/summary.json, which
// is the only document that carries them. This suite used to put earned_points,
// ci_status, score and a per-test `tests[]` array straight into the `reports`
// fixture - a shape reports/<id>.json has never had, written by nothing. So it
// asserted against an imaginary file while the Score column on the real screen
// was empty for every assignment in every org.
//
// The per-test breakdown is gone from the Actions expectations for the same
// reason: a check run's annotations carry `Points X/Y` and a grand total, and
// nothing else. There is no `AssertionError` line to show, and claiming one
// would be inventing a grade breakdown.

const actionsSummary = {
  schema_version: 1,
  assignment_id: 'group-autograding-actions',
  generated_at: new Date().toISOString(),
  graded_by: LECTURER.login,
  runner: 'github_actions',
  students: [
    {
      login: STUDENT_1.login,
      earned_points: 30,
      total_points: 30,
      ci_status: 'success',
      ci_run_url: 'https://github.com/pxl/repo/actions/runs/1',
      score_source: 'annotation-json',
      graded_at: new Date().toISOString(),
    },
    {
      login: STUDENT_2.login,
      earned_points: 20,
      total_points: 30,
      ci_status: 'failure',
      ci_run_url: 'https://github.com/pxl/repo/actions/runs/2',
      score_source: 'annotation-json',
      graded_at: new Date().toISOString(),
    },
  ],
  failed: [],
};

function groupReport(assignmentId) {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    assignment_id: assignmentId,
    students: [
      {
        github_login: STUDENT_1.login,
        name: STUDENT_1.name,
        acceptance_state: 'accepted',
        submission_status: 'on_time',
        team_slug: 'team-full-pass',
        team_name: 'Team Full Pass',
      },
      {
        github_login: STUDENT_2.login,
        name: STUDENT_2.name,
        acceptance_state: 'accepted',
        submission_status: 'on_time',
        team_slug: 'team-partial-fail',
        team_name: 'Team Partial Fail',
        warnings: ['ci_failed'],
      },
    ],
    teams: [
      {
        team_slug: 'team-full-pass',
        team_name: 'Team Full Pass',
        members: [STUDENT_1.login],
        member_count: 1,
        max_members: 3,
        is_full: false,
      },
      {
        team_slug: 'team-partial-fail',
        team_name: 'Team Partial Fail',
        members: [STUDENT_2.login],
        member_count: 1,
        max_members: 3,
        is_full: false,
      },
    ],
  };
}

test.describe('08 - Autograding Scenarios: GitHub Actions & Docker Group Assignments', () => {
  test('Assignment 1 (GitHub Actions): Displays score pills and a drill-down that links to the grading run', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'group-autograding-actions': {
          id: 'group-autograding-actions',
          title: 'Group Python Analytics (Actions)',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          autograde: {
            enabled: true,
            execution_environment: 'github_actions',
            tests: [
              { id: 'test-basic', type: 'command', command: 'pytest tests/test_basic.py', points: 10 },
              { id: 'test-edge', type: 'command', command: 'pytest tests/test_edge.py', points: 10 },
              { id: 'test-scale', type: 'command', command: 'pytest tests/test_scale.py', points: 10 },
            ],
          },
          group_config: { max_team_size: 3, formation_mode: 'self-service' },
        },
      },
      reports: { 'group-autograding-actions': groupReport('group-autograding-actions') },
      gradingSummaries: { 'group-autograding-actions': actionsSummary },
    });

    await page.goto(`/dashboard/${ORG}/group-autograding-actions`);

    // 1. In Teams View: the Score and CI Status columns appear because grades
    //    exist, not because the assignment declares autograding.
    // Scoped to the teams table: the Autograder panel below it has a "CI status"
    // header of its own now that grades are on screen.
    const teamsTable = page.locator('.teams-table-component')
    await expect(teamsTable.locator('th', { hasText: 'CI Status' })).toBeVisible({ timeout: 10000 });
    await expect(teamsTable.locator('th', { hasText: 'Score' })).toBeVisible();

    // 2. The team score is the score of its repository - joined via its member.
    const teamFailBtn = page.locator('button', { hasText: '20/30 pts' }).first();
    await expect(teamFailBtn).toBeVisible();
    await teamFailBtn.click();

    // 3. The drill-down shows the score and the run, and does NOT invent a
    //    per-test breakdown the annotations cannot supply.
    const autogradeModal = page.locator('.autograde-modal');
    await expect(autogradeModal).toBeVisible();
    await expect(autogradeModal).toContainText('Team Autograding');
    await expect(autogradeModal).toContainText('Team Partial Fail');
    await expect(autogradeModal).toContainText('20 / 30 pts');
    await expect(autogradeModal).toContainText('failure');
    await expect(autogradeModal).toContainText('per-check breakdown is in the grading run');
    await expect(autogradeModal.locator('a', { hasText: 'Open the run' })).toHaveAttribute(
      'href',
      'https://github.com/pxl/repo/actions/runs/2',
    );

    await autogradeModal.locator('button', { hasText: 'Close' }).click();
    await expect(autogradeModal).not.toBeVisible();

    // 4. Students View carries the same joined score.
    const studentsTab = page.locator('.tab-pill', { hasText: /Students View/i });
    if (await studentsTab.isVisible()) {
      await studentsTab.click();
      const studentFailScore = page.locator('.col-score button', { hasText: '20/30 pts' }).first();
      await expect(studentFailScore).toBeVisible();
      await studentFailScore.click();
      await expect(page.locator('.autograde-modal')).toBeVisible();
      await expect(page.locator('.autograde-modal')).toContainText(STUDENT_2.login);
    }
  });

  test('Assignment 2 (Docker Runner): Displays sandboxed grading scores across teams', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'group-autograding-docker': {
          id: 'group-autograding-docker',
          title: 'Group Microservice (Docker)',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          autograde: {
            enabled: true,
            execution_environment: 'docker',
            tests: [
              { id: 'build', type: 'command', command: 'docker build .', points: 25 },
              { id: 'integration', type: 'command', command: 'pytest tests/', points: 25 },
            ],
          },
          group_config: { max_team_size: 3, formation_mode: 'self-service' },
        },
      },
      reports: { 'group-autograding-docker': groupReport('group-autograding-docker') },
      gradingSummaries: {
        'group-autograding-docker': {
          schema_version: 1,
          assignment_id: 'group-autograding-docker',
          generated_at: new Date().toISOString(),
          graded_by: LECTURER.login,
          runner: 'docker',
          students: [
            { login: STUDENT_1.login, earned_points: 50, total_points: 50, graded_at: new Date().toISOString() },
            { login: STUDENT_2.login, earned_points: 25, total_points: 50, graded_at: new Date().toISOString() },
          ],
          failed: [],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-autograding-docker`);

    await expect(page.locator('.teams-table-component th', { hasText: 'Score' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button', { hasText: '50/50 pts' }).first()).toBeVisible();
    await expect(page.locator('button', { hasText: '25/50 pts' }).first()).toBeVisible();

    // A locally-graded assignment offers the CLI, not a GitHub Actions read -
    // there are no check runs to read.
    await expect(page.locator('.autograde-banner')).toContainText('pxl-classroom grade');
  });
});
