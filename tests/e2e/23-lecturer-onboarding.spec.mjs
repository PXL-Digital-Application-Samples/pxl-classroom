import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// A lecturer newly made owner of an org used to hit two dead ends: "Student
// Account Detected" (if the App was not installed) and "isn't onboarded yet -
// see ADMIN.md §1" (if it was, but the control repo did not exist). Both now
// carry the action instead of a documentation link.

const INSTALL_URL = 'https://github.com/apps/pxl-classroom-provisioner/installations/new';

const noInstallations = (page) =>
  page.route('https://api.github.com/user/installations**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ total_count: 0, installations: [] }) }));

const noControlRepo = (page) =>
  page.route(`https://api.github.com/repos/${ORG}/pxl-classroom-control**`, (r) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' }));

test.describe('23 - Lecturer onboarding', () => {
  test('With no installed org, the empty state offers Connect instead of a RUNBOOK link', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await noInstallations(page);
    await page.goto(`/dashboard/${ORG}`);

    const connect = page.getByRole('link', { name: /Connect an organization/i }).first();
    await expect(connect).toBeVisible();
    await expect(connect).toHaveAttribute('href', INSTALL_URL);

    // GitHub's own install page IS the org picker, so the SPA must not try to
    // enumerate organizations - the account may belong to dozens.
    await expect(page.locator('body')).not.toContainText(/RUNBOOK/i);
  });

  test('The Connect door is permanent, not just a first-run screen', async ({ page }) => {
    // The original design only surfaced this when zero orgs existed, so a
    // lecturer adding a SECOND org had no way back to it.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);

    await page.locator('.org-dropdown-btn').click();
    const item = page.locator('.org-connect-item');
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('href', INSTALL_URL);
    // A new tab, so the dashboard survives the round trip to GitHub.
    await expect(item).toHaveAttribute('target', '_blank');
  });

  test('A missing control repository is actionable, and says who can act', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await noControlRepo(page);
    await page.goto(`/dashboard/${ORG}`);

    const card = page.locator('.setup-required-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(/needs its control repository/i);
    await expect(page.locator('body')).not.toContainText(/RUNBOOK/i);

    // Setup Organization is a hub workflow_dispatch needing write there. The
    // fixture user has no hub write, so the copy must not imply they can run it.
    await expect(card).toContainText(/a hub admin runs/i);
    await expect(page.getByRole('link', { name: /Setup Organization/i })).toBeVisible();
  });

  test('Every onboarding state keeps a single primary action (DESIGN.md §1.2)', async ({ page }) => {
    const countPrimaries = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.btn-primary')]
          .filter((el) => el.offsetParent !== null)
          .map((el) => el.textContent.trim().replace(/\s+/g, ' ')));

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });

    await noInstallations(page);
    await page.goto(`/dashboard/${ORG}`);
    await expect(page.getByRole('link', { name: /Connect an organization/i }).first()).toBeVisible();
    expect(await countPrimaries(), 'no-orgs state').toHaveLength(1);

    await page.unroute('https://api.github.com/user/installations**');
    await noControlRepo(page);
    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('.setup-required-card')).toBeVisible();
    expect(await countPrimaries(), 'no-control-repo state').toHaveLength(1);
  });

  test('With hub write, setup is one click - no Actions tab, no typing', async ({ page }) => {
    // The friction this removes: find the hub repo, open Actions, pick the
    // workflow, choose a branch, type your own org name into target_org.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await noControlRepo(page);
    await page.route('https://api.github.com/repos/PXL-Digital-Application-Samples/pxl-classroom', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ name: 'pxl-classroom', permissions: { push: true } }) }));

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.setup-required-card');
    await expect(card).toBeVisible();

    // A button that dispatches, not a link that sends them to GitHub to fill a form.
    const run = card.getByRole('button', { name: new RegExp(`Set up ${ORG}`, 'i') });
    await expect(run).toBeVisible();
    await expect(card).not.toContainText(/target_org/i);
    await expect(card).not.toContainText(/a hub admin runs/i);

    // Clicking it dispatches setup-org.yml with the inputs the workflow declares.
    let dispatched = null;
    await page.route('**/actions/workflows/setup-org.yml/dispatches', async (route) => {
      dispatched = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ status: 204, body: '' });
    });
    await run.click();
    await expect.poll(() => dispatched, { timeout: 10000 }).not.toBeNull();

    expect(Object.keys(dispatched.inputs).sort(),
      'setup-org.yml declares target_org and budget_owner_login, both required')
      .toEqual(['budget_owner_login', 'target_org']);
    expect(dispatched.inputs.target_org).toBe(ORG);
    expect(dispatched.inputs.budget_owner_login).toBeTruthy();
  });

  test('Without hub write, it says who can act instead of offering a dead button', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await noControlRepo(page);
    await page.route('https://api.github.com/repos/PXL-Digital-Application-Samples/pxl-classroom', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ name: 'pxl-classroom', permissions: { push: false } }) }));

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.setup-required-card');
    await expect(card).toContainText(/a hub admin runs/i);
    // No self-serve button - dispatching would only 403 (ADMIN.md §1.4).
    await expect(card.getByRole('button', { name: /Set up/i })).toHaveCount(0);
  });
});
