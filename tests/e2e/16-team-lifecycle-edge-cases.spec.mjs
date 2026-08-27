import { test, expect } from '@playwright/test';
import { injectAuth,
  setupStandardMockRoutes,
  LECTURER,
  STUDENT_1, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

const ORG = 'PXL-2TIN-CloudEssentials-2627';

test.describe('16 - Team Lifecycle Edge Cases, Vacant Pruning, Collaborator Sync & Extension Propagation', () => {

  test('Scenario 1 (Vacant Team Lifecycle & Pruning): Lecturer deletes vacant team with 0 members from the dashboard', async ({ page }) => {
    const assignmentId = 'cloud-group-vacant';
    const assignment = {
      id: assignmentId,
      title: 'Cloud Storage Group Lab',
      organization: ORG,
      assignment_type: 'group',
      roster_mode: 'open',
      state: 'published',
      group_config: {
        max_team_size: 3,
        min_team_size: 2,
        allow_team_creation: true,
      },
      template: { owner: ORG, repository: 'group-template' },
      repository_name_pattern: `${assignmentId}-{team_slug}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Cloud Storage Group Lab',
      org: ORG,
      generated_at: new Date().toISOString(),
      teams: [
        {
          team_slug: 'team-phoenix',
          team_name: 'Team Phoenix',
          members: [],
          repo_name: `${ORG}/${assignmentId}-team-phoenix`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-phoenix`,
          submission_status: 'no-submission',
          commit_count: 0,
          under_capacity: true,
        },
        {
          team_slug: 'team-active',
          team_name: 'Team Active',
          members: ['student-dev1', 'student-dev2'],
          repo_name: `${ORG}/${assignmentId}-team-active`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-active`,
          submission_status: 'on-time',
          commit_count: 4,
          under_capacity: false,
        },
      ],
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          team_slug: 'team-active',
          submission_status: 'on-time',
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          team_slug: 'team-active',
          submission_status: 'on-time',
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

    // Verify both teams appear in table
    const phoenixRow = page.locator('tr', { hasText: 'Team Phoenix' });
    const activeRow = page.locator('tr', { hasText: 'Team Active' });
    await expect(phoenixRow).toBeVisible();
    await expect(activeRow).toBeVisible();

    // Verify Phoenix is marked vacant and shows Delete button
    await expect(phoenixRow).toContainText('No members (vacant)');
    const deleteBtn = phoenixRow.getByRole('button', { name: /Delete/i });
    await expect(deleteBtn).toBeVisible();

    // Active team has active members and does NOT show Delete button in row
    await expect(activeRow.getByRole('button', { name: /Delete/i })).not.toBeVisible();

    // Handle confirm dialog and delete vacant team
    page.on('dialog', (dialog) => dialog.accept());
    await deleteBtn.click();

    // Verify success toast
    await expect(page.locator('.toast', { hasText: /deleted successfully/i })).toBeVisible();
  });

  test('Scenario 2 (Lecturer Team Member Synchronization): Lecturer adds and removes members in dashboard with immediate collaborator update', async ({ page }) => {
    const assignmentId = 'cloud-group-sync';
    const assignment = {
      id: assignmentId,
      title: 'Cloud Cluster Group Project',
      organization: ORG,
      assignment_type: 'group',
      roster_mode: 'enforced',
      state: 'published',
      group_config: {
        max_team_size: 3,
        min_team_size: 2,
        allow_team_creation: true,
      },
      template: { owner: ORG, repository: 'group-template' },
      repository_name_pattern: `${assignmentId}-{team_slug}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Cloud Cluster Group Project',
      org: ORG,
      generated_at: new Date().toISOString(),
      teams: [
        {
          team_slug: 'team-apollo',
          team_name: 'Team Apollo',
          members: ['student-dev1'],
          repo_name: `${ORG}/${assignmentId}-team-apollo`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-apollo`,
          submission_status: 'on-time',
          commit_count: 2,
          under_capacity: true,
        },
      ],
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          student_number: 'r0123456',
          team_slug: 'team-apollo',
          submission_status: 'on-time',
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          student_number: 'r0654321',
          team_slug: null,
          submission_status: 'no-submission',
        },
      ],
    };

    const mockRoster = [
      { github_login: 'student-dev1', full_name: 'Student Dev One', student_number: 'r0123456' },
      { github_login: 'student-dev2', full_name: 'Student Dev Two', student_number: 'r0654321' },
    ];

    // The manifest as it really sits in the control repo. The row on screen is
    // a DISPLAY shape (submission_status, commit_count, under_capacity) and is
    // missing created_by, repo_id and seeded_from entirely - so saving members
    // has to read THIS, not rebuild from the row. Supplying it is what makes
    // the assertions below meaningful.
    const storedApollo = {
      schema_version: 1,
      assignment_id: assignmentId,
      team_slug: 'team-apollo',
      team_name: 'Team Apollo',
      members: ['student-dev1'],
      max_members: 3,
      created_at: '2026-08-01T09:00:00.000Z',
      created_by: 'student-dev1',
      repo_name: `${ORG}/${assignmentId}-team-apollo`,
      repo_id: 55501,
      repo_url: `https://github.com/${ORG}/${assignmentId}-team-apollo`,
      seeded_from: {
        source: 'assignment',
        assignment_id: 'previous-group-work',
        assignment_title: 'Previous Group Work',
        seeded_at: '2026-07-30T08:00:00.000Z',
        seeded_by: 'lecturer',
      },
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      controlTeams: { [assignmentId]: [storedApollo] },
      roster: mockRoster,
      currentUser: LECTURER,
    });

    // Capture what actually gets written back.
    const written = [];
    await page.route(
      `**/repos/${ORG}/pxl-classroom-control/contents/teams/${assignmentId}/team-apollo.json`,
      async (route) => {
        if (route.request().method() === 'PUT') {
          const body = route.request().postDataJSON();
          written.push(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')));
        }
        await route.fallback();
      },
    );

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);

    const apolloRow = page.locator('tr', { hasText: 'Team Apollo' });
    await expect(apolloRow).toBeVisible();

    // Click Manage on Team Apollo
    await apolloRow.getByRole('button', { name: /Manage/i }).click();

    const manageModal = page.locator('.modal.card', { hasText: 'Manage: Team Apollo' });
    await expect(manageModal).toBeVisible();

    // Verify student-dev1 is in current members
    await expect(manageModal.locator('.member-manage-row', { hasText: 'student-dev1' })).toBeVisible();

    // Remove student-dev1
    await manageModal.locator('.member-manage-row', { hasText: 'student-dev1' }).getByRole('button', { name: /Remove/i }).click();

    // Add student-dev2 from dropdown
    const studentSelect = manageModal.locator('select');
    await studentSelect.selectOption('student-dev2');
    await manageModal.getByRole('button', { name: 'Add' }).click();

    // Click Save Changes
    await manageModal.getByRole('button', { name: /Save Changes/i }).click();

    // Verify success toast
    await expect(page.locator('.toast', { hasText: /updated successfully/i })).toBeVisible();

    // The manifest that was written must be a MERGE onto what was stored, not a
    // rebuild from the row. Rebuilding dropped created_by (required by
    // team.schema.json), repo_id, and seeded_from - and losing seeded_from
    // silently removes the team from planUnseed and the "Undo seed" button.
    expect(written.length).toBeGreaterThan(0);
    const saved = written[written.length - 1];
    expect(saved.members).toEqual(['student-dev2']);
    expect(saved.created_by).toBe('student-dev1');
    expect(saved.repo_id).toBe(55501);
    expect(saved.seeded_from).toEqual(storedApollo.seeded_from);
    expect(saved.created_at).toBe('2026-08-01T09:00:00.000Z');
  });

  test('Scenario 3 (Team-Level Deadline Extension Propagation): Single student extension propagates on-time classification to entire team repo', async ({ page }) => {
    const assignmentId = 'cloud-group-extension';
    const assignment = {
      id: assignmentId,
      title: 'Distributed Systems Capstone',
      organization: ORG,
      assignment_type: 'group',
      roster_mode: 'enforced',
      state: 'published',
      deadline_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(), // 1 day ago
      extensions: {
        'student-dev1': new Date(Date.now() + 3600 * 1000 * 48).toISOString(), // extended by 2 days
      },
      group_config: {
        max_team_size: 3,
        min_team_size: 2,
        allow_team_creation: true,
      },
      template: { owner: ORG, repository: 'group-template' },
      repository_name_pattern: `${assignmentId}-{team_slug}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Distributed Systems Capstone',
      org: ORG,
      generated_at: new Date().toISOString(),
      teams: [
        {
          team_slug: 'team-titan',
          team_name: 'Team Titan',
          members: ['student-dev1', 'student-dev2'],
          repo_name: `${ORG}/${assignmentId}-team-titan`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-titan`,
          submission_status: 'on-time', // Propagated on-time
          commit_count: 5,
          under_capacity: false,
        },
      ],
      students: [
        {
          github_login: 'student-dev1',
          name: 'Student Dev One',
          team_slug: 'team-titan',
          submission_status: 'on-time',
        },
        {
          github_login: 'student-dev2',
          name: 'Student Dev Two',
          team_slug: 'team-titan',
          submission_status: 'on-time', // Propagated on-time through teammate
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

    const titanRow = page.locator('tr', { hasText: 'Team Titan' });
    await expect(titanRow).toBeVisible();
    await expect(titanRow.locator('.status-indicator', { hasText: /on-time/i })).toBeVisible();

    // Verify filter tab counts
    await expect(page.locator('.team-quick-filters button', { hasText: /On-time \(1\)/i })).toBeVisible();
    await expect(page.locator('.team-quick-filters button', { hasText: /Late \(0\)/i })).toBeVisible();
  });

  test('Scenario 4 (Pending Invitation Revocation on Switch): Switching teams unlinks previous group repo and joins target group', async ({ page }) => {
    const assignmentId = 'cloud-group-switch-flow';
    const assignment = {
      id: assignmentId,
      title: 'Cloud Architecture Switch Project',
      organization: ORG,
      assignment_type: 'group',
      roster_mode: 'open',
      state: 'published',
      group_config: {
        max_team_size: 3,
        min_team_size: 2,
        allow_team_creation: true,
      },
      template: { owner: ORG, repository: 'group-template' },
      repository_name_pattern: `${assignmentId}-{team_slug}`,
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Cloud Architecture Switch Project',
      org: ORG,
      generated_at: new Date().toISOString(),
      teams: [
        {
          team_slug: 'team-red',
          team_name: 'Team Red',
          members: [STUDENT_1.login],
          repo_name: `${ORG}/${assignmentId}-team-red`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-red`,
          submission_status: 'on-time',
          commit_count: 1,
        },
        {
          team_slug: 'team-blue',
          team_name: 'Team Blue',
          members: ['other-student'],
          repo_name: `${ORG}/${assignmentId}-team-blue`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-blue`,
          submission_status: 'on-time',
          commit_count: 2,
        },
      ],
      students: [
        {
          github_login: STUDENT_1.login,
          name: 'Student Dev One',
          team_slug: 'team-red',
          repo_name: `${ORG}/${assignmentId}-team-red`,
          repo_url: `https://github.com/${ORG}/${assignmentId}-team-red`,
          submission_status: 'on-time',
        },
      ],
    };

    const studentRepos = [
      {
        id: 401,
        name: `${assignmentId}-team-red`,
        full_name: `${ORG}/${assignmentId}-team-red`,
        owner: { login: ORG },
        html_url: `https://github.com/${ORG}/${assignmentId}-team-red`,
      },
      {
        id: 402,
        name: `${assignmentId}-team-blue`,
        full_name: `${ORG}/${assignmentId}-team-blue`,
        owner: { login: ORG },
        html_url: `https://github.com/${ORG}/${assignmentId}-team-blue`,
      },
    ];

    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      teams: { [assignmentId]: mockReport.teams },
      userRepos: studentRepos,
      currentUser: STUDENT_1,
      // No acceptance records: this is the STUDENT surface, and a student
      // cannot read the control repo. `GroupAcceptanceCard` decides the
      // provisioned state from the public teams payload (`teams`) plus a live
      // `GET /repos/{org}/{name}` (`userRepos`) - nothing here reads
      // `acceptances/<id>/<login>.json`. An `acceptances` option was passed
      // here for months; the fixture never destructured it, so it was
      // discarded, and replacing it with garbage left the test green.
    });

    await page.goto(inviteUrl(ORG, assignmentId));

    // Verify initial provisioned card showing Team Red
    await expect(page.locator('.provisioned-state')).toBeVisible();
    await expect(page.locator('.provisioned-state')).toContainText('Team Red');

    // Click "Switch to another team"
    const switchBtn = page.getByRole('button', { name: /Switch to another team/i });
    await expect(switchBtn).toBeVisible();
    await switchBtn.click();

    // Verify team selection list is displayed
    const blueCard = page.locator('.team-item-card', { hasText: 'Team Blue' });
    await expect(blueCard).toBeVisible();
    await expect(blueCard).toContainText('1/3 members');

    // Join Team Blue
    await blueCard.getByRole('button', { name: /Join Team/i }).click();

    // Verify transition feedback
    await expect(page.locator('.pending-state, .provisioned-state, .status-badge')).toBeVisible();
  });

});
