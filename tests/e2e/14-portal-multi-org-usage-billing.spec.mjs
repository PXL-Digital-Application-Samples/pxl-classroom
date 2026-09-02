import { test, expect } from '@playwright/test';
import { ORG,
  LECTURER,
  STUDENT_1,
  injectAuth,
  setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ORG_WEB = 'PXL-1TIN-Web-2627';

test.describe('14 - Multi-Org Portal, Student Assignments Dashboard & Usage Billing', () => {

  test('Scenario 1 (Multi-Org Student Portal & "My Assignments" Grid): Displays cross-organization enrolled courses, deadlines, and direct link jump', async ({ page }) => {
    const cloudAssignment = {
      id: 'cloud-storage-lab',
      title: 'Cloud Storage & CDN Architecture',
      organization: ORG,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() + 3600 * 1000 * 48).toISOString(),
      repository_name_pattern: 'cloud-storage-lab-{github_login}',
    };

    const webAssignment = {
      id: 'vue-spa-project',
      title: 'Vue 3 Single Page Application',
      organization: ORG_WEB,
      assignment_type: 'individual',
      roster_mode: 'open',
      state: 'published',
      deadline_at: new Date(Date.now() + 3600 * 1000 * 96).toISOString(),
      repository_name_pattern: 'vue-spa-project-{github_login}',
    };

    const studentRepos = [
      {
        id: 101,
        name: `cloud-storage-lab-${STUDENT_1.login}`,
        full_name: `${ORG}/cloud-storage-lab-${STUDENT_1.login}`,
        owner: { login: ORG },
        html_url: `https://github.com/${ORG}/cloud-storage-lab-${STUDENT_1.login}`,
      },
      {
        id: 102,
        name: `vue-spa-project-${STUDENT_1.login}`,
        full_name: `${ORG_WEB}/vue-spa-project-${STUDENT_1.login}`,
        owner: { login: ORG_WEB },
        html_url: `https://github.com/${ORG_WEB}/vue-spa-project-${STUDENT_1.login}`,
      },
    ];

    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      participatingOrgs: [
        { login: ORG, name: 'Cloud Essentials' },
        { login: ORG_WEB, name: 'Web Frameworks' },
      ],
      allOrgAssignments: {
        [ORG]: { 'cloud-storage-lab': cloudAssignment },
        [ORG_WEB]: { 'vue-spa-project': webAssignment },
      },
      userRepos: studentRepos,
      currentUser: STUDENT_1,
    });

    // Student visits root portal
    await page.goto('/');

    // Verify "My Assignments" section and header
    await expect(page.locator('.student-dashboard')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My Assignments' })).toBeVisible();

    // Verify both cross-org assignment cards are present
    const cloudCard = page.locator('.my-assignment-card', { hasText: 'Cloud Storage & CDN Architecture' });
    await expect(cloudCard).toBeVisible();
    await expect(cloudCard.locator('.org-badge')).toContainText(ORG);
    await expect(cloudCard).toContainText('Deadline:');

    const webCard = page.locator('.my-assignment-card', { hasText: 'Vue 3 Single Page Application' });
    await expect(webCard).toBeVisible();
    await expect(webCard.locator('.org-badge')).toContainText(ORG_WEB);

    // The card offers the repository, not the acceptance page. Acceptance is
    // reached by invitation token now, and this card - built from the student's
    // accepted repos - has no token to route with. A student who is already
    // accepted wants the repo anyway.
    await expect(cloudCard.getByRole('link', { name: /Assignment details/i })).toHaveCount(0);
    const cloudRepoLink = cloudCard.getByRole('link', { name: /Open on GitHub/i });
    await expect(cloudRepoLink).toBeVisible();
    await expect(cloudRepoLink).toHaveAttribute('href', /github\.com/);
  });

  test('Scenario 2 (Lecturer Portal Landing & Organization Entry): Welcomes lecturer and routes to lecturer dashboard', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      participatingOrgs: [
        { login: ORG, name: 'Cloud Essentials' },
      ],
      currentUser: LECTURER,
    });

    await page.goto('/');

    // Verify Lecturer Welcome Card
    await expect(page.getByRole('heading', { name: new RegExp(`Welcome, ${LECTURER.name}`, 'i') })).toBeVisible();
    await expect(page.locator('.text-secondary')).toContainText(/You are signed in as an organization administrator/i);

    const openDashboardBtn = page.getByRole('link', { name: /Open Lecturer Dashboard/i });
    await expect(openDashboardBtn).toBeVisible();
    await openDashboardBtn.click();

    // Verify navigated to dashboard
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}`));
  });

  test('Scenario 3 (Organization Actions Usage & Billing Thresholds): Renders minutes usage, quota limits, and triggers one-off workflow', async ({ page }) => {
    const mockUsageReport = {
      schema_version: 1,
      week_start: '2026-08-17',
      week_end: '2026-08-23',
      generated_at: new Date(Date.now() - 3600 * 1000 * 12).toISOString(),
      over_count: 1,
      items: [
        { repo: 'lab-containers', sku: 'actions_minutes', used: 2450, limit: 2000, over: true },
        { repo: 'lab-linux-basics', sku: 'actions_minutes', used: 450, limit: 2000, over: false },
        { repo: 'lab-cloud-storage', sku: 'packages_storage', used: 12, limit: 50, over: false },
      ],
    };

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      org: ORG,
      usageReports: {
        [ORG]: mockUsageReport,
      },
      currentUser: LECTURER,
    });

    await page.goto(`/dashboard/${ORG}/usage`);

    // Verify usage page header and meta
    await expect(page.getByRole('heading', { name: new RegExp(`Usage - ${ORG}`, 'i') })).toBeVisible();
    await expect(page.locator('.report-meta')).toContainText('1 repo/SKU pair(s) over threshold');

    // Verify table items and over-limit alert badge
    const table = page.locator('table.usage-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tr.over-threshold')).toContainText('lab-containers');
    await expect(table.locator('tr.over-threshold')).toContainText('2450');
    await expect(table).toContainText('lab-linux-basics');

    // Click Regenerate now button
    const regenBtn = page.getByRole('button', { name: /Regenerate now/i });
    await expect(regenBtn).toBeVisible();
    await regenBtn.click();

    // Verify trigger notification toast
    await expect(page.locator('.toast', { hasText: /Workflow triggered/i })).toBeVisible();
  });


});
