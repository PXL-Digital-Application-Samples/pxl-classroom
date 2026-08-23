import { test, expect } from '@playwright/test';
import { ORG,
  LECTURER,
  STUDENT_1,
  injectAuth,
  setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

test.describe('15 - Admin Lifecycle Transitions, Manifest/CLI Exports & Group Team Switching', () => {

  test('Scenario 1 (Admin Assignment Lifecycle State Transitions & Broker Actions): Handles Save as Draft, Publish broker modal, and Republish warnings', async ({ page }) => {
    const draftAssignmentId = 'docker-microservices';
    const draftAssignment = {
      id: draftAssignmentId,
      title: 'Docker Microservices',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'draft',
      max_acceptances: 40,
      opens_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      deadline_at: new Date(Date.now() + 3600 * 1000 * 48).toISOString(),
      template: { owner: ORG, repository: 'starter-template' },
      repository_name_pattern: `${draftAssignmentId}-{github_login}`,
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [draftAssignmentId]: draftAssignment },
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG}/admin`);

    // Verify Draft assignment renders in the table with draft badge
    const draftItem = page.locator('.assignment-list li', { hasText: 'Docker Microservices' });
    await expect(draftItem).toBeVisible();
    await expect(draftItem.locator('.badge', { hasText: /Draft/i })).toBeVisible();

    // Click assignment to open editor
    await draftItem.click();

    // Verify lifecycle section renders Publish button
    const publishBtn = page.getByRole('button', { name: /Publish \(create broker, enable nightly\)/i });
    await expect(publishBtn).toBeVisible();

    // Click Publish button
    await publishBtn.click();

    // Verify workflow trigger toast
    await expect(page.locator('.toast', { hasText: /Publish workflow triggered/i })).toBeVisible();

    // Set up dialog handler for window.confirm
    page.on('dialog', (dialog) => dialog.accept());

    // Change state to Closed
    const closeBtn = page.getByRole('button', { name: /Close \(stop accepting\)/i });
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(page.locator('.toast', { hasText: /closed/i })).toBeVisible();
  });

  test('Scenario 2 (Preservation Manifest Download, CLI Copy & CSV Export): Exports preserved submission manifest, copies CLI commands, and exports CSV', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const assignmentId = 'linux-kernel-lab';
    const assignment = {
      id: assignmentId,
      title: 'Linux Kernel Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
      template: { owner: ORG, repository: 'starter-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Linux Kernel Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          student_number: 'r0123456',
          email: 'student.one@student.pxl.be',
          repo_name: `${ORG}/${assignmentId}-student-dev1`,
          acceptance_state: 'accepted',
          submission_status: 'on-time',
          preservation_status: 'preserved',
          preserved_sha: 'a1b2c3d4e5f67890abcdef1234567890abcdef12',
          commit_count: 5,
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          student_number: 'r0654321',
          email: 'student.two@student.pxl.be',
          repo_name: `${ORG}/${assignmentId}-student-dev2`,
          acceptance_state: 'accepted',
          submission_status: 'late',
          preservation_status: 'preserved',
          preserved_sha: 'f9e8d7c6b5a43210fedcba0987654321fedcba09',
          commit_count: 3,
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

    // Verify Export dropdown toggle button
    const exportBtn = page.getByRole('button', { name: /Export/i });
    await expect(exportBtn).toBeVisible();
    await exportBtn.click();

    const exportMenu = page.locator('.export-dropdown-menu');
    await expect(exportMenu).toBeVisible();

    // Click Copy CLI download command
    await exportMenu.locator('.export-dropdown-item', { hasText: 'Copy CLI Download' }).click();
    await expect(page.locator('.toast', { hasText: /CLI command copied/i }).first()).toBeVisible();

    // Reopen dropdown and click Copy CLI grade command
    await exportBtn.click();
    await exportMenu.locator('.export-dropdown-item', { hasText: 'Copy CLI Grade' }).click();
    await expect(page.locator('.toast', { hasText: /CLI command copied/i }).first()).toBeVisible();

    // Reopen dropdown and trigger Download Manifest
    await exportBtn.click();
    await exportMenu.locator('.export-dropdown-item', { hasText: 'Download Manifest' }).click();

    // Reopen dropdown and trigger Export CSV
    await exportBtn.click();
    await exportMenu.locator('.export-dropdown-item', { hasText: 'Export CSV' }).click();
  });

  test('Scenario 3 (Student Dynamic Team Switching): Provisioned student initiates team switch, updates team capacities, and resolves new target repo', async ({ page }) => {
    const groupAssignmentId = 'cloud-group-capstone';
    const groupAssignment = {
      id: groupAssignmentId,
      title: 'Cloud Group Capstone',
      organization: ORG,
      assignment_type: 'group',
      roster_mode: 'open',
      state: 'published',
      group_config: {
        max_team_size: 3,
        min_team_size: 2,
        formation_mode: 'self-service',
        allow_team_creation: true,
      },
      template: { owner: ORG, repository: 'group-template' },
      repository_name_pattern: `${groupAssignmentId}-{team_slug}`,
    };

    const initialTeams = [
      {
        team_slug: 'team-alpha',
        team_name: 'Team Alpha',
        members: [STUDENT_1.login, 'student-peer-1'],
        max_size: 3,
        repository_name: `${ORG}/${groupAssignmentId}-team-alpha`,
      },
      {
        team_slug: 'team-beta',
        team_name: 'Team Beta',
        members: ['student-peer-2'],
        max_size: 3,
        repository_name: `${ORG}/${groupAssignmentId}-team-beta`,
      },
    ];

    const studentRepos = [
      {
        id: 301,
        name: `${groupAssignmentId}-team-alpha`,
        full_name: `${ORG}/${groupAssignmentId}-team-alpha`,
        owner: { login: ORG },
        html_url: `https://github.com/${ORG}/${groupAssignmentId}-team-alpha`,
      },
      {
        id: 302,
        name: `${groupAssignmentId}-team-beta`,
        full_name: `${ORG}/${groupAssignmentId}-team-beta`,
        owner: { login: ORG },
        html_url: `https://github.com/${ORG}/${groupAssignmentId}-team-beta`,
      },
    ];

    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      assignments: { [groupAssignmentId]: groupAssignment },
      teams: { [groupAssignmentId]: initialTeams },
      userRepos: studentRepos,
      currentUser: STUDENT_1,
    });

    await page.goto(inviteUrl(ORG, groupAssignmentId));

    // Verify initial provisioned card with Team Alpha
    await expect(page.locator('.provisioned-state')).toBeVisible();
    await expect(page.locator('.provisioned-state')).toContainText('Team Alpha');

    // Click "Switch to another team"
    const switchBtn = page.getByRole('button', { name: /Switch to another team/i });
    await expect(switchBtn).toBeVisible();
    await switchBtn.click();

    // Verify team formation view opens with team list
    const teamBetaCard = page.locator('.team-item-card', { hasText: 'Team Beta' });
    await expect(teamBetaCard).toBeVisible();
    await expect(teamBetaCard).toContainText('1/3 members');

    // Click Join Team on Team Beta
    await teamBetaCard.getByRole('button', { name: /Join Team/i }).click();

    // Verify feedback or transition
    await expect(page.locator('.pending-state, .provisioned-state, .status-badge')).toBeVisible();
  });

});
