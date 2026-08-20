import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

test.describe('08 - Autograding Scenarios: GitHub Actions & Docker Group Assignments', () => {
  test('Assignment 1 (GitHub Actions): Displays score pills, clickable drill-down modal, and test breakdown', async ({ page }) => {
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
              tests: [
                { id: 'test-basic', name: 'Basic Stats Calculation', passed: true, points: 10, earned: 10 },
                { id: 'test-edge', name: 'Edge Cases & Dirty Data', passed: true, points: 10, earned: 10 },
                { id: 'test-scale', name: 'Scale & Sorting Test', passed: true, points: 10, earned: 10 },
              ],
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
              tests: [
                { id: 'test-basic', name: 'Basic Stats Calculation', passed: true, points: 10, earned: 10 },
                { id: 'test-edge', name: 'Edge Cases & Dirty Data', passed: false, points: 10, earned: 0, stderr: 'AssertionError: None is not 0.0' },
                { id: 'test-scale', name: 'Scale & Sorting Test', passed: true, points: 10, earned: 10 },
              ],
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
              score: '30/30 pts',
              earned_points: 30,
              total_points: 30,
            },
            {
              team_slug: 'team-partial-fail',
              team_name: 'Team Partial Fail',
              members: [STUDENT_2.login],
              member_count: 1,
              max_members: 3,
              is_full: false,
              ci_status: 'failure',
              score: '20/30 pts',
              earned_points: 20,
              total_points: 30,
              tests: [
                { id: 'test-basic', name: 'Basic Stats Calculation', passed: true, points: 10, earned: 10 },
                { id: 'test-edge', name: 'Edge Cases & Dirty Data', passed: false, points: 10, earned: 0, stderr: 'AssertionError: None is not 0.0' },
                { id: 'test-scale', name: 'Scale & Sorting Test', passed: true, points: 10, earned: 10 },
              ],
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-autograding-actions`);

    // 1. In Teams View: verify Score and CI Status headers
    await expect(page.locator('th', { hasText: 'CI Status' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('th', { hasText: 'Score' })).toBeVisible();

    // 2. Click failing team score to open Team Autograding Modal
    const teamFailBtn = page.locator('button', { hasText: '20/30 pts' }).first();
    await expect(teamFailBtn).toBeVisible();
    await teamFailBtn.click();

    // 3. Inspect Test Breakdown Modal
    const autogradeModal = page.locator('.autograde-modal');
    await expect(autogradeModal).toBeVisible();
    await expect(autogradeModal).toContainText('Team Autograding');
    await expect(autogradeModal).toContainText('Team Partial Fail');
    await expect(autogradeModal).toContainText('AssertionError: None is not 0.0');

    // Close modal
    await autogradeModal.locator('button', { hasText: 'Close' }).click();
    await expect(autogradeModal).not.toBeVisible();

    // 4. Switch to Students View
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
              ci_status: 'success',
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
              ci_status: 'failure',
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
              score: '50/50 pts',
              earned_points: 50,
              total_points: 50,
            },
            {
              team_slug: 'team-partial-fail',
              team_name: 'Team Partial Fail',
              members: [STUDENT_2.login],
              member_count: 1,
              max_members: 3,
              is_full: false,
              score: '25/50 pts',
              earned_points: 25,
              total_points: 50,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-autograding-docker`);

    // Verify detail view loads
    const heading = page.locator('.breadcrumb h1');
    await expect(heading).toContainText('group-autograding-docker');

    // Verify both score pills are displayed in the Teams table
    await expect(page.locator('button', { hasText: '50/50 pts' }).first()).toBeVisible();
    await expect(page.locator('button', { hasText: '25/50 pts' }).first()).toBeVisible();
  });

  test('Edge Case: Non-autograded assignment does not render Score or CI Status columns', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'group-manual-only': {
          id: 'group-manual-only',
          title: 'Group Manual Grading Only',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          autograde: {
            enabled: false,
          },
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
          },
        },
      },
      reports: {
        'group-manual-only': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'group-manual-only',
          students: [
            {
              github_login: STUDENT_1.login,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              team_slug: 'team-manual',
              team_name: 'Team Manual',
            },
          ],
          teams: [
            {
              team_slug: 'team-manual',
              team_name: 'Team Manual',
              members: [STUDENT_1.login],
              member_count: 1,
              max_members: 3,
              is_full: false,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-manual-only`);

    // Verify CI Status and Score headers do NOT exist
    await expect(page.locator('th', { hasText: 'CI Status' })).not.toBeVisible();
    await expect(page.locator('th', { hasText: 'Score' })).not.toBeVisible();
  });
});
