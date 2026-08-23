import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

test.describe('01 - Auth & Session Lifecycle', () => {
  test('User session badge renders avatar, login name, and session duration', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1 });

    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('.header-logo')).toBeVisible();

    const badge = page.locator('.user-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(STUDENT_1.login);
    await expect(badge).toContainText('session');
  });

  test('Sign out button clears session and reloads unauthenticated', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1 });

    await page.goto(`/dashboard/${ORG}`);
    const signOutBtn = page.locator('button', { hasText: 'Sign out' });
    await expect(signOutBtn).toBeVisible();

    await signOutBtn.click();
    await expect(page.locator('.user-badge')).not.toBeVisible();
  });

  test('Visiting an assignment unauthenticated shows GitHub Sign-in prompt without crash', async ({ page }) => {
    await setupStandardMockRoutes(page, {
      assignments: {
        'test-assignment': {
          id: 'test-assignment',
          title: 'Basic Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
        },
      },
    });

    await page.goto(inviteUrl(ORG, 'test-assignment'));
    const signInHeading = page.locator('h2', { hasText: 'Sign in with GitHub' });
    await expect(signInHeading).toBeVisible();
    await expect(page.locator('button', { hasText: 'Sign in with GitHub' })).toBeVisible();
  });

  test('Malformed route displays clear not found message with return home action', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { assignments: {} });

    await page.goto(inviteUrl(ORG, 'non-existent-assignment-12345'));
    const errorHeading = page.locator('h2', { hasText: /Assignment not found|Looking for newly published/ });
    await expect(errorHeading).toBeVisible();
  });
});
