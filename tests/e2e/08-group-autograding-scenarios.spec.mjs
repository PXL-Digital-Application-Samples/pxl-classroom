import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

test.describe('08 - Autograding Scenarios: GitHub Actions & Docker Group Assignments', () => {
  test('Assignment 1 (GitHub Actions): Displays green success (30/30) vs red failure (20/30) CI badges', async ({ page }) => {
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
            points_possible: 30,
          },
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
          },
        },
      },
      reports: {
        'group-autograding-actions': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'group-autograding-actions',
          students: [
            {
              github_login: STUDENT_1.login,
              name: STUDENT_1.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              team_slug: 'team-full-pass',
              team_name: 'Team Full Pass',
              ci_status: 'success',
              earned_points: 30,
              total_points: 30,
            },
            {
              github_login: STUDENT_2.login,
              name: STUDENT_2.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              team_slug: 'team-partial-fail',
              team_name: 'Team Partial Fail',
              ci_status: 'failure',
              earned_points: 20,
              total_points: 30,
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
              ci_status: 'success',
              score: '30/30',
            },
            {
              team_slug: 'team-partial-fail',
              team_name: 'Team Partial Fail',
              members: [STUDENT_2.login],
              member_count: 1,
              max_members: 3,
              is_full: false,
              ci_status: 'failure',
              score: '20/30',
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-autograding-actions`);

    // Verify CI Status column header
    const ciHeader = page.locator('th', { hasText: 'CI Status' });
    await expect(ciHeader).toBeVisible({ timeout: 10000 });

    // Verify Team 1 (Passing Student 1) badge
    const student1Row = page.locator('tr, .student-row, article', { hasText: STUDENT_1.login });
    await expect(student1Row.first()).toBeVisible();
    await expect(student1Row.locator('.badge-success', { hasText: 'success' })).toBeVisible();

    // Verify Team 2 (Failing Student 2) badge
    const student2Row = page.locator('tr, .student-row, article', { hasText: STUDENT_2.login });
    await expect(student2Row.first()).toBeVisible();
    await expect(student2Row.locator('.badge-error', { hasText: 'failure' })).toBeVisible();
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
            points_possible: 50,
          },
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
          },
        },
      },
      reports: {
        'group-autograding-docker': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'group-autograding-docker',
          students: [
            {
              github_login: STUDENT_1.login,
              name: STUDENT_1.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              team_slug: 'team-full-pass',
              team_name: 'Team Full Pass',
              earned_points: 50,
              total_points: 50,
            },
            {
              github_login: STUDENT_2.login,
              name: STUDENT_2.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              team_slug: 'team-partial-fail',
              team_name: 'Team Partial Fail',
              earned_points: 25,
              total_points: 50,
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
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-autograding-docker`);

    // Verify detail view loads
    const heading = page.locator('.breadcrumb h1');
    await expect(heading).toContainText('group-autograding-docker');

    // Verify both student teams are rendered
    await expect(page.locator('tr, .student-row, article', { hasText: STUDENT_1.login }).first()).toBeVisible();
    await expect(page.locator('tr, .student-row, article', { hasText: STUDENT_2.login }).first()).toBeVisible();
  });
});
