import { test, expect } from '@playwright/test';
import { setupStandardMockRoutes, injectAuth, inviteUrl } from '../fixtures/e2e-fixtures.mjs';
import { parse as yamlParse } from 'yaml';

const ORG = 'PXL-2TIN-CloudEssentials-2627';
const LECTURER = { login: 'prof-cloud', name: 'Professor Cloud', token: 'mock_lecturer_token' };
const STUDENT_PERSONAL = { login: 'student-personal', name: 'Personal Student', email: 'personal.dev@gmail.com', token: 'mock_student_token' };

test.describe('13 - Workflow Diagnostics, Roster Management & Capacity Bumper', () => {

  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('Scenario 1 (Student Access Diagnostics & Account Checker): Detects personal account, evaluates diagnostic checks, and copies report', async ({ page }) => {
    const assignmentId = 'cloud-containers';
    const assignment = {
      id: assignmentId,
      title: 'Cloud Containers Lab',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'enforced',
      state: 'published',
      max_acceptances: 50,
      accepted_count: 5,
      template: { owner: ORG, repository: 'containers-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
    };

    await injectAuth(page, STUDENT_PERSONAL);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      currentUser: STUDENT_PERSONAL,
      roster: [
        { student_number: '0123456', full_name: 'Alice Example', email: 'alice@student.pxl.be', github_login: 'student-personal' },
      ],
    });

    await page.goto(inviteUrl(ORG, assignmentId));

    // Wait for assignment card to load
    await expect(page.getByRole('heading', { name: 'Accept assignment' })).toBeVisible();

    // Trigger acceptance to enter pending state
    await page.getByRole('button', { name: 'Accept assignment' }).click();
    await expect(page.getByRole('heading', { name: /Setting up your repository/i })).toBeVisible();

    // Open Troubleshoot Access modal
    await page.getByRole('button', { name: /Troubleshoot Access/i }).click();
    
    // Check modal contents
    const modal = page.locator('.student-diagnostics-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: /Access & Account Diagnostics/i })).toBeVisible();

    // Verify Personal GitHub Account warning is shown
    await expect(modal.locator('.diag-banner')).toContainText(/Personal GitHub Account Detected/i);
    await expect(modal).toContainText(/@gmail.com/);

    // Verify Copy Report action
    await modal.getByRole('button', { name: 'Copy Report' }).click();
    await expect(page.locator('.toast', { hasText: /Diagnostic report copied/i })).toBeVisible();

    // Close modal
    await modal.getByLabel('Close').click();
    await expect(modal).not.toBeVisible();
  });

  test('Scenario 2 (Roster Unlinked Filter & Copy Emails): Filters by unlinked/pending students and copies email list', async ({ page }) => {
    const sampleRoster = [
      { student_number: '0123456', full_name: 'Alice Linked', email: 'alice@student.pxl.be', class_group: '1TIN-A', github_login: 'alice-dev' },
      { student_number: '0123457', full_name: 'Bob Pending', email: 'bob@student.pxl.be', class_group: '1TIN-A' },
      { student_number: '0123458', full_name: 'Charlie Pending', email: 'charlie@student.pxl.be', class_group: '1TIN-B' },
    ];

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      roster: sampleRoster,
    });

    await page.goto(`/dashboard/${ORG}/admin`);

    // Switch to Roster tab
    await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();

    // Verify filter chips
    await expect(page.getByRole('button', { name: 'All (3)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Linked (1)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlinked / Pending (2)' })).toBeVisible();

    // Filter to Unlinked / Pending
    await page.getByRole('button', { name: 'Unlinked / Pending (2)' }).click();
    await expect(page.locator('.roster-table')).toContainText('Bob Pending');
    await expect(page.locator('.roster-table')).toContainText('Charlie Pending');
    await expect(page.locator('.roster-table')).not.toContainText('Alice Linked');

    // Copy Unlinked Emails
    const copyBtn = page.getByRole('button', { name: /Copy unlinked emails/i });
    await expect(copyBtn).toBeEnabled();
    await copyBtn.click();
    await expect(page.locator('.toast', { hasText: /Copied 2 unlinked email/i })).toBeVisible();
  });

  test('Scenario 3 (Quick Add Single Student): Appends individual student to roster without full CSV re-import', async ({ page }) => {
    const sampleRoster = [
      { student_number: '0123456', full_name: 'Alice Linked', email: 'alice@student.pxl.be', class_group: '1TIN-A', github_login: 'alice-dev' },
    ];

    const contentWrites = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      roster: sampleRoster,
      contentWrites,
    });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('button[role="tab"]', { hasText: 'Roster' }).click();

    // Click + Add student
    await page.getByRole('button', { name: '+ Add student' }).click();

    const modal = page.locator('.modal.card:has-text("Add Student to Roster")');
    await expect(modal).toBeVisible();

    // Fill form
    await modal.getByPlaceholder('e.g. 0123456').fill('0123499');
    await modal.getByPlaceholder('e.g. Alice Example').fill('Diana Prince');
    await modal.getByPlaceholder('e.g. alice.example@student.pxl.be').fill('diana.prince@student.pxl.be');
    await modal.getByPlaceholder('e.g. 1TIN-A').fill('1TIN-C');
    await modal.getByPlaceholder('e.g. alice-dev').fill('diana-gh');

    // Submit
    await modal.getByRole('button', { name: 'Add Student' }).click();

    // Verify toast & table update
    await expect(page.locator('.toast', { hasText: /Student Diana Prince added to roster/i })).toBeVisible();
    await expect(modal).not.toBeVisible();
    await expect(page.locator('.roster-table')).toContainText('Diana Prince');

    // THE OPTIONAL FIELDS WERE TYPED AND NEVER CHECKED. This test filled the
    // class group and the GitHub login and then asserted only the name, so
    // quick add could have dropped either on the floor and stayed green - and
    // `class_group` is what an assignment's cohort gate reads
    // (lib/class-groups.mjs), so losing it here is a student who cannot accept.
    const write = [...contentWrites].reverse().find((w) => w.path === 'students/roster.yml');
    expect(write, 'quick add must commit the roster').toBeTruthy();
    const added = yamlParse(write.content).students.find((s) => String(s.student_number) === '0123499');
    expect(added).toMatchObject({
      full_name: 'Diana Prince',
      class_group: '1TIN-C',
      github_login: 'diana-gh',
    });

    // And it comes back out on the row, which is the only place a lecturer sees it.
    await expect(page.locator('.roster-table')).toContainText('1TIN-C');
  });

  test('Scenario 4 (Template Pre-Flight Live Validator): Evaluates template repository existence and template flags in real-time', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
    });

    await page.goto(`/dashboard/${ORG}/admin`);

    // Click New assignment
    await page.locator('.new-btn').click();

    const templateInput = page.getByPlaceholder('Type or select a template repository');
    await templateInput.fill(`${ORG}/starter-template`);

    // Wait for pre-flight check badge
    await expect(page.locator('.template-preflight-badge')).toContainText(/Valid Template Repository/i);

    // Test non-template repo
    await templateInput.fill(`${ORG}/non-template-repo`);
    await expect(page.locator('.template-preflight-badge')).toContainText(/Repository exists but is not marked as a GitHub Template/i);

    // Test non-existent repo
    await templateInput.fill(`${ORG}/non-existent-xyz`);
    await expect(page.locator('.template-preflight-badge')).toContainText(/not found/i);
  });

  test('Scenario 5 (1-Click Cohort Capacity Bumper): Displays capacity alert banner and increases seat limit directly from dashboard', async ({ page }) => {
    const assignmentId = 'web-frameworks';
    // A document assignment.schema.json would actually accept. It previously
    // carried `accepted_count`, which the schema FORBIDS - that is a public
    // acceptance-card field, never an assignment YAML one - and omitted three
    // required fields. The banner is driven by the report below (50 accepted
    // against a cap of 50), so the impossible field was never load-bearing; it
    // just described a document no backend could produce, which is how the
    // capacity bumper's write-back went unchecked.
    const assignment = {
      schema_version: 1,
      id: assignmentId,
      title: 'Web Frameworks',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      max_acceptances: 50,
      template: { owner: ORG, repository: 'web-template' },
      repository_name_pattern: `${assignmentId}-{github_login}`,
      opens_at: '2026-08-01T08:00:00.000Z',
      deadline_at: '2026-12-31T22:00:00.000Z',
    };

    const mockReport = {
      schema_version: 1,
      assignment_id: assignmentId,
      assignment_title: 'Web Frameworks',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: Array.from({ length: 50 }, (_, i) => ({
        github_login: `student-${i + 1}`,
        repo_name: `${ORG}/${assignmentId}-student-${i + 1}`,
        acceptance_state: 'accepted',
        status: 'on-time',
      })),
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [assignmentId]: assignment },
      reports: { [assignmentId]: mockReport },
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG}/${assignmentId}`);

    // Verify Capacity Alert Banner is visible
    const capacityBanner = page.locator('.capacity-banner');
    await expect(capacityBanner).toBeVisible();
    await expect(capacityBanner).toContainText('Cohort Capacity Alert: 50 / 50 acceptances');
    await expect(capacityBanner).toContainText('Registration cap reached');

    // Click +25 Quick Bump
    await capacityBanner.getByRole('button', { name: '+25' }).click();

    // Verify success toast
    await expect(page.locator('.toast', { hasText: /Capacity increased to 75 slots/i })).toBeVisible();

    // 2. Test Remove limit on another capped assignment
    const cappedAssignmentId = 'cloud-patterns';
    // ENFORCED, not open. Under open enrolment the cap is the only thing
    // limiting who may claim a repository, so the schema requires it and
    // accept.mjs reads its absence as fail:config - removing it there breaks
    // every acceptance that follows, and the control is not offered. This
    // scenario is the case where removal is legitimate; the one below is the
    // case where it must be refused.
    const cappedAssignment = {
      schema_version: 1,
      id: cappedAssignmentId,
      title: 'Cloud Patterns',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'enforced',
      state: 'published',
      max_acceptances: 10,
      template: { owner: ORG, repository: 'web-template' },
      repository_name_pattern: `${cappedAssignmentId}-{github_login}`,
      opens_at: '2026-08-01T08:00:00.000Z',
      deadline_at: '2026-12-31T22:00:00.000Z',
    };
    const cappedReport = {
      schema_version: 1,
      assignment_id: cappedAssignmentId,
      assignment_title: 'Cloud Patterns',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: Array.from({ length: 10 }, (_, i) => ({
        github_login: `dev-${i + 1}`,
        repo_name: `${ORG}/${cappedAssignmentId}-dev-${i + 1}`,
        acceptance_state: 'accepted',
        status: 'on-time',
      })),
    };

    await setupStandardMockRoutes(page, {
      assignments: { [cappedAssignmentId]: cappedAssignment },
      reports: { [cappedAssignmentId]: cappedReport },
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG}/${cappedAssignmentId}`);
    const banner2 = page.locator('.capacity-banner');
    await expect(banner2).toBeVisible();
    await banner2.getByRole('button', { name: 'Remove limit' }).click();
    await expect(page.locator('.toast', { hasText: /Registration cap removed/i })).toBeVisible();
  });

  test('Scenario 6 (Open enrolment keeps its cap): the one control that would break a live cohort is not offered', async ({ page }) => {
    // Under roster_mode: open nothing gates acceptance except max_acceptances -
    // the schema says so in its own $comment - so the schema REQUIRES it and
    // accept.mjs returns fail:config without it. Removing the cap there does not
    // open enrolment up, it stops every acceptance dead, and it was a one-click
    // button beside three harmless ones.
    const openId = 'open-exam';
    const openAssignment = {
      schema_version: 1,
      id: openId,
      title: 'Open Exam',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      max_acceptances: 10,
      template: { owner: ORG, repository: 'web-template' },
      repository_name_pattern: `${openId}-{github_login}`,
      opens_at: '2026-08-01T08:00:00.000Z',
      deadline_at: '2026-12-31T22:00:00.000Z',
    };
    const openReport = {
      schema_version: 1,
      assignment_id: openId,
      assignment_title: 'Open Exam',
      org: ORG,
      generated_at: new Date().toISOString(),
      students: Array.from({ length: 10 }, (_, i) => ({
        github_login: `exam-${i + 1}`,
        repo_name: `${ORG}/${openId}-exam-${i + 1}`,
        acceptance_state: 'accepted',
        submission_status: 'on-time',
      })),
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      assignments: { [openId]: openAssignment },
      reports: { [openId]: openReport },
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG}/${openId}`);
    const banner = page.locator('.capacity-banner');
    await expect(banner).toBeVisible();

    // Raising the cap is still offered - that is the useful half.
    await expect(banner.getByRole('button', { name: '+25' })).toBeVisible();

    // Removing it is not, and the reason is on screen rather than implied by an
    // absent button.
    await expect(banner.getByRole('button', { name: 'Remove limit' })).toHaveCount(0);
    await expect(banner).toContainText('Cap required under open enrolment');
  });

});

