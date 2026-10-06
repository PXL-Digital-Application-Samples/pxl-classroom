// 100 - Signing in on an organization's page loads that organization.
//
// Live on the testbed, 2026-10-06: opening /dashboard/<org> signed out and
// signing in there showed "Nothing to show for <org>" over ten assignments until
// a reload. The org in the address was loaded at mount, before there was a
// token, so nothing was read; the sign-in fetched the organization list and
// nothing else. Every other spec starts signed in (injectAuth), which is why
// none saw it: this one goes through the device flow, with GitHub's two
// sign-in endpoints answered here.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'lab-signed-in';

async function answerSignIn(page) {
  await page.route((url) => url.href.includes(encodeURIComponent('https://github.com/login/device/code')), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ device_code: 'dc-e2e', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 }),
    }));
  await page.route((url) => url.href.includes(encodeURIComponent('https://github.com/login/oauth/access_token')), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: LECTURER.token || 'ghu_e2e_signed_in', token_type: 'bearer', expires_in: 28800 }),
    }));
}

test('signing in on an organization\'s page shows its assignments, without a reload', async ({ page }) => {
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: {
      [ID]: {
        id: ID,
        title: 'Signed In Lab',
        organization: ORG,
        state: 'published',
        assignment_type: 'individual',
        roster_mode: 'open',
        template: { owner: ORG, repository: 'starter' },
        repository_name_pattern: `${ID}-{github_login}`,
      },
    },
    reports: {
      dashboard: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        assignments: {
          [ID]: { title: 'Signed In Lab', state: 'published', deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(), total_students: 3, accepted: 3, on_time: 0, late: 0, no_submission: 3 },
        },
      },
    },
  });
  await answerSignIn(page);

  await page.goto(`/dashboard/${ORG}`);
  await page.getByRole('button', { name: /Sign in with GitHub/i }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 20000 });

  await expect(page.locator('.assignment-card', { hasText: 'Signed In Lab' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(`Nothing to show for ${ORG}`)).toHaveCount(0);
});
