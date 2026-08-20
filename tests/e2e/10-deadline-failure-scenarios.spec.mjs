import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

test.describe('10 - Deadline Failure Modes, Edge Cases & Recovery Flows', () => {
  test('Scenario 1 (Registration Gating): Blocks late acceptance while preserving repository access for existing student', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 24).toISOString(); // 1 day ago

    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'lab-past-deadline': {
          id: 'lab-past-deadline',
          title: 'Lab Past Deadline',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
      reports: {
        'lab-past-deadline': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-past-deadline',
          students: [],
        },
      },
    });

    // 1. Unaccepted student visits past-deadline assignment -> Should see "Assignment closed"
    await page.goto(`/${ORG}/a/lab-past-deadline`);
    await expect(page.locator('h2', { hasText: 'Assignment closed' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Accept assignment' })).not.toBeVisible();

    // 2. Student who already accepted prior to deadline visits -> Repository link remains visible
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'lab-past-deadline': {
          id: 'lab-past-deadline',
          title: 'Lab Past Deadline',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
      userRepos: [
        {
          id: 991,
          name: `lab-past-deadline-${STUDENT_1.login}`,
          full_name: `${ORG}/lab-past-deadline-${STUDENT_1.login}`,
          html_url: `https://github.com/${ORG}/lab-past-deadline-${STUDENT_1.login}`,
          clone_url: `https://github.com/${ORG}/lab-past-deadline-${STUDENT_1.login}.git`,
        },
      ],
    });

    await page.goto(`/${ORG}/a/lab-past-deadline`);
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();
    await expect(page.locator(`text=${ORG}/lab-past-deadline-${STUDENT_1.login}`)).toBeVisible();
  });

  test('Scenario 2 (Group Registration Gating): Blocks late team joining or creation', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 48).toISOString();

    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'group-past-deadline': {
          id: 'group-past-deadline',
          title: 'Group Past Deadline',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          deadline_at: pastDeadline,
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
          },
        },
      },
      reports: {
        'group-past-deadline': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'group-past-deadline',
          students: [],
          teams: [],
        },
      },
    });

    await page.goto(`/${ORG}/a/group-past-deadline`);
    await expect(page.locator('h2', { hasText: 'Assignment closed' })).toBeVisible();
    await expect(page.locator('button', { hasText: /Join Team|Create & Join Team/i })).not.toBeVisible();
  });

  test('Scenario 3 (Cohort Classification): Distinguishes on-time, late, unstarted (1 commit), and roster ghosts', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 12).toISOString();

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-cohort-deadline': {
          id: 'lab-cohort-deadline',
          title: 'Lab Cohort Deadline Classification',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
      reports: {
        'lab-cohort-deadline': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-cohort-deadline',
          students: [
            {
              github_login: 'student-ontime',
              name: 'Alice OnTime',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              commit_count: 5,
              repo_name: `${ORG}/lab-cohort-deadline-student-ontime`,
            },
            {
              github_login: 'student-late',
              name: 'Bob Late',
              acceptance_state: 'accepted',
              submission_status: 'late',
              commit_count: 8,
              first_late_sha: 'deadbeef12345678',
              late_commits: 2,
              repo_name: `${ORG}/lab-cohort-deadline-student-late`,
            },
            {
              github_login: 'student-unstarted',
              name: 'Charlie Unstarted',
              acceptance_state: 'accepted',
              submission_status: 'no-submission',
              commit_count: 1,
              repo_name: `${ORG}/lab-cohort-deadline-student-unstarted`,
            },
            {
              github_login: 'student-ghost',
              name: 'Dave Ghost',
              acceptance_state: 'not_accepted',
              submission_status: 'no-submission',
              commit_count: 0,
              repo_name: null,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-cohort-deadline`);

    // 1. On-time student badge
    const ontimeRow = page.locator('tr', { hasText: 'student-ontime' });
    await expect(ontimeRow.locator('.badge-success')).toContainText('on-time');

    // 2. Late student badge
    const lateRow = page.locator('tr', { hasText: 'student-late' });
    await expect(lateRow.locator('.badge-warning')).toContainText('late');

    // 3. Unstarted student badge (1 commit)
    const unstartedRow = page.locator('tr', { hasText: 'student-unstarted' });
    await expect(unstartedRow.locator('.badge', { hasText: 'no-submission' })).toBeVisible();

    // 4. Roster ghost student badge (not accepted)
    const ghostRow = page.locator('tr', { hasText: 'student-ghost' });
    await expect(ghostRow.locator('.badge', { hasText: 'no-submission' })).toBeVisible();
    await expect(ghostRow.locator('.badge', { hasText: /not[-_ ]accepted/i })).toBeVisible();
  });

  test('Scenario 4 (Deadline Overrides): Reclassifies post-deadline push to on-time when extension is granted', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 48).toISOString();
    const futureExtension = new Date(Date.now() + 3600 * 1000 * 48).toISOString();

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-extended': {
          id: 'lab-extended',
          title: 'Lab Extended Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
      reports: {
        'lab-extended': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-extended',
          students: [
            {
              github_login: 'student-extended',
              name: 'Eve Extended',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              effective_deadline_at: futureExtension,
              override_applied: true,
              override_reason: 'Approved medical extension (3 days)',
              commit_count: 6,
              repo_name: `${ORG}/lab-extended-student-extended`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-extended`);

    const studentRow = page.locator('tr', { hasText: 'student-extended' });
    await expect(studentRow.locator('.badge-success')).toContainText('on-time');
    // Verify extension note is visible
    await expect(studentRow.locator('.ext-note')).toContainText('ext ->');
  });

  test('Scenario 5 (Preservation & Lockdown Banner): Displays delay, flags missing snapshot, and triggers targeted retry', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 24).toISOString();
    const lockdownTime = new Date(Date.now() - 3600 * 1000 * 24 + 22000).toISOString();

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-preservation': {
          id: 'lab-preservation',
          title: 'Lab Preservation Banner',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
      reports: {
        'lab-preservation': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-preservation',
          lockdown_at: lockdownTime,
          uncertainty_seconds: 22,
          students: [
            {
              github_login: 'student-1',
              name: 'Student 1',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              preservation_status: 'preserved',
              preserved_sha: 'c0ffee1234567890abcdef1234567890abcdef12',
              repo_name: `${ORG}/lab-preservation-student-1`,
            },
            {
              github_login: 'student-2',
              name: 'Student 2',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              preservation_status: 'failed',
              preserved_sha: null,
              repo_name: `${ORG}/lab-preservation-student-2`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-preservation`);

    // 1. Inspect Post-Deadline Preservation Summary Banner
    const banner = page.locator('.card.preservation-banner');
    await expect(banner).toBeVisible();
    await expect(banner.locator('.preservation-banner-title')).toContainText('Preservation & Lockdown Status');
    await expect(banner).toContainText('1/2 Preserved');
    await expect(banner).toContainText('(delay: 22s)');

    // 2. Inspect Student 1 archive link
    const s1Row = page.locator('tr', { hasText: 'student-1' });
    const archiveLink = s1Row.locator('a[href*="pxl-classroom-archive/tree/preserved"]');
    await expect(archiveLink).toBeVisible();

    // 3. Retry Preservation Button for Student 2 (unpreserved)
    const retryBtn = banner.locator('button', { hasText: 'Retry Preservation (1)' });
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();
    await expect(retryBtn).toBeVisible();
  });

  test('Scenario 6 (Group Deadline States): Highlights under-capacity teams and propagates late team submissions', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 36).toISOString();

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'group-deadline-states': {
          id: 'group-deadline-states',
          title: 'Group Deadline States',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          deadline_at: pastDeadline,
          group_config: {
            max_team_size: 3,
            formation_mode: 'self-service',
          },
        },
      },
      reports: {
        'group-deadline-states': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'group-deadline-states',
          students: [
            {
              github_login: 'student-alpha1',
              name: 'Alpha One',
              acceptance_state: 'accepted',
              team_slug: 'team-alpha',
              submission_status: 'on-time',
              repo_name: `${ORG}/group-deadline-states-team-alpha`,
            },
            {
              github_login: 'student-beta1',
              name: 'Beta One',
              acceptance_state: 'accepted',
              team_slug: 'team-beta',
              submission_status: 'late',
              first_late_sha: 'beefcafe1234',
              repo_name: `${ORG}/group-deadline-states-team-beta`,
            },
          ],
          teams: [
            {
              team_slug: 'team-alpha',
              team_name: 'Team Alpha (Low Capacity)',
              members: ['student-alpha1'],
              under_capacity: true,
              submission_status: 'on-time',
              repo_name: `${ORG}/group-deadline-states-team-alpha`,
            },
            {
              team_slug: 'team-beta',
              team_name: 'Team Beta (Late)',
              members: ['student-beta1'],
              under_capacity: false,
              submission_status: 'late',
              first_late_sha: 'beefcafe1234',
              repo_name: `${ORG}/group-deadline-states-team-beta`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-deadline-states`);

    // In Teams View:
    // Team Alpha has 1/3 members with warning badge
    const alphaRow = page.locator('tr', { hasText: 'team-alpha' });
    await expect(alphaRow.locator('.badge-warning')).toContainText('1/3 (low)');

    // Team Beta is marked Late
    const betaRow = page.locator('tr', { hasText: 'team-beta' });
    await expect(betaRow.locator('.badge-warning', { hasText: 'late' })).toBeVisible();

    // Switch to Students View and verify propagation
    await page.locator('.tab-pill', { hasText: 'Students View' }).click();
    const betaStudentRow = page.locator('tr', { hasText: 'student-beta1' });
    await expect(betaStudentRow.locator('.badge-warning', { hasText: 'late' })).toBeVisible();
  });
});
