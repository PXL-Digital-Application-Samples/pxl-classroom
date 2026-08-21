import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes, openStarterSyncModal } from '../fixtures/e2e-fixtures.mjs';

test.describe('09 - Starter Code Update & Synchronization Flows', () => {
  test('Scenario 1 (Updating Existing File): Sync README.md instructions with pre-flight scan and auto-merge', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-python-sync': {
          id: 'lab-python-sync',
          title: 'Lab Python Starter Sync',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          template: {
            owner: ORG,
            repository: 'template-python-lab',
          },
        },
      },
      reports: {
        'lab-python-sync': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-python-sync',
          students: [
            {
              github_login: STUDENT_1.login,
              name: STUDENT_1.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              repo_name: `${ORG}/lab-python-sync-${STUDENT_1.login}`,
            },
            {
              github_login: STUDENT_2.login,
              name: STUDENT_2.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              repo_name: `${ORG}/lab-python-sync-${STUDENT_2.login}`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-python-sync`);

    // 1. Open "Sync Starter Code" from the More actions dropdown
    await openStarterSyncModal(page);

    // 2. Starter Sync Modal opens
    const modal = page.locator('.modal.card.modal-wide');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#starter-sync-title')).toContainText('lab-python-sync');

    // 3. Inspect Template Updates Section
    await expect(modal.locator('.commit-msg-headline')).toContainText('docs: update lab instructions in README.md');
    await expect(modal.locator('.file-path', { hasText: 'README.md' })).toBeVisible();

    // 4. Inspect Pre-Flight Analysis Grid
    await expect(modal.locator('.preflight-card.clean')).toBeVisible();
    await expect(modal.locator('.preflight-card.clean .preflight-count')).toContainText('2');

    // 5. Customize PR Title & Instructions
    const prTitleInput = modal.locator('#sync-pr-title');
    await prTitleInput.fill('docs: update lab instructions and hints');

    // 6. Click Apply Starter Update
    const applyBtn = modal.locator('button', { hasText: /Apply Starter Update/i });
    await expect(applyBtn).toBeVisible();
    await applyBtn.click();

    // 7. Verify Success Banner & Workflow Run Link
    const successBanner = modal.locator('.dispatch-banner.success');
    await expect(successBanner).toBeVisible();
    await expect(successBanner).toContainText('Starter code synchronization workflow dispatched successfully');
    await expect(modal.locator('.workflow-link')).toBeVisible();
  });

  test('Scenario 2 (Adding Missing Files): Selectively synchronizes only new test suite file', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-python-selective': {
          id: 'lab-python-selective',
          title: 'Lab Python Selective Sync',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          template: {
            owner: ORG,
            repository: 'template-python-lab',
          },
        },
      },
      reports: {
        'lab-python-selective': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-python-selective',
          students: [
            {
              github_login: STUDENT_1.login,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              repo_name: `${ORG}/lab-python-selective-${STUDENT_1.login}`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-python-selective`);

    // Open Sync Modal
    await openStarterSyncModal(page);
    const modal = page.locator('.modal.card.modal-wide');
    await expect(modal).toBeVisible();

    // Deselect all files
    await modal.locator('button', { hasText: 'Deselect all' }).click();
    await expect(modal.locator('.file-selector-box')).toContainText('Files to Synchronize (0/3)');

    // Select only 'tests/test_validation.py'
    const validationRow = modal.locator('.file-row', { hasText: 'tests/test_validation.py' });
    await validationRow.locator('input[type="checkbox"]').check();

    // Verify counter increments to 1/3
    await expect(modal.locator('.file-selector-box')).toContainText('Files to Synchronize (1/3)');

    // Dispatch update
    await modal.locator('button', { hasText: /Apply Starter Update/i }).click();
    await expect(modal.locator('.dispatch-banner.success')).toBeVisible();
  });

  test('Scenario 3 (Config File Conflict): Pre-flight scan detects conflict and routes to safe PR', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-config-conflict': {
          id: 'lab-config-conflict',
          title: 'Lab Config Conflict Sync',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          template: {
            owner: ORG,
            repository: 'template-config-lab',
          },
        },
      },
      reports: {
        'lab-config-conflict': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-config-conflict',
          students: [
            {
              github_login: STUDENT_1.login,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              repo_name: `${ORG}/lab-config-conflict-${STUDENT_1.login}`,
            },
          ],
        },
      },
    });

    // Mock compare API to report overlapping modified files (causing conflict classification)
    await page.route('https://api.github.com/repos/**/compare/**', async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({
          status: 'diverged',
          ahead_by: 2,
          behind_by: 1,
          total_commits: 3,
          files: [{ filename: 'config.json', status: 'modified' }],
        }),
      });
    });

    await page.goto(`/dashboard/${ORG}/lab-config-conflict`);
    await openStarterSyncModal(page);

    const modal = page.locator('.modal.card.modal-wide');
    await expect(modal).toBeVisible();

    // Pre-flight scan should classify student as conflict / Safe PR
    const conflictCard = modal.locator('.preflight-card.conflict');
    await expect(conflictCard).toBeVisible();
    await expect(conflictCard.locator('.preflight-count')).toContainText('1');
    await expect(conflictCard.locator('.preflight-desc')).toContainText('Conflicting edits detected; opens PR to protect student code');
  });

  test('Scenario 4 (Group Assignment Sync): Syncs starter updates across shared team repositories', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'group-starter-sync': {
          id: 'group-starter-sync',
          title: 'Group Starter Sync Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          template: {
            owner: ORG,
            repository: 'template-group-lab',
          },
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
          },
        },
      },
      reports: {
        'group-starter-sync': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'group-starter-sync',
          students: [
            {
              github_login: STUDENT_1.login,
              name: STUDENT_1.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              team_slug: 'team-alpha',
              repo_name: `${ORG}/group-starter-sync-team-alpha`,
            },
            {
              github_login: STUDENT_2.login,
              name: STUDENT_2.name,
              acceptance_state: 'accepted',
              submission_status: 'on_time',
              team_slug: 'team-beta',
              repo_name: `${ORG}/group-starter-sync-team-beta`,
            },
          ],
          teams: [
            { team_slug: 'team-alpha', team_name: 'Team Alpha', repo_name: `${ORG}/group-starter-sync-team-alpha` },
            { team_slug: 'team-beta', team_name: 'Team Beta', repo_name: `${ORG}/group-starter-sync-team-beta` },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-starter-sync`);
    await openStarterSyncModal(page);

    const modal = page.locator('.modal.card.modal-wide');
    await expect(modal).toBeVisible();

    // Verify modal computes 2 active team repos
    await expect(modal.locator('button', { hasText: /Apply Starter Update \(2 repos\)/i })).toBeVisible();
  });
});
