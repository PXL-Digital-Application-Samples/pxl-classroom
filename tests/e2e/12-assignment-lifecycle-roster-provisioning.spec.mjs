import { test, expect } from '@playwright/test';
import { setupStandardMockRoutes, injectAuth, LECTURER, STUDENT_1, STUDENT_2 } from '../fixtures/e2e-fixtures.mjs';

const ORG = 'PXL-2TIN-CloudEssentials-2627';

test.describe('12 - Assignment Creation, Provisioning, Roster Management & Edge-Case Failure Handling', () => {

  test('Scenario 1 (Self-Service Open Assignment Creation & Immediate Provisioning): Lecturer creates open assignment, student accepts and provisions repository', async ({ page }) => {
    const STUDENT_OPEN = { login: 'student-open', name: 'Sam Open', token: 'mock_open_token' };

    // 1. Lecturer authors and saves open assignment in Admin Panel
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
    });

    await page.goto(`/dashboard/${ORG}/admin`);
    await expect(page.locator('.admin-header .admin-heading')).toBeVisible();

    // Click "+ New assignment"
    await page.locator('.new-btn').click();

    // Fill Title
    const titleInput = page.getByPlaceholder('e.g. Linux Processes 2026');
    await titleInput.fill('Cloud Native Microservices');

    const slugInput = page.getByPlaceholder('linux-processes-2026');
    await expect(slugInput).toHaveValue('cloud-native-microservices');

    // Fill Template
    await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);

    // Save as draft
    const saveBtn = page.getByRole('button', { name: 'Save as draft' }).first();
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.locator('.toast', { hasText: /Saved cloud-native-microservices/i })).toBeVisible();

    // 2. Student opens the published assignment invitation link and accepts
    await injectAuth(page, STUDENT_OPEN);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_OPEN,
      assignments: {
        'cloud-native-microservices': {
          id: 'cloud-native-microservices',
          title: 'Cloud Native Microservices',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          roster_mode: 'open',
          max_acceptances: 50,
          deadline_at: new Date(Date.now() + 3600 * 1000 * 72).toISOString(),
        },
      },
      userRepos: [
        {
          name: 'cloud-native-microservices-student-open',
          full_name: `${ORG}/cloud-native-microservices-student-open`,
          html_url: `https://github.com/${ORG}/cloud-native-microservices-student-open`,
        },
      ],
    });

    await page.goto(`/${ORG}/a/cloud-native-microservices`);

    // Verify ready state & student acceptance
    await expect(page.locator('h1', { hasText: 'Cloud Native Microservices' })).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();
    await expect(page.locator('a.repo-link')).toContainText(`${ORG}/cloud-native-microservices-student-open`);
    await expect(page.locator('button', { hasText: /Copy URL|Copied/i })).toBeVisible();
  });

  test('Scenario 2 (Roster-Enforced Creation, CSV Diff Import, and Enrolled Student Acceptance): Lecturer imports roster via CSV diff and enrolled student accepts', async ({ page }) => {
    const STUDENT_ENROLLED = { login: 'student-enrolled', name: 'Alice Enrolled', token: 'mock_enrolled_token' };

    // 1. Lecturer imports CSV roster in Roster tab
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();

    const csvData = `student_number,full_name,email,class_group,github_login\n0123456,Alice Enrolled,alice@stud.pxl.be,2TIN,student-enrolled\n0123457,Bob Enrolled,bob@stud.pxl.be,2TIN,bob-enrolled`;
    await page.locator('.roster-tab textarea').fill(csvData);

    // Verify diff calculation
    await expect(page.locator('.diff-badge.added')).toContainText('+ 2 added');
    await expect(page.locator('.diff-pane')).toContainText('Alice Enrolled');

    // Commit roster
    const commitBtn = page.getByRole('button', { name: 'Commit roster' });
    await expect(commitBtn).toBeEnabled();
    await commitBtn.click();
    await expect(page.locator('.toast', { hasText: /Roster committed/i })).toBeVisible();

    // 2. Enrolled student on the roster accepts assignment
    await injectAuth(page, STUDENT_ENROLLED);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_ENROLLED,
      roster: [
        { student_number: '0123456', full_name: 'Alice Enrolled', email: 'alice@stud.pxl.be', github_login: 'student-enrolled' },
        { student_number: '0123457', full_name: 'Bob Enrolled', email: 'bob@stud.pxl.be', github_login: 'bob-enrolled' },
      ],
      assignments: {
        'lab-enforced': {
          id: 'lab-enforced',
          title: 'Enforced Architecture Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          roster_mode: 'enforced',
          deadline_at: new Date(Date.now() + 3600 * 1000 * 48).toISOString(),
        },
      },
      userRepos: [
        {
          name: 'lab-enforced-student-enrolled',
          full_name: `${ORG}/lab-enforced-student-enrolled`,
          html_url: `https://github.com/${ORG}/lab-enforced-student-enrolled`,
        },
      ],
    });

    await page.goto(`/${ORG}/a/lab-enforced`);

    // Successfully provisions
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();
    await expect(page.locator('.student-status-card')).toBeVisible();
  });

  test('Scenario 3 (Roster Gating & Pending Flow): Non-roster student enters pending polling upon acceptance', async ({ page }) => {
    const STUDENT_OUTSIDER = { login: 'student-outsider', name: 'Oscar Outsider', token: 'mock_outsider_token' };

    await injectAuth(page, STUDENT_OUTSIDER);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_OUTSIDER,
      roster: [
        { student_number: '0123456', full_name: 'Alice Enrolled', github_login: 'student-enrolled' },
      ],
      assignments: {
        'lab-enforced-gating': {
          id: 'lab-enforced-gating',
          title: 'Restricted Roster Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          roster_mode: 'enforced',
        },
      },
      userRepos: [], // outsider has no repo
    });

    await page.goto(`/${ORG}/a/lab-enforced-gating`);

    // Verify ready accept button is available
    const acceptBtn = page.getByRole('button', { name: 'Accept assignment' });
    await expect(acceptBtn).toBeVisible();
    await acceptBtn.click();

    // Verify student is in pending polling state waiting on invitation/roster provisioning
    await expect(page.locator('.pending-state')).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Setting up your repository…' })).toBeVisible();
  });

  test('Scenario 4 (Mid-Flight Roster Update & Immediate Recovery): Student blocked initially, recovers immediately after lecturer adds them to roster', async ({ page }) => {
    const STUDENT_LATE_ADD = { login: 'student-late-add', name: 'Leo LateAdd', token: 'mock_lateadd_token' };
    const repoName = 'lab-midflight-roster-student-late-add';

    // 1. Initial attempt: student has no repo
    await injectAuth(page, STUDENT_LATE_ADD);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_LATE_ADD,
      roster: [
        { student_number: '0111111', full_name: 'Initial Student', github_login: 'student-initial' },
      ],
      assignments: {
        'lab-midflight-roster': {
          id: 'lab-midflight-roster',
          title: 'Midflight Roster Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          roster_mode: 'enforced',
        },
      },
      userRepos: [],
    });

    await page.goto(`/${ORG}/a/lab-midflight-roster`);
    const acceptBtn = page.getByRole('button', { name: 'Accept assignment' });
    await expect(acceptBtn).toBeVisible();
    await acceptBtn.click();
    await expect(page.locator('.pending-state')).toBeVisible();

    // 2. Lecturer updates roster mid-flight and provisions student repo
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_LATE_ADD,
      roster: [
        { student_number: '0111111', full_name: 'Initial Student', github_login: 'student-initial' },
        { student_number: '0222222', full_name: 'Leo LateAdd', github_login: 'student-late-add' },
      ],
      assignments: {
        'lab-midflight-roster': {
          id: 'lab-midflight-roster',
          title: 'Midflight Roster Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          roster_mode: 'enforced',
        },
      },
      userRepos: [
        {
          name: repoName,
          full_name: `${ORG}/${repoName}`,
          html_url: `https://github.com/${ORG}/${repoName}`,
        },
      ],
    });

    // Student reloads page to resume
    await page.reload();

    // Verification: successfully recovered and provisioned
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();
    await expect(page.locator('a.repo-link')).toContainText(`${ORG}/${repoName}`);
  });

  test('Scenario 5 (Pre-Assigned Group Assignment): Maps student directly to pre-assigned group repository, flags missing group mapping', async ({ page }) => {
    const STUDENT_PREASSIGNED = { login: 'student-pre', name: 'Paula PreAssigned', token: 'mock_pre_token' };
    const STUDENT_UNMAPPED = { login: 'student-unmapped', name: 'Uma Unmapped', token: 'mock_unmapped_token' };

    // 1. Student WITH pre-assigned team in roster
    await injectAuth(page, STUDENT_PREASSIGNED);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_PREASSIGNED,
      roster: [
        { student_number: '0333333', full_name: 'Paula PreAssigned', github_login: 'student-pre', team_slug: 'team-phoenix', team_name: 'Phoenix Squad' },
      ],
      assignments: {
        'group-preassigned-lab': {
          id: 'group-preassigned-lab',
          title: 'Pre-Assigned Group Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: {
            formation_mode: 'pre-assigned',
            max_team_size: 4,
          },
        },
      },
      teams: {
        'group-preassigned-lab': [
          {
            team_slug: 'team-phoenix',
            team_name: 'Phoenix Squad',
            members: ['student-pre'],
            is_full: false,
            member_count: 1,
            max_members: 4,
          },
        ],
      },
      userRepos: [
        {
          name: 'group-preassigned-lab-team-phoenix',
          full_name: `${ORG}/group-preassigned-lab-team-phoenix`,
          html_url: `https://github.com/${ORG}/group-preassigned-lab-team-phoenix`,
        },
      ],
    });

    await page.goto(`/${ORG}/a/group-preassigned-lab`);

    // Directly renders pre-assigned team without manual create/join tabs
    await expect(page.locator('h2', { hasText: 'Your team repository is ready!' })).toBeVisible();
    await expect(page.locator('.team-badge-banner')).toContainText('team-phoenix');

    // 2. Student on roster but WITHOUT group mapping receives clear 'No Pre-Assigned Team' notice
    await injectAuth(page, STUDENT_UNMAPPED);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_UNMAPPED,
      roster: [
        { student_number: '0444444', full_name: 'Uma Unmapped', github_login: 'student-unmapped' },
      ],
      assignments: {
        'group-preassigned-lab': {
          id: 'group-preassigned-lab',
          title: 'Pre-Assigned Group Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: {
            formation_mode: 'pre-assigned',
            max_team_size: 4,
          },
        },
      },
      teams: {
        'group-preassigned-lab': [],
      },
    });

    await page.goto(`/${ORG}/a/group-preassigned-lab`);
    await expect(page.locator('h3', { hasText: 'No Pre-Assigned Team' })).toBeVisible();
  });

  test('Scenario 6 (Lifecycle Out-of-Order Gating): Gating banners properly block acceptance for draft, future opening, and closed assignments', async ({ page }) => {
    await injectAuth(page, STUDENT_1);

    // 1. Draft assignment state
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'lab-draft': {
          id: 'lab-draft',
          title: 'Draft Assignment',
          organization: ORG,
          state: 'draft',
        },
      },
    });

    await page.goto(`/${ORG}/a/lab-draft`);
    await expect(page.locator('h2', { hasText: 'Assignment not open yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept assignment' })).not.toBeVisible();

    // 2. Future opening date
    const futureOpening = new Date(Date.now() + 3600 * 1000 * 24).toISOString();
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'lab-future-open': {
          id: 'lab-future-open',
          title: 'Future Opening Lab',
          organization: ORG,
          state: 'published',
          opens_at: futureOpening,
        },
      },
    });

    await page.goto(`/${ORG}/a/lab-future-open`);
    await expect(page.locator('h2', { hasText: 'Assignment not open yet' })).toBeVisible();
    await expect(page.locator('.acceptance-card')).toContainText('Opens');

    // 3. Closed assignment
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'lab-closed': {
          id: 'lab-closed',
          title: 'Closed Lab',
          organization: ORG,
          state: 'closed',
        },
      },
    });

    await page.goto(`/${ORG}/a/lab-closed`);
    await expect(page.locator('h2', { hasText: 'Assignment closed' })).toBeVisible();
  });

  test('Scenario 7 (Registration Cap Exhaustion): Blocks acceptance and displays cap reached notice when cohort limit is reached', async ({ page }) => {
    const STUDENT_OVERFLOW = { login: 'student-overflow', name: 'Otto Overflow', token: 'mock_overflow_token' };

    await injectAuth(page, STUDENT_OVERFLOW);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_OVERFLOW,
      assignments: {
        'lab-capped': {
          id: 'lab-capped',
          title: 'Strictly Capped Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          max_acceptances: 2,
          accepted_count: 2,
        },
      },
      userRepos: [],
    });

    await page.goto(`/${ORG}/a/lab-capped`);

    // Verify registration cap reached notice and absence of accept button
    await expect(page.locator('h2', { hasText: 'Registration cap reached' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept assignment' })).not.toBeVisible();
  });

  test('Scenario 8 (Pending Collaboration Invitation Workflow): Displays invitation notification and transitions to provisioned upon accept', async ({ page }) => {
    const STUDENT_INVITED = { login: 'student-invited', name: 'Iris Invited', token: 'mock_invited_token' };
    const repoName = 'lab-invite-student-invited';

    await injectAuth(page, STUDENT_INVITED);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_INVITED,
      assignments: {
        'lab-invite': {
          id: 'lab-invite',
          title: 'Invite Flow Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
        },
      },
      invitations: [
        {
          id: 778899,
          repository: {
            name: repoName,
            full_name: `${ORG}/${repoName}`,
            html_url: `https://github.com/${ORG}/${repoName}`,
            owner: { login: ORG },
          },
        },
      ],
    });

    await page.goto(`/${ORG}/a/lab-invite`);

    // Verify pending invitation state
    await expect(page.locator('h2', { hasText: 'Repository invitation pending' })).toBeVisible();
    const acceptInviteBtn = page.locator('button', { hasText: 'Accept invitation' });
    await expect(acceptInviteBtn).toBeVisible();

    // Student clicks to accept the GitHub invitation
    await acceptInviteBtn.click();

    // Successfully moves to provisioned state
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();
  });

  test('Scenario 9 (Provisioning Polling Timeout & Check Again Recovery): Recovers to provisioned state when student checks again after delay', async ({ page }) => {
    const STUDENT_TIMEOUT = { login: 'student-timeout', name: 'Tina Timeout', token: 'mock_timeout_token' };
    const expectedRepo = 'lab-timeout-student-timeout';

    await injectAuth(page, STUDENT_TIMEOUT);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_TIMEOUT,
      assignments: {
        'lab-timeout': {
          id: 'lab-timeout',
          title: 'Timeout Recovery Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
        },
      },
      userRepos: [], // initially no repo
    });

    await page.goto(`/${ORG}/a/lab-timeout`);
    const acceptBtn = page.getByRole('button', { name: 'Accept assignment' });
    await expect(acceptBtn).toBeVisible();
    await acceptBtn.click();

    // Verify pending state
    await expect(page.locator('.pending-state')).toBeVisible();

    // Now repo finishes provisioning on GitHub Actions side
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_TIMEOUT,
      assignments: {
        'lab-timeout': {
          id: 'lab-timeout',
          title: 'Timeout Recovery Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
        },
      },
      userRepos: [
        {
          name: expectedRepo,
          full_name: `${ORG}/${expectedRepo}`,
          html_url: `https://github.com/${ORG}/${expectedRepo}`,
        },
      ],
    });

    // Student refreshes / checks again
    await page.reload();
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();
    await expect(page.locator('a.repo-link')).toContainText(`${ORG}/${expectedRepo}`);
  });

  test('Scenario 10 (Idempotent Resumption & Multi-Device Continuity): Resuming an already-provisioned assignment immediately loads repository state', async ({ page }) => {
    const STUDENT_RETURNING = { login: 'student-returning', name: 'Rachel Returning', token: 'mock_returning_token' };
    const repoName = 'lab-idempotent-student-returning';

    await injectAuth(page, STUDENT_RETURNING);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_RETURNING,
      assignments: {
        'lab-idempotent': {
          id: 'lab-idempotent',
          title: 'Idempotent Continuity Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: new Date(Date.now() + 3600 * 1000 * 96).toISOString(),
        },
      },
      userRepos: [
        {
          name: repoName,
          full_name: `${ORG}/${repoName}`,
          html_url: `https://github.com/${ORG}/${repoName}`,
        },
      ],
    });

    await page.goto(`/${ORG}/a/lab-idempotent`);

    // Directly renders ready repository view without showing accept button or duplicating repos
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept assignment' })).not.toBeVisible();
    await expect(page.locator('.student-status-card')).toBeVisible();
    await expect(page.locator('.deadline-countdown')).toContainText(/Closes in \d+d/i);
  });
});
