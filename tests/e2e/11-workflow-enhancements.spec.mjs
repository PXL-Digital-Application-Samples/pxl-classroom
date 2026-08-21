import { test, expect } from '@playwright/test';
import { setupStandardMockRoutes, injectAuth, LECTURER } from '../fixtures/e2e-fixtures.mjs';

const ORG = 'PXL-2TIN-CloudEssentials-2627';
const STUDENT_EXTENDED = { login: 'student-extended', name: 'Eve Extended', token: 'mock_extended_token' };

test.describe('11 - Workflow & UX Enhancements (Quick Filters, Student Status Card, Freeze Dialog, Diff Preview)', () => {
  test('Scenario 1 (Status Quick-Filter Chips in Dashboard): Instantly filters students by On-time, Late, No-submission, and Preserved', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 24).toISOString();

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-quick-filter': {
          id: 'lab-quick-filter',
          title: 'Quick Filter Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
      reports: {
        'lab-quick-filter': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-quick-filter',
          students: [
            {
              github_login: 'student-ontime',
              name: 'Alice OnTime',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              preservation_status: 'preserved',
              preserved_sha: 'c0ffee1111111111111111111111111111111111',
              commit_count: 4,
              repo_name: `${ORG}/lab-quick-filter-student-ontime`,
            },
            {
              github_login: 'student-late',
              name: 'Bob Late',
              acceptance_state: 'accepted',
              submission_status: 'late',
              preservation_status: 'failed',
              commit_count: 7,
              repo_name: `${ORG}/lab-quick-filter-student-late`,
            },
            {
              github_login: 'student-nosub',
              name: 'Charlie NoSub',
              acceptance_state: 'accepted',
              submission_status: 'no-submission',
              commit_count: 1,
              repo_name: `${ORG}/lab-quick-filter-student-nosub`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-quick-filter`);

    // Verify all 3 students shown by default
    await expect(page.locator('tr', { hasText: 'student-ontime' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-late' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-nosub' })).toBeVisible();

    // 1. Click 'On-time' quick-filter pill
    await page.locator('.quick-filter-pills .tab-pill', { hasText: /On-time/i }).click();
    await expect(page.locator('tr', { hasText: 'student-ontime' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-late' })).not.toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-nosub' })).not.toBeVisible();

    // 2. Click 'Late' quick-filter pill
    await page.locator('.quick-filter-pills .tab-pill', { hasText: /Late/i }).click();
    await expect(page.locator('tr', { hasText: 'student-late' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-ontime' })).not.toBeVisible();

    // 3. Click 'No sub' quick-filter pill
    await page.locator('.quick-filter-pills .tab-pill', { hasText: /No sub/i }).click();
    await expect(page.locator('tr', { hasText: 'student-nosub' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-ontime' })).not.toBeVisible();

    // 4. Click 'Preserved' quick-filter pill
    await page.locator('.quick-filter-pills .tab-pill', { hasText: /Preserved/i }).click();
    await expect(page.locator('tr', { hasText: 'student-ontime' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-late' })).not.toBeVisible();

    // 5. Click 'All' pill to reset
    await page.locator('.quick-filter-pills .tab-pill', { hasText: /All/i }).click();
    await expect(page.locator('tr', { hasText: 'student-ontime' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-late' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-nosub' })).toBeVisible();
  });

  test('Scenario 2 (Teams View Quick Filters): Filters teams by On-time, Late, and Under-capacity', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'group-filter-test': {
          id: 'group-filter-test',
          title: 'Group Filter Test',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: { max_team_size: 3 },
        },
      },
      reports: {
        'group-filter-test': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'group-filter-test',
          students: [
            { github_login: 'student-alpha', name: 'Alpha', acceptance_state: 'accepted', team_slug: 'team-alpha', submission_status: 'on-time' },
            { github_login: 'student-beta', name: 'Beta', acceptance_state: 'accepted', team_slug: 'team-beta', submission_status: 'late' },
            { github_login: 'student-gamma', name: 'Gamma', acceptance_state: 'accepted', team_slug: 'team-gamma', submission_status: 'on-time' },
          ],
          teams: [
            {
              team_slug: 'team-alpha',
              team_name: 'Team Alpha (Full On-Time)',
              members: ['student-alpha', 'student-m2', 'student-m3'],
              submission_status: 'on-time',
              under_capacity: false,
              repo_name: `${ORG}/group-filter-test-team-alpha`,
            },
            {
              team_slug: 'team-beta',
              team_name: 'Team Beta (Late)',
              members: ['student-beta', 'student-m4'],
              submission_status: 'late',
              under_capacity: false,
              repo_name: `${ORG}/group-filter-test-team-beta`,
            },
            {
              team_slug: 'team-gamma',
              team_name: 'Team Gamma (Under Capacity)',
              members: ['student-gamma'],
              submission_status: 'on-time',
              under_capacity: true,
              repo_name: `${ORG}/group-filter-test-team-gamma`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/group-filter-test`);

    // Switch to Teams View
    await page.locator('.tab-pill', { hasText: /Teams View/i }).click();

    // Verify all 3 teams shown
    await expect(page.locator('tr', { hasText: 'team-alpha' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'team-beta' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'team-gamma' })).toBeVisible();

    // 1. Filter Under-capacity teams
    await page.locator('.team-quick-filters .tab-pill', { hasText: /Under-capacity/i }).click();
    await expect(page.locator('tr', { hasText: 'team-gamma' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'team-alpha' })).not.toBeVisible();
    await expect(page.locator('tr', { hasText: 'team-beta' })).not.toBeVisible();

    // 2. Filter Late teams
    await page.locator('.team-quick-filters .tab-pill', { hasText: /Late/i }).click();
    await expect(page.locator('tr', { hasText: 'team-beta' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'team-alpha' })).not.toBeVisible();

    // 3. Filter On-time teams
    await page.locator('.team-quick-filters .tab-pill', { hasText: /On-time/i }).click();
    await expect(page.locator('tr', { hasText: 'team-alpha' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'team-gamma' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'team-beta' })).not.toBeVisible();
  });

  test('Scenario 3 (Student Submission Status & Countdown): Displays on-time status, countdown timer, and extension banner', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 12).toISOString();
    const extendedDeadline = new Date(Date.now() + 3600 * 1000 * 36).toISOString();

    await injectAuth(page, STUDENT_EXTENDED);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_EXTENDED,
      userRepos: [
        {
          name: 'lab-extended-student-extended',
          full_name: `${ORG}/lab-extended-student-extended`,
          html_url: `https://github.com/${ORG}/lab-extended-student-extended`,
        },
      ],
      assignments: {
        'lab-extended': {
          id: 'lab-extended',
          title: 'Lab Extended Feature',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
    });

    await page.goto(`/${ORG}/a/lab-extended`);

    // Verify Provisioned State
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();

    // Verify Submission Status Card
    const statusCard = page.locator('.student-status-card');
    await expect(statusCard).toBeVisible();

    // Verify active extension announcement banner
    await expect(statusCard.locator('.override-alert-banner')).toContainText('Deadline Extended');
    await expect(statusCard.locator('.override-alert-banner')).toContainText('Approved medical extension');

    // Verify on-time status badge (because commit was before extended deadline)
    await expect(statusCard.locator('.badge-success')).toContainText('Submitted on-time');

    // Verify countdown timer indicates time remaining under extension
    await expect(statusCard.locator('.deadline-countdown')).toContainText(/Closes in \d+d/i);
  });

  test('Scenario 4 (Freeze & Lockdown with Consequences Confirmation Dialog): Displays full impact warning before workflow trigger', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 24).toISOString();

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-freeze-test': {
          id: 'lab-freeze-test',
          title: 'Freeze Test Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
      reports: {
        'lab-freeze-test': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-freeze-test',
          students: [
            {
              github_login: 'student-1',
              name: 'Student 1',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              repo_name: `${ORG}/lab-freeze-test-student-1`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-freeze-test`);

    // 1. Click 'Freeze & Preserve Now' button in preservation banner
    const freezeBtn = page.locator('button', { hasText: 'Freeze & Preserve Now' });
    await expect(freezeBtn).toBeVisible();
    await freezeBtn.click();

    // 2. Verify Confirmation Modal & Consequences Explanation
    const modal = page.locator('.modal-consequences');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h3')).toContainText('Confirm Immediate Freeze & Lockdown');

    // Verify 3 key consequence points are rendered
    await expect(modal).toContainText('Demotes Student Permissions to Read-Only');
    await expect(modal).toContainText('Snapshots Immutable Archive Commits');
    await expect(modal).toContainText('Locks Deadline Classification');

    // 3. Confirm Lockdown
    const confirmBtn = modal.locator('button', { hasText: 'Confirm Freeze & Lockdown' });
    await confirmBtn.click();

    // Verify modal closes and success toast triggers
    await expect(modal).not.toBeVisible();
    await expect(page.locator('.toast', { hasText: /Lockdown and preservation workflow triggered/i })).toBeVisible();
  });

  test('Scenario 5 (Starter Code Sync Diff Preview): Expands inline git diff patch before syncing updates', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-sync-diff': {
          id: 'lab-sync-diff',
          title: 'Starter Sync Diff Test',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          template: { owner: ORG, repository: 'template-python' },
        },
      },
      reports: {
        'lab-sync-diff': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-sync-diff',
          students: [
            {
              github_login: 'student-1',
              name: 'Student 1',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              repo_name: `${ORG}/lab-sync-diff-student-1`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-sync-diff`);

    // 1. Open Starter Code Sync Modal
    await page.locator('button', { hasText: /Sync Starter Code/i }).click();
    const modal = page.locator('.starter-sync-modal');
    await expect(modal).toBeVisible();

    // 2. Locate README.md file row and verify diff toggle
    const readmeRow = modal.locator('.file-row-box', { hasText: 'README.md' });
    await expect(readmeRow).toBeVisible();

    const diffToggle = readmeRow.locator('.diff-toggle-btn');
    await expect(diffToggle).toContainText('View Diff');

    // 3. Click 'View Diff' to expand
    await diffToggle.click();
    await expect(diffToggle).toContainText('Hide Diff');

    // Verify diff patch container rendered with added line
    const diffContainer = readmeRow.locator('.diff-patch-view-container');
    await expect(diffContainer).toBeVisible();
    await expect(diffContainer).toContainText('+Updated Assignment Guidelines for 2026');

    // 4. Click 'Hide Diff' to collapse
    await diffToggle.click();
    await expect(diffToggle).toContainText('View Diff');
    await expect(diffContainer).not.toBeVisible();
  });
});
