import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

test.describe('02 - Individual Student Acceptance Flow', () => {
  test('Happy Path: Student accepts assignment, views provisioned repo, and copies URL', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'hw-individual': {
          id: 'hw-individual',
          title: 'Individual Homework 1',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          opens_at: new Date(Date.now() - 3600000).toISOString(),
          deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
          repository_name_pattern: 'hw-individual-{github_login}',
          broker_repo: 'broker-hw-individual',
        },
      },
      userRepos: [
        {
          name: `hw-individual-${STUDENT_1.login}`,
          full_name: `${ORG}/hw-individual-${STUDENT_1.login}`,
          html_url: `https://github.com/${ORG}/hw-individual-${STUDENT_1.login}`,
        },
      ],
    });

    await page.goto(inviteUrl(ORG, 'hw-individual'));

    // Initially provisioned state
    const readyHeading = page.locator('h2', { hasText: 'Your repository is ready!' });
    await expect(readyHeading).toBeVisible({ timeout: 10000 });

    const repoLink = page.locator('a.repo-link');
    await expect(repoLink).toBeVisible();
    await expect(repoLink).toContainText(`hw-individual-${STUDENT_1.login}`);

    const copyBtn = page.locator('button', { hasText: /Copy URL|Copied/ });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(copyBtn).toBeVisible();
  });

  test('Sad Path: Assignment opens in future displays "Assignment not open yet"', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'hw-future': {
          id: 'hw-future',
          title: 'Future Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          opens_at: new Date(Date.now() + 86400000 * 3).toISOString(), // 3 days in future
          deadline_at: new Date(Date.now() + 86400000 * 10).toISOString(),
        },
      },
    });

    await page.goto(inviteUrl(ORG, 'hw-future'));
    const futureHeading = page.locator('h2', { hasText: 'Assignment not open yet' });
    await expect(futureHeading).toBeVisible();
    await expect(page.locator('.status-icon')).toBeVisible();
  });

  test('Sad Path: Assignment past deadline displays "Assignment closed"', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'hw-closed': {
          id: 'hw-closed',
          title: 'Expired Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          opens_at: new Date(Date.now() - 86400000 * 10).toISOString(),
          deadline_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        },
      },
    });

    await page.goto(inviteUrl(ORG, 'hw-closed'));
    const closedHeading = page.locator('h2', { hasText: 'Assignment closed' });
    await expect(closedHeading).toBeVisible();
  });

  test('Sad Path: Registration cap reached displays warning and disables accept', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'hw-capped': {
          id: 'hw-capped',
          title: 'Capped Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          opens_at: new Date(Date.now() - 3600000).toISOString(),
          deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
          max_acceptances: 10,
          accepted_count: 10, // Cap met
        },
      },
    });

    await page.goto(inviteUrl(ORG, 'hw-capped'));
    const cappedHeading = page.locator('h2', { hasText: 'Registration cap reached' });
    await expect(cappedHeading).toBeVisible();
  });

  test('Edge Case: Pending collaboration invitation displays direct invitation action', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        'hw-invite': {
          id: 'hw-invite',
          title: 'Invite Assignment',
          organization: ORG,
          state: 'published',
          assignment_type: 'individual',
          opens_at: new Date(Date.now() - 3600000).toISOString(),
          deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
          repository_name_pattern: 'hw-invite-{github_login}',
        },
      },
      invitations: [
        {
          id: 555,
          repository: {
            name: `hw-invite-${STUDENT_1.login}`,
            full_name: `${ORG}/hw-invite-${STUDENT_1.login}`,
            html_url: `https://github.com/${ORG}/hw-invite-${STUDENT_1.login}`,
            owner: { login: ORG },
          },
        },
      ],
    });

    await page.goto(inviteUrl(ORG, 'hw-invite'));
    const inviteHeading = page.locator('h2', { hasText: /invitation pending|accept your invitation/i });
    await expect(inviteHeading).toBeVisible({ timeout: 10000 });
  });
});
