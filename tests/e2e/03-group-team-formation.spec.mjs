import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

test.describe('03 - Group Assignment & Team Formation Flow', () => {
  test('Happy Path: Student views open teams, filters by search, and clicks Join Team', async ({ page }) => {
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: {
        'group-proj': {
          id: 'group-proj',
          title: 'Group Project 2026',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
            allow_team_creation: true,
          },
          repository_name_pattern: 'group-proj-{team_slug}',
        },
      },
      teams: {
        'group-proj': [
          {
            team_slug: 'team-alpha',
            team_name: 'Team Alpha',
            members: [STUDENT_1.login],
            member_count: 1,
            max_members: 3,
            is_full: false,
          },
          {
            team_slug: 'team-full',
            team_name: 'Team Full',
            members: ['alice', 'bob', 'charlie'],
            member_count: 3,
            max_members: 3,
            is_full: true,
          },
        ],
      },
    });

    await page.goto(`/${ORG}/a/group-proj`);

    const header = page.locator('h2', { hasText: 'Group Assignment: Team Selection' });
    await expect(header).toBeVisible({ timeout: 10000 });

    // Verify Tab pill counts open teams (1 open)
    const joinTab = page.locator('.tab-pill', { hasText: /Join Existing Team/ });
    await expect(joinTab).toBeVisible();
    await expect(joinTab).toContainText('1 open');

    // Search filter test
    const searchInput = page.locator('.input-search');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('alpha');

    const alphaCard = page.locator('.team-item-card', { hasText: 'Team Alpha' });
    await expect(alphaCard).toBeVisible();
    await expect(alphaCard).toContainText('1/3 members');

    const joinBtn = alphaCard.locator('button', { hasText: 'Join Team' });
    await expect(joinBtn).toBeVisible();
    await expect(joinBtn).toBeEnabled();

    // Clear search and test Full team card
    await searchInput.fill('full');
    const fullCard = page.locator('.team-item-card', { hasText: 'Team Full' });
    await expect(fullCard).toBeVisible();
    await expect(fullCard).toContainText('3/3 members');
    const fullBtn = fullCard.locator('button', { hasText: 'Full' });
    await expect(fullBtn).toBeDisabled();
  });

  test('Happy Path: Student creates a new team with live slug generation', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'group-create': {
          id: 'group-create',
          title: 'Group Assignment Create Test',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: {
            max_team_size: 4,
            formation_mode: 'self-service',
            allow_team_creation: true,
          },
          repository_name_pattern: 'group-create-{team_slug}',
        },
      },
      teams: { 'group-create': [] },
    });

    await page.goto(`/${ORG}/a/group-create`);

    const createTab = page.locator('.tab-pill', { hasText: '+ Create New Team' });
    await expect(createTab).toBeVisible();
    await createTab.click();

    const teamInput = page.locator('#new-team-name');
    await expect(teamInput).toBeVisible();
    await teamInput.fill('The Code Crusaders');

    // Check slug preview
    const slugPreview = page.locator('.form-hint code');
    await expect(slugPreview).toHaveText('the-code-crusaders');

    const submitBtn = page.locator('button', { hasText: 'Create & Join Team' });
    await expect(submitBtn).toBeEnabled();
  });

  test('Sad Path: Duplicate team slug displays conflict error and disables button', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'group-conflict': {
          id: 'group-conflict',
          title: 'Group Conflict Test',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
            allow_team_creation: true,
          },
        },
      },
      teams: {
        'group-conflict': [
          {
            team_slug: 'code-crusaders',
            team_name: 'Code Crusaders',
            members: ['someone'],
            member_count: 1,
            max_members: 3,
            is_full: false,
          },
        ],
      },
    });

    await page.goto(`/${ORG}/a/group-conflict`);
    const createTab = page.locator('.tab-pill', { hasText: '+ Create New Team' });
    await createTab.click();

    const teamInput = page.locator('#new-team-name');
    await teamInput.fill('Code Crusaders'); // Same slug!

    const conflictMsg = page.locator('.alert-warn');
    await expect(conflictMsg).toBeVisible();
    await expect(conflictMsg).toContainText('already exists');

    const submitBtn = page.locator('button', { hasText: 'Create & Join Team' });
    await expect(submitBtn).toBeDisabled();
  });

  test('Edge Case: Pre-assigned mode without roster mapping displays "No Pre-Assigned Team"', async ({ page }) => {
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: {
        'group-preassigned': {
          id: 'group-preassigned',
          title: 'Pre-Assigned Group Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: {
            formation_mode: 'pre-assigned',
            max_team_size: 3,
          },
        },
      },
      teams: { 'group-preassigned': [] },
    });

    await page.goto(`/${ORG}/a/group-preassigned`);
    const noTeamCard = page.locator('h3', { hasText: 'No Pre-Assigned Team' });
    await expect(noTeamCard).toBeVisible();
    await expect(page.locator('.preassigned-flow')).toContainText(STUDENT_2.login);
  });
});
