import { test, expect } from '@playwright/test';
import {
  injectAuth,
  setupStandardMockRoutes,
  LECTURER,
} from '../fixtures/e2e-fixtures.mjs';

const ORG_FRESH = 'PXL-2TIN-FreshOrg-2627';
const ORG_ACTIVE = 'PXL-2TIN-CloudEssentials-2627';

test.describe('18 - Beginning Lecturer Onboarding & Readiness Panel', () => {

  test('Scenario 1 (Fresh Org with 0 Assignments): Shows onboarding steps panel with action buttons', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      participatingOrgs: [ORG_FRESH],
      assignments: {}, // 0 assignments
      reports: {},
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG_FRESH}`);

    // 1. Verify Onboarding Readiness Card is visible
    const onboardingCard = page.locator('.onboarding-readiness-card');
    await expect(onboardingCard).toBeVisible();

    // 2. Verify Welcome header and 3 onboarding steps
    await expect(onboardingCard.locator('.onboarding-head h2')).toContainText(`Welcome to ${ORG_FRESH}`);
    await expect(onboardingCard.locator('.onboarding-head p')).toContainText('Follow these simple steps to launch your first assignment');

    await expect(onboardingCard).toContainText('1. Course Organization Connected');
    await expect(onboardingCard).toContainText('2. Prepare Starter Code Template');
    await expect(onboardingCard).toContainText('3. Create & Publish Assignment');

    // 3. Verify action buttons
    const createFirstBtn = onboardingCard.getByRole('link', { name: /Create Your First Assignment/i });
    await expect(createFirstBtn).toBeVisible();
    await expect(createFirstBtn).toHaveAttribute('href', `/dashboard/${ORG_FRESH}/admin?new=1`);

    const healthBtn = onboardingCard.getByRole('button', { name: /Check System Health/i });
    await expect(healthBtn).toBeVisible();

    // 4. Click Check System Health button and verify modal opens
    await healthBtn.click();
    const modal = page.locator('.diagnostic-modal');
    await expect(modal).toBeVisible();
  });

  test('Scenario 2 (Org with Draft Assignment): Onboarding panel is hidden; shows draft notice', async ({ page }) => {
    const draftAssignment = {
      id: 'lab-draft-only',
      title: 'Draft Lab',
      organization: ORG_ACTIVE,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'draft',
      template: { owner: ORG_ACTIVE, repository: 'draft-template' },
      repository_name_pattern: 'lab-draft-{github_login}',
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      participatingOrgs: [ORG_ACTIVE],
      assignments: { 'lab-draft-only': draftAssignment }, // 1 draft in assignments/
      reports: {}, // No dashboard.json yet
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG_ACTIVE}`);

    // 1. Verify Onboarding Readiness Card is NOT shown
    const onboardingCard = page.locator('.onboarding-readiness-card');
    await expect(onboardingCard).not.toBeVisible();

    // 2. Verify No dashboard data yet + draft notice
    await expect(page.locator('h2', { hasText: /No dashboard data yet/i })).toBeVisible();
    await expect(page.locator('text=You have 1 draft in the Admin Panel')).toBeVisible();

    const adminLink = page.getByRole('link', { name: /Open Admin Panel/i });
    await expect(adminLink).toBeVisible();
  });

  test('Scenario 3 (Org with Published Assignment): Onboarding panel is hidden; shows assignment grid', async ({ page }) => {
    const pubAssignment = {
      id: 'lab-active-1',
      title: 'Active Kubernetes Lab',
      organization: ORG_ACTIVE,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() + 3600 * 1000 * 48).toISOString(),
      template: { owner: ORG_ACTIVE, repository: 'k8s-template' },
      repository_name_pattern: 'lab-active-1-{github_login}',
    };

    const mockDashboardReport = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      assignments: {
        'lab-active-1': {
          title: 'Active Kubernetes Lab',
          state: 'published',
          deadline_at: pubAssignment.deadline_at,
          accepted: 12,
          on_time: 10,
          late: 2,
          no_submission: 0,
        },
      },
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      participatingOrgs: [ORG_ACTIVE],
      assignments: { 'lab-active-1': pubAssignment },
      reports: { 'dashboard': mockDashboardReport },
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG_ACTIVE}`);

    // 1. Verify Onboarding Readiness Card is NOT shown
    const onboardingCard = page.locator('.onboarding-readiness-card');
    await expect(onboardingCard).not.toBeVisible();

    // 2. Verify Assignment Grid is shown
    const card = page.locator('.assignment-card', { hasText: 'Active Kubernetes Lab' });
    await expect(card).toBeVisible();
    await expect(card.locator('.status-indicator')).toContainText('Accepting');
    await expect(card.locator('.stat-value', { hasText: '12' })).toBeVisible();
  });

  test('Scenario 4 (Unonboarded Org): Onboarding panel is hidden; shows not-onboarded notice', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      participatingOrgs: ['PXL-Unonboarded-Org'],
      assignments: {},
      reports: {},
      currentUser: LECTURER,
    });

    // Mock control repo 404 for this unonboarded org
    await page.route(`**/repos/PXL-Unonboarded-Org/pxl-classroom-control`, async (route) => {
      await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
    });

    await page.goto(`/dashboard/PXL-Unonboarded-Org`);

    // 1. The "create your first assignment" readiness card must NOT appear -
    //    the org is not ready for that yet.
    await expect(page.locator('.onboarding-readiness-card')).not.toBeVisible();

    // 2. Instead the setup card explains the one remaining step. This used to
    //    be a dead end reading "isn't onboarded yet - see ADMIN.md §1".
    const setupCard = page.locator('.setup-required-card');
    await expect(setupCard).toBeVisible();
    await expect(setupCard).toContainText(/needs its control repository/i);
    await expect(page.getByRole('link', { name: /Setup Organization/i })).toBeVisible();
  });

  test('Scenario 5 (Dynamic Org Switch): Toggles Onboarding Panel cleanly when switching between empty and active orgs', async ({ page }) => {
    const pubAssignment = {
      id: 'lab-cloud',
      title: 'Cloud Architecture Lab',
      organization: ORG_ACTIVE,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() + 3600 * 1000 * 72).toISOString(),
    };

    const mockDashboardReport = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      assignments: {
        'lab-cloud': {
          title: 'Cloud Architecture Lab',
          state: 'published',
          deadline_at: pubAssignment.deadline_at,
          accepted: 5,
          on_time: 5,
          late: 0,
          no_submission: 0,
        },
      },
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      participatingOrgs: [ORG_FRESH, ORG_ACTIVE],
      assignments: { 'lab-cloud': pubAssignment },
      reports: { 'dashboard': mockDashboardReport },
      currentUser: LECTURER,
    });

    // Custom route to differentiate ORG_FRESH (0 assignments) from ORG_ACTIVE (1 assignment)
    await page.route(`**/repos/${ORG_FRESH}/pxl-classroom-control/contents/assignments`, async (route) => {
      await route.fulfill({ status: 200, body: JSON.stringify([]) });
    });
    await page.route(`**/repos/${ORG_FRESH}/pxl-classroom-control/contents/reports/dashboard.json`, async (route) => {
      await route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
    });

    // 1. Visit ORG_FRESH: Onboarding panel visible
    await page.goto(`/dashboard/${ORG_FRESH}`);
    const onboardingCard = page.locator('.onboarding-readiness-card');
    await expect(onboardingCard).toBeVisible();

    // 2. Open Org Dropdown and switch to ORG_ACTIVE
    await page.locator('.org-dropdown-btn').click();
    await page.locator('.org-dropdown-item', { hasText: ORG_ACTIVE }).click();

    // 3. In ORG_ACTIVE: Onboarding panel is gone, Assignment Grid is visible
    await expect(onboardingCard).not.toBeVisible();
    await expect(page.locator('.assignment-card', { hasText: 'Cloud Architecture Lab' })).toBeVisible();

    // 4. Switch back to ORG_FRESH: Onboarding panel returns
    await page.locator('.org-dropdown-btn').click();
    await page.locator('.org-dropdown-item', { hasText: ORG_FRESH }).click();
    await expect(onboardingCard).toBeVisible();
    await expect(onboardingCard.locator('.onboarding-head h2')).toContainText(`Welcome to ${ORG_FRESH}`);
  });

  // ARCHITECTURE §10.3. The draft count was `ymls.length` - every assignment file in
  // the control repo, whatever its state - so the panel told a lecturer who had
  // just published that they had drafts to publish. What is missing on this
  // branch is reports/dashboard.json, not the publish.

  const asgn = (id, state) => ({
    id,
    title: id,
    organization: ORG_ACTIVE,
    assignment_type: 'individual',
    roster_mode: 'enforced',
    state,
    template: { owner: ORG_ACTIVE, repository: 'a-template' },
    repository_name_pattern: `${id}-{github_login}`,
  });

  test('Scenario 6 (No dashboard.json): the draft count reads each assignment state', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      participatingOrgs: [ORG_ACTIVE],
      assignments: {
        'lab-one-draft': asgn('lab-one-draft', 'draft'),
        'lab-published': asgn('lab-published', 'published'),
        'lab-closed': asgn('lab-closed', 'closed'),
      },
      reports: {}, // No dashboard.json yet
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG_ACTIVE}`);

    await expect(page.locator('h2', { hasText: /No dashboard data yet/i })).toBeVisible();
    // One draft out of three files. Counting files said three.
    await expect(page.locator('text=You have 1 draft in the Admin Panel')).toBeVisible();
    await expect(page.locator('text=You have 3 drafts in the Admin Panel')).not.toBeVisible();
  });

  test('Scenario 7 (No dashboard.json, nothing in draft): says what is actually pending', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      participatingOrgs: [ORG_ACTIVE],
      assignments: { 'lab-published': asgn('lab-published', 'published') },
      reports: {},
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG_ACTIVE}`);

    await expect(page.locator('h2', { hasText: /No dashboard data yet/i })).toBeVisible();
    await expect(page.locator('text=Published assignments appear here once the first report is generated')).toBeVisible();
    await expect(page.locator('text=in the Admin Panel - publish to track them here')).not.toBeVisible();
  });

});
