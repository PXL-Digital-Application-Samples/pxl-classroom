import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// Edge cases found reviewing the onboarding feature after it shipped. Each of
// these was a real defect, not a hypothetical.

const HUB = 'PXL-Digital-Application-Samples/pxl-classroom';
const noControlRepo = (page, org = ORG) =>
  page.route(`https://api.github.com/repos/${org}/pxl-classroom-control**`, (r) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' }));
const hubPush = (page, push) =>
  page.route(`https://api.github.com/repos/${HUB}`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ name: 'pxl-classroom', permissions: { push } }) }));

test.describe('24 - Onboarding edge cases', () => {
  test('Recheck reloads the selected org, not the click event', async ({ page }) => {
    // @click="loadDashboard" passes a PointerEvent as the first argument, and
    // loadDashboard used it as the org - fetching /repos/[object PointerEvent]/…
    // So Recheck (and the pre-existing Retry) always 404'd and re-rendered the
    // very state they were meant to clear.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await noControlRepo(page);
    await hubPush(page, false);

    const badOrgCalls = [];
    await page.route('https://api.github.com/repos/**', async (route) => {
      const u = route.request().url();
      if (/repos\/(undefined|null|\[object)/i.test(u)) badOrgCalls.push(u);
      await route.fallback();
    });

    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('.setup-required-card')).toBeVisible();
    await page.getByRole('button', { name: /Recheck/i }).click();
    await page.waitForTimeout(1200);

    expect(badOrgCalls, 'Recheck must resolve the org, not stringify an event').toEqual([]);
    await expect(page.locator('.setup-required-card')).toBeVisible();
  });

  test('Navigating to an org with no installation never claims it is installed', async ({ page }) => {
    // selectedOrg is seeded from the route param, so a load DOES start for an
    // org that has no installation - loadOrgs() then corrects it. The card must
    // never assert "PXL Classroom is installed on <org>" purely because the
    // state was reachable, and the corrected org must win the race.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await noControlRepo(page, 'Some-Unconnected-Org');
    await hubPush(page, true);

    await page.goto('/dashboard/Some-Unconnected-Org');
    await page.waitForTimeout(2500);

    await expect(page.locator('body'))
      .not.toContainText(/PXL Classroom is installed on Some-Unconnected-Org/i);
    // The corrected org wins: the slower abandoned load must not overwrite it.
    await expect(page.locator('.org-dropdown-btn .org-label')).toHaveText(ORG);
  });

  test('Switching org mid-setup stops the poll instead of reloading the wrong org', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await noControlRepo(page);
    await hubPush(page, true);
    await page.route('**/actions/workflows/setup-org.yml/dispatches', (r) =>
      r.fulfill({ status: 204, body: '' }));

    await page.goto(`/dashboard/${ORG}`);
    await page.getByRole('button', { name: new RegExp(`Set up ${ORG}`, 'i') }).click();
    await expect(page.locator('.toast')).toContainText(/Setting up/i);

    // Leave while the poll is in flight.
    await page.goto('/usage');
    await page.waitForTimeout(3000);

    // No toast about the org we walked away from, and no reload of it.
    const toasts = await page.locator('.toast').allTextContents();
    expect(toasts.join(' '), 'a superseded poll must stay silent').not.toMatch(/is ready/i);
  });

  test('Dispatch is refused rather than sent with an empty required input', async ({ page }) => {
    // budget_owner_login is required by setup-org.yml. Sending '' would
    // register a blank budget owner that the weekly usage report @-mentions.
    await injectAuth(page, { ...LECTURER, login: '' });
    await setupStandardMockRoutes(page, { currentUser: { ...LECTURER, login: '' } });
    await noControlRepo(page);
    await hubPush(page, true);

    let dispatched = false;
    await page.route('**/actions/workflows/setup-org.yml/dispatches', (r) => {
      dispatched = true;
      return r.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/dashboard/${ORG}`);
    const btn = page.getByRole('button', { name: new RegExp(`Set up ${ORG}`, 'i') });
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(1000);
      expect(dispatched, 'must not dispatch without a budget owner login').toBe(false);
    }
  });

  test('The org switcher survives more than one page of installations', async ({ page }) => {
    // /user/installations defaults to per_page=30 and is paginated. Before the
    // fix, org 31+ silently vanished from the switcher.
    const makeOrg = (n) => ({ id: n, account: { login: `PXL-Org-${n}`, type: 'Organization' } });
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });

    await page.route('https://api.github.com/user/installations**', async (route) => {
      const url = new URL(route.request().url());
      const page1 = !url.searchParams.get('page') || url.searchParams.get('page') === '1';
      const items = page1
        ? Array.from({ length: 100 }, (_, i) => makeOrg(i + 1))
        : [makeOrg(101)];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: page1
          ? {
              link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
              'access-control-expose-headers': 'link',
            }
          : { 'access-control-expose-headers': 'link' },
        body: JSON.stringify({ total_count: 101, installations: items }),
      });
    });

    await page.goto('/dashboard/PXL-Org-101');
    await page.locator('.org-dropdown-btn').click();
    const items = page.locator('.org-dropdown-item:not(.org-connect-item)');
    await expect(items).toHaveCount(101);
    await expect(page.locator('.org-dropdown-menu')).toContainText('PXL-Org-101');
  });

  test('A self-referential Link header cannot spin forever', async ({ page }) => {
    let calls = 0;
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.route('https://api.github.com/user/installations**', async (route) => {
      calls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Always points at a DIFFERENT page, so a naive loop never terminates.
        headers: {
          link: `<https://api.github.com/user/installations?per_page=100&page=${calls + 1}>; rel="next"`,
          'access-control-expose-headers': 'link',
        },
        body: JSON.stringify({ total_count: 1, installations: [] }),
      });
    });

    await page.goto(`/dashboard/${ORG}`);
    await page.waitForTimeout(4000);
    expect(calls, 'pagination must be bounded').toBeLessThanOrEqual(50);
    expect(calls, 'and must actually have paginated').toBeGreaterThan(1);
  });
});
