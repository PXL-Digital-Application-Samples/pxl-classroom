import { test, expect } from '@playwright/test';
import { ORG,
  LECTURER,
  STUDENT_1,
  injectAuth,
  setupStandardMockRoutes, inviteUrl, chooseState } from '../fixtures/e2e-fixtures.mjs';

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

    await page.goto(`/dashboard/${ORG}`);

    // The draft is in the drafts row, with its status as a DOT, not a filled
    // pill: DESIGN.md §1.3 asks for a `.status-dot`, and the pills that were
    // here once evaded the conformity guard only because it matches on
    // `text-transform: uppercase` and these were lowercase (2026-09-02).
    const draftItem = page.locator('.drafts-row .draft-chip', { hasText: 'Docker Microservices' });
    await expect(draftItem).toBeVisible({ timeout: 15000 });
    await expect(draftItem.locator('.status-dot.dot-neutral')).toBeVisible();

    // A draft opens on its settings, where a draft's work is.
    await draftItem.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${draftAssignmentId}\\?tab=settings$`));

    // Publish is the state button's first entry for a draft.
    await expect(page.locator('[data-state-menu]')).toContainText('Draft');
    await chooseState(page, 'Publish');

    // Followed in steps on the page, not a toast that vanished (tests/e2e/104).
    await expect(page.locator('.publish-steps li')).toHaveCount(4, { timeout: 15000 });
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

    // AND NOT Copy CLI Grade: this assignment has no autograding at all, and
    // that command runs the checks on the lecturer's machine. It used to be
    // offered unconditionally - a click here is what asserted that - so a
    // lecturer was handed a runner for checks that do not exist. Spec 65
    // covers the case where it IS relevant. Asserted while the menu is already
    // open, because every item click closes it and each `exportBtn.click()`
    // below is one half of a reopen.
    await expect(
      exportMenu.locator('.export-dropdown-item', { hasText: 'Copy CLI Grade' }),
    ).toHaveCount(0);

    // Click Copy CLI download command
    await exportMenu.locator('.export-dropdown-item', { hasText: 'Copy CLI Download' }).click();
    await expect(page.locator('.toast', { hasText: /CLI command copied/i }).first()).toBeVisible();

    // Reopen dropdown and trigger Download Manifest
    await exportBtn.click();
    await exportMenu.locator('.export-dropdown-item', { hasText: 'Download Manifest' }).click();

    // Reopen dropdown and trigger Export CSV
    await exportBtn.click();
    await exportMenu.locator('.export-dropdown-item', { hasText: 'Export CSV' }).click();

    // Before anything is preserved both rows say why, can be reached from the
    // keyboard (aria-disabled, review 2026-10-14 D12), and a click does nothing.
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: { ...mockReport, students: mockReport.students.map((s) => ({ ...s, preservation_status: undefined, preserved_sha: undefined })) } },
      currentUser: LECTURER,
    });
    await page.reload();
    await exportBtn.click();
    for (const name of ['Download Manifest', 'Copy CLI Download']) {
      const row = exportMenu.locator('.export-dropdown-item', { hasText: name });
      await expect(row).toContainText("Available once the deadline's lock has run");
      await expect(row).toHaveAttribute('aria-disabled', 'true');
      await row.focus();
      await expect(row).toBeFocused();
    }
    const toasts = await page.locator('.toast', { hasText: /CLI command copied/i }).count();
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await exportMenu.locator('.export-dropdown-item', { hasText: 'Copy CLI Download' }).click({ force: true });
    // The keyboard's two ways to press a button do nothing either (TS-9).
    for (const name of ['Download Manifest', 'Copy CLI Download']) {
      if (!(await exportMenu.isVisible())) await exportBtn.click();
      const row = exportMenu.locator('.export-dropdown-item', { hasText: name });
      await row.focus();
      await page.keyboard.press('Enter');
      if (!(await exportMenu.isVisible())) await exportBtn.click();
      await row.focus();
      await page.keyboard.press('Space');
    }
    // Absent after a wait, not at once: a toast or a download is asynchronous,
    // and asserting the instant after the press passes before either could land.
    await page.waitForTimeout(800);
    await expect(page.locator('.toast', { hasText: /CLI command copied/i })).toHaveCount(toasts);
    expect(downloads, 'no manifest is downloaded').toBe(0);

    // Dimmed the same in both themes: the dimming is opacity, and a row that
    // dims in light and not in dark is a row that looks pressable (TS-9).
    if (!(await exportMenu.isVisible())) await exportBtn.click();
    const dimmed = exportMenu.locator('.export-dropdown-item', { hasText: 'Download Manifest' });
    const live = exportMenu.locator('.export-dropdown-item', { hasText: 'Export CSV' });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      expect(await dimmed.evaluate((el) => getComputedStyle(el).opacity), colorScheme).toBe('0.55');
      expect(await dimmed.evaluate((el) => getComputedStyle(el).cursor), colorScheme).toBe('not-allowed');
      expect(await live.evaluate((el) => getComputedStyle(el).opacity), colorScheme).toBe('1');
    }
    await page.emulateMedia({ colorScheme: 'light' });
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

    // "Switch team", right under the team name
    const switchBtn = page.locator('[data-team-switch]').getByRole('button', { name: 'Switch team' });
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
