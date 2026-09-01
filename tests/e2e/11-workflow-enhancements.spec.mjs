import { test, expect } from '@playwright/test';
import { setupStandardMockRoutes, injectAuth, LECTURER, openStarterSyncModal, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

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
              full_name: 'Alice OnTime',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              preservation_status: 'preserved',
              preserved_sha: 'c0ffee1111111111111111111111111111111111',
              commit_count: 4,
              repo_name: `${ORG}/lab-quick-filter-student-ontime`,
            },
            {
              github_login: 'student-late',
              full_name: 'Bob Late',
              acceptance_state: 'accepted',
              submission_status: 'late',
              preservation_status: 'failed',
              commit_count: 7,
              repo_name: `${ORG}/lab-quick-filter-student-late`,
            },
            {
              github_login: 'student-nosub',
              full_name: 'Charlie NoSub',
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

    await page.goto(inviteUrl(ORG, 'lab-extended'));

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
    await openStarterSyncModal(page);
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

  test('Scenario 6 (Interactive Summary Cards & Combined Search Filtering): Clicking summary cards and typing in search narrows cohort table', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 24).toISOString();

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-summary-filter': {
          id: 'lab-summary-filter',
          title: 'Summary Filter Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
      reports: {
        'lab-summary-filter': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-summary-filter',
          students: [
            {
              // `full_name`, not `name`. report.schema.json declares full_name
              // and is additionalProperties:false, so `name` is a field the
              // backend never writes - and this fixture only worked because the
              // view read `s.name` as a fallback, which was the same
              // mis-spelling as the `s.status` that broke the accepted count.
              github_login: 'student-ontime',
              full_name: 'Alice OnTime',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              preservation_status: 'preserved',
              commit_count: 4,
              repo_name: `${ORG}/lab-summary-filter-student-ontime`,
            },
            {
              github_login: 'student-late',
              full_name: 'Bob Late',
              acceptance_state: 'accepted',
              submission_status: 'late',
              commit_count: 7,
              repo_name: `${ORG}/lab-summary-filter-student-late`,
            },
            {
              github_login: 'student-nosub',
              full_name: 'Charlie NoSub',
              acceptance_state: 'accepted',
              submission_status: 'no-submission',
              commit_count: 1,
              repo_name: `${ORG}/lab-summary-filter-student-nosub`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-summary-filter`);

    // 1. Click 'Late' summary counter card
    const lateCard = page.locator('.summary-card', { hasText: 'Late' });
    await expect(lateCard).toBeVisible();
    await lateCard.click();

    // Verify only late student is shown
    await expect(page.locator('tr', { hasText: 'student-late' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-ontime' })).not.toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-nosub' })).not.toBeVisible();
    await expect(page.locator('.table-footer')).toContainText('1 of 3 students shown');

    // 2. Click 'On-time' summary card
    const ontimeCard = page.locator('.summary-card', { hasText: 'On-time' });
    await ontimeCard.click();
    await expect(page.locator('tr', { hasText: 'student-ontime' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-late' })).not.toBeVisible();

    // 3. Reset via 'Students' summary card
    const allCard = page.locator('.summary-card', { hasText: 'Students' });
    await allCard.click();
    await expect(page.locator('tr', { hasText: 'student-ontime' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-late' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-nosub' })).toBeVisible();

    // 4. Test Search filter combined with status
    const searchInput = page.locator('input.search-input');
    await searchInput.fill('Charlie');
    await expect(page.locator('tr', { hasText: 'student-nosub' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-ontime' })).not.toBeVisible();
    await expect(page.locator('tr', { hasText: 'student-late' })).not.toBeVisible();
  });

  test('Scenario 7 (Student View - Unextended Late Submission): Displays warning badge and deadline passed countdown without override banner', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 24).toISOString();
    const STUDENT_LATE = { login: 'student-late', name: 'Bob Late', token: 'mock_late_token' };

    await injectAuth(page, STUDENT_LATE);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_LATE,
      userRepos: [
        {
          name: 'lab-late-student-student-late',
          full_name: `${ORG}/lab-late-student-student-late`,
          html_url: `https://github.com/${ORG}/lab-late-student-student-late`,
        },
      ],
      assignments: {
        'lab-late-student': {
          id: 'lab-late-student',
          title: 'Late Student Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
    });

    await page.goto(inviteUrl(ORG, 'lab-late-student'));

    // Verify Provisioned State
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();

    const statusCard = page.locator('.student-status-card');
    await expect(statusCard).toBeVisible();

    // Verify late badge
    await expect(statusCard.locator('.badge-warning')).toContainText('Submitted late');

    // Verify deadline passed countdown text
    await expect(statusCard.locator('.deadline-countdown')).toContainText('Deadline passed');

    // Verify latest commit SHA is displayed
    await expect(statusCard.locator('.latest-commit-info')).toContainText('deadbee');

    // Verify NO extension override alert is present
    await expect(statusCard.locator('.override-alert-banner')).not.toBeVisible();
  });

  test('Scenario 8 (Student View - No Commits Pushed with Active Countdown): Displays neutral badge and active countdown', async ({ page }) => {
    const futureDeadline = new Date(Date.now() + 3600 * 1000 * 48).toISOString();
    const STUDENT_UNSTARTED = { login: 'student-unstarted', name: 'Charlie Unstarted', token: 'mock_unstarted_token' };

    await injectAuth(page, STUDENT_UNSTARTED);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_UNSTARTED,
      userRepos: [
        {
          name: 'lab-unstarted-student-unstarted',
          full_name: `${ORG}/lab-unstarted-student-unstarted`,
          html_url: `https://github.com/${ORG}/lab-unstarted-student-unstarted`,
        },
      ],
      assignments: {
        'lab-unstarted': {
          id: 'lab-unstarted',
          title: 'Unstarted Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: futureDeadline,
        },
      },
    });

    await page.goto(inviteUrl(ORG, 'lab-unstarted'));

    // Verify Provisioned State
    await expect(page.locator('h2', { hasText: 'Your repository is ready!' })).toBeVisible();

    const statusCard = page.locator('.student-status-card');
    await expect(statusCard).toBeVisible();

    // Verify 'No commits pushed' badge
    await expect(statusCard.locator('.badge-neutral')).toContainText('No commits pushed');

    // Verify active countdown timer indicates days remaining
    await expect(statusCard.locator('.deadline-countdown')).toContainText(/Closes in \d+d/i);

    // Verify no latest commit info is rendered
    await expect(statusCard.locator('.latest-commit-info')).not.toBeVisible();
  });

  test('Scenario 9 (Group Assignment - Team Submission Status in Student View): Renders team status, team commit, and deadline countdown in GroupAcceptanceCard', async ({ page }) => {
    const futureDeadline = new Date(Date.now() + 3600 * 1000 * 24).toISOString();
    const STUDENT_MEMBER = { login: 'student-alice', name: 'Alice TeamLead', token: 'mock_alice_token' };

    await injectAuth(page, STUDENT_MEMBER);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_MEMBER,
      userRepos: [
        {
          name: 'group-status-lab-team-alpha',
          full_name: `${ORG}/group-status-lab-team-alpha`,
          html_url: `https://github.com/${ORG}/group-status-lab-team-alpha`,
        },
      ],
      assignments: {
        'group-status-lab': {
          id: 'group-status-lab',
          title: 'Group Status Lab',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          deadline_at: futureDeadline,
          group_config: { max_team_size: 3 },
        },
      },
      teams: {
        'group-status-lab': [
          {
            team_slug: 'team-alpha',
            team_name: 'Team Alpha',
            members: ['student-alice', 'student-bob'],
            is_full: false,
            member_count: 2,
            max_members: 3,
          },
        ],
      },
    });

    await page.goto(inviteUrl(ORG, 'group-status-lab'));

    // Verify Team Provisioned State
    await expect(page.locator('h2', { hasText: 'Your team repository is ready!' })).toBeVisible();

    // Verify Team Submission Status Card
    const teamStatusCard = page.locator('.team-status-card');
    await expect(teamStatusCard).toBeVisible();

    // Verify on-time badge
    await expect(teamStatusCard.locator('.badge-success')).toContainText('Submitted on-time');

    // Verify countdown timer
    await expect(teamStatusCard.locator('.deadline-countdown')).toContainText(/Closes in \d+d|Closes in \d+h/i);

    // Verify latest team commit SHA
    await expect(teamStatusCard.locator('.latest-commit-info')).toContainText('c0ffee1');
  });

  test('Scenario 10 (Freeze Consequences Modal Dismissal Flows): Modal can be safely dismissed via Cancel button, close X, and backdrop without triggering lockdown', async ({ page }) => {
    const pastDeadline = new Date(Date.now() - 3600 * 1000 * 24).toISOString();

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-freeze-dismiss': {
          id: 'lab-freeze-dismiss',
          title: 'Freeze Dismiss Test',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          deadline_at: pastDeadline,
        },
      },
      reports: {
        'lab-freeze-dismiss': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-freeze-dismiss',
          students: [
            {
              github_login: 'student-1',
              name: 'Student 1',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              repo_name: `${ORG}/lab-freeze-dismiss-student-1`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-freeze-dismiss`);

    const freezeBtn = page.locator('button', { hasText: 'Freeze & Preserve Now' });
    const modal = page.locator('.modal-consequences');

    // 1. Open and Dismiss via 'Cancel' button
    await freezeBtn.click();
    await expect(modal).toBeVisible();
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();

    // 2. Open and Dismiss via '×' close button
    await freezeBtn.click();
    await expect(modal).toBeVisible();
    await modal.locator('.modal-close').click();
    await expect(modal).not.toBeVisible();

    // 3. Open and Dismiss via backdrop overlay click
    await freezeBtn.click();
    await expect(modal).toBeVisible();
    await page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(modal).not.toBeVisible();

    // Verify no trigger toast was triggered during any dismissal
    await expect(page.locator('.toast', { hasText: /Lockdown and preservation workflow triggered/i })).not.toBeVisible();
  });

  test('Scenario 11 (Starter Sync Multi-File Diff Preview & Selection Interactivity): Supports simultaneous diff views, patch inspection, and file toggling', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {
        'lab-sync-multi-diff': {
          id: 'lab-sync-multi-diff',
          title: 'Starter Sync Multi Diff Test',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          template: { owner: ORG, repository: 'template-multi-diff' },
        },
      },
      reports: {
        'lab-sync-multi-diff': {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignment_id: 'lab-sync-multi-diff',
          students: [
            {
              github_login: 'student-1',
              name: 'Student 1',
              acceptance_state: 'accepted',
              submission_status: 'on-time',
              repo_name: `${ORG}/lab-sync-multi-diff-student-1`,
            },
          ],
        },
      },
    });

    await page.goto(`/dashboard/${ORG}/lab-sync-multi-diff`);

    // 1. Open Starter Code Sync Modal
    await openStarterSyncModal(page);
    const modal = page.locator('.starter-sync-modal');
    await expect(modal).toBeVisible();

    // 2. Expand Diff for tests/test_validation.py
    const testRow = modal.locator('.file-row-box', { hasText: 'tests/test_validation.py' });
    await expect(testRow).toBeVisible();
    await testRow.locator('.diff-toggle-btn').click();
    await expect(testRow.locator('.diff-patch-view-container')).toContainText('+import unittest');
    await expect(testRow.locator('.diff-patch-view-container')).toContainText('+class TestValidation');

    // 3. Expand Diff for config.json simultaneously
    const configRow = modal.locator('.file-row-box', { hasText: 'config.json' });
    await expect(configRow).toBeVisible();
    await configRow.locator('.diff-toggle-btn').click();
    await expect(configRow.locator('.diff-patch-view-container')).toContainText('- "env": "dev"');
    await expect(configRow.locator('.diff-patch-view-container')).toContainText('+ "env": "prod"');

    // Both diffs are open
    await expect(testRow.locator('.diff-patch-view-container')).toBeVisible();
    await expect(configRow.locator('.diff-patch-view-container')).toBeVisible();

    // 4. Test Select / Deselect All
    await modal.getByRole('button', { name: 'Deselect all', exact: true }).click();
    await expect(modal.locator('.file-row-box input[type="checkbox"]:checked')).toHaveCount(0);

    await modal.getByRole('button', { name: 'Select all', exact: true }).click();
    await expect(modal.locator('.file-row-box input[type="checkbox"]:checked')).toHaveCount(3);

    // 5. Hide Diff on config.json while keeping test_validation.py open
    await configRow.locator('.diff-toggle-btn').click();
    await expect(configRow.locator('.diff-patch-view-container')).not.toBeVisible();
    await expect(testRow.locator('.diff-patch-view-container')).toBeVisible();
  });
});
