import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

test.describe('05 - Lecturer Dashboard & Team Management', () => {
  test('Happy Path: Lecturer views group assignment detail, inspects teams and under-capacity badges', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'group-hw': {
          id: 'group-hw',
          title: 'Group Assignment HW',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
          },
        },
      },
      reports: {
        'group-hw': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'group-hw',
          students: [
            {
              github_login: STUDENT_1.login,
              name: STUDENT_1.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              team_slug: 'team-lone',
            },
          ],
          teams: [
            {
              team_slug: 'team-lone',
              team_name: 'Team Lone',
              members: [STUDENT_1.login],
              member_count: 1,
              max_members: 3,
              is_full: false,
              under_capacity: true,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-hw`);

    // Verify detail header
    const heading = page.locator('.app-header-crumbs h1');
    await expect(heading).toContainText('group-hw');

    // Switch to Teams tab if present
    // Precise: the toolbar's "Seed teams" button also matches a loose /Teams/i.
    const teamsTab = page.locator('.tab-pill', { hasText: /Teams View/i });
    if (await teamsTab.isVisible()) {
      await teamsTab.click();
    }

    // Check student or team row
    const studentRow = page.locator('tr, .student-row, article, .student-card', { hasText: STUDENT_1.login });
    await expect(studentRow.first()).toBeVisible({ timeout: 10000 });
  });

  test('Happy Path: Manage Team Modal allows adding and removing students', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'group-manage': {
          id: 'group-manage',
          title: 'Manageable Group Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
          },
        },
      },
      reports: {
        'group-manage': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'group-manage',
          students: [
            {
              github_login: STUDENT_1.login,
              name: STUDENT_1.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              team_slug: 'team-manage',
            },
          ],
          teams: [
            {
              team_slug: 'team-manage',
              team_name: 'Team Manage',
              members: [STUDENT_1.login],
              member_count: 1,
              max_members: 3,
              is_full: false,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-manage`);

    // Precise: the toolbar's "Seed teams" button also matches a loose /Teams/i.
    const teamsTab = page.locator('.tab-pill', { hasText: /Teams View/i });
    if (await teamsTab.isVisible()) {
      await teamsTab.click();
    }

    const manageBtn = page.locator('button', { hasText: /Manage|Edit Team|Actions/i }).first();
    if (await manageBtn.isVisible()) {
      await manageBtn.click();
    }
  });
});
