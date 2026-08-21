import { test, expect } from '@playwright/test';
import {
  injectAuth,
  setupStandardMockRoutes,
  LECTURER,
} from '../fixtures/e2e-fixtures.mjs';

const ORG = 'PXL-2TIN-CloudEssentials-2627';

test.describe('17 - Immediate Freeze, Lockdown & Preservation Workflows & Modal Resilience', () => {

  test('Scenario 1 (Freeze & Preserve Modal Action & Dispatch Flow): Lecturer triggers administrative freeze modal and dispatches lockdown', async ({ page }) => {
    const assignmentId = 'lab-freeze-exec';
    const assignment = {
      id: assignmentId,
      title: 'Freeze & Lockdown Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 2).toISOString(), // 2 hours ago
      template: { owner: ORG, repository: 'freeze-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Freeze & Lockdown Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          repo_name: `${ORG}/${assignmentId}-student-dev1`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev1`,
          submission_status: 'on-time',
          commit_count: 3,
          preservation_status: 'unpreserved',
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          repo_name: `${ORG}/${assignmentId}-student-dev2`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev2`,
          submission_status: 'on-time',
          commit_count: 5,
          preservation_status: 'unpreserved',
        },
      ],
    };

    let dispatchedWorkflow = null;
    let dispatchedBody = null;

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    // Capture workflow dispatch route
    await page.route(`**/actions/workflows/daily-activity.yml/dispatches`, async (route) => {
      dispatchedWorkflow = 'daily-activity.yml';
      try {
        dispatchedBody = route.request().postDataJSON();
      } catch {}
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);

    // 1. Verify preservation banner is visible with Freeze & Preserve button
    const freezeBtn = page.getByRole('button', { name: /Freeze & Preserve Now/i });
    await expect(freezeBtn).toBeVisible();

    // 2. Open confirmation modal
    await freezeBtn.click();

    const modal = page.locator('.modal-consequences');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h3')).toContainText('Confirm Immediate Freeze & Lockdown');

    // 3. Verify consequences list items
    await expect(modal).toContainText('Demotes Student Permissions to Read-Only');
    await expect(modal).toContainText('Snapshots Immutable Archive Commits');
    await expect(modal).toContainText('Locks Deadline Classification');
    await expect(modal).toContainText('across all 2 student repositories');

    // 4. Click Confirm Freeze & Lockdown button
    const confirmBtn = modal.getByRole('button', { name: /Confirm Freeze/i });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // 5. Verify success toast and modal closure
    await expect(page.locator('.toast', { hasText: /Lockdown and preservation workflow triggered successfully/i })).toBeVisible();
    await expect(modal).not.toBeVisible();

    // 6. Verify dispatch payload
    expect(dispatchedWorkflow).toBe('daily-activity.yml');
    expect(dispatchedBody?.ref).toBe('main');
    expect(dispatchedBody?.inputs?.org).toBe(ORG);
  });

  test('Scenario 2 (Retry Preservation Flow for Unpreserved Repositories): Dispatches targeted preservation retry', async ({ page }) => {
    const assignmentId = 'lab-preservation-retry';
    const assignment = {
      id: assignmentId,
      title: 'Preservation Retry Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 12).toISOString(),
      template: { owner: ORG, repository: 'retry-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Preservation Retry Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          repo_name: `${ORG}/${assignmentId}-student-dev1`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev1`,
          submission_status: 'on-time',
          commit_count: 2,
          preservation_status: 'unpreserved',
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          repo_name: `${ORG}/${assignmentId}-student-dev2`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev2`,
          submission_status: 'on-time',
          commit_count: 4,
          preservation_status: 'preserved',
          preserved_sha: 'abc1234567890abcdef',
        },
      ],
    };

    let dispatchedRetry = false;

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    await page.route(`**/actions/workflows/daily-activity.yml/dispatches`, async (route) => {
      dispatchedRetry = true;
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);

    // Verify Retry Preservation (1) button
    const retryBtn = page.getByRole('button', { name: /Retry Preservation \(1\)/i });
    await expect(retryBtn).toBeVisible();

    await retryBtn.click();

    // Verify success toast
    await expect(page.locator('.toast', { hasText: /Preservation retry workflow triggered successfully/i })).toBeVisible();
    expect(dispatchedRetry).toBe(true);
  });

  test('Scenario 3 (Preservation Status Badges in Individual & Group Tables): Renders Preserved links to archive and Locked badges', async ({ page }) => {
    const assignmentId = 'lab-status-preserved';
    const assignment = {
      id: assignmentId,
      title: 'Preservation Status Verification Lab',
      organization: ORG,
      assignment_type: 'group',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
      group_config: {
        max_team_size: 3,
        min_team_size: 2,
      },
      template: { owner: ORG, repository: 'group-template' },
      repository_name_pattern: `${assignmentId}-{team_slug}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Preservation Status Verification Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      teams: [
        {
          team_slug: 'team-preserved',
          team_name: 'Team Preserved',
          members: ['student-dev1'],
          repo_name: `${ORG}/${assignmentId}-team-preserved`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-preserved`,
          submission_status: 'on-time',
          commit_count: 6,
          preservation_status: 'preserved',
        },
        {
          team_slug: 'team-locked',
          team_name: 'Team Locked',
          members: ['student-dev2'],
          repo_name: `${ORG}/${assignmentId}-team-locked`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-locked`,
          submission_status: 'on-time',
          commit_count: 3,
          lock_down_at: new Date().toISOString(),
        },
      ],
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          team_slug: 'team-preserved',
          submission_status: 'on-time',
          preservation_status: 'preserved',
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          team_slug: 'team-locked',
          submission_status: 'on-time',
          lock_down_at: new Date().toISOString(),
        },
      ],
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);

    // Verify Team Preserved renders green "Preserved" badge with archive link
    const preservedTeamRow = page.locator('tr', { hasText: 'Team Preserved' });
    await expect(preservedTeamRow).toBeVisible();
    const preservedLink = preservedTeamRow.locator('a.archive-link');
    await expect(preservedLink).toBeVisible();
    await expect(preservedLink).toContainText('Preserved');
    const href = await preservedLink.getAttribute('href');
    expect(href).toContain('pxl-classroom-archive/tree/preserved%2Flab-status-preserved%2Fteam-preserved');

    // Verify Team Locked renders "Locked" badge
    const lockedTeamRow = page.locator('tr', { hasText: 'Team Locked' });
    await expect(lockedTeamRow).toBeVisible();
    await expect(lockedTeamRow.locator('.badge', { hasText: /Locked/i })).toBeVisible();
  });

  test('Scenario 4 (Freeze Action Error Handling): Surfaces descriptive failure toast when dispatch is rejected', async ({ page }) => {
    const assignmentId = 'lab-freeze-err';
    const assignment = {
      id: assignmentId,
      title: 'Freeze Error Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
      template: { owner: ORG, repository: 'err-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Freeze Error Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          repo_name: `${ORG}/${assignmentId}-student-dev1`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev1`,
          submission_status: 'on-time',
          commit_count: 1,
        },
      ],
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    // Mock 403 error on dispatches
    await page.route(`**/actions/workflows/daily-activity.yml/dispatches`, async (route) => {
      await route.fulfill({
        status: 403,
        body: JSON.stringify({ message: 'Resource not accessible by integration' }),
      });
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);

    // Click Freeze button
    await page.getByRole('button', { name: /Freeze & Preserve Now/i }).click();

    // Click Confirm in modal
    const modal = page.locator('.modal-consequences');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: /Confirm Freeze/i }).click();

    // Verify detailed error toast
    await expect(page.locator('.toast', { hasText: /the GitHub App's user-to-server token doesn't have actions:write/i })).toBeVisible();
  });

  test('Scenario 5 (Modal Dismissal Resilience & Non-Mutation): Modal dismisses cleanly without triggering actions', async ({ page }) => {
    const assignmentId = 'lab-freeze-dismiss-resilience';
    const assignment = {
      id: assignmentId,
      title: 'Freeze Dismiss Resilience Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
      template: { owner: ORG, repository: 'res-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Freeze Dismiss Resilience Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          repo_name: `${ORG}/${assignmentId}-student-dev1`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-student-dev1`,
          submission_status: 'on-time',
          commit_count: 2,
        },
      ],
    };

    let dispatchCount = 0;

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    await page.route(`**/actions/workflows/daily-activity.yml/dispatches`, async (route) => {
      dispatchCount++;
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);

    const freezeBtn = page.getByRole('button', { name: /Freeze & Preserve Now/i });
    const modal = page.locator('.modal-consequences');

    // 1. Dismiss via Cancel button
    await freezeBtn.click();
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();

    // 2. Dismiss via close X button
    await freezeBtn.click();
    await expect(modal).toBeVisible();
    await modal.locator('.modal-close').click();
    await expect(modal).not.toBeVisible();

    // 3. Dismiss via overlay backdrop click
    await freezeBtn.click();
    await expect(modal).toBeVisible();
    await page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(modal).not.toBeVisible();

    expect(dispatchCount).toBe(0);
  });

});
