import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

// DESIGN.md §1 is the half of the design system no static test can check: the
// rules are about what is VISIBLE at once, and most of these views render their
// controls conditionally. Three violations shipped before this existed, all on
// the root portal - a landing page with two competing CTAs, a signed-in view
// whose header duplicated the card's own action, and an "Open on GitHub" button
// rendered once per assignment card.

/** §1.2 - visible solid primary buttons, scoped to the modal when one is open. */
const PRIMARIES = () => {
  const vis = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  const scope = document.querySelector('.modal-overlay') || document;
  return [...scope.querySelectorAll('.btn-primary')]
    .filter(vis)
    .map((b) => b.textContent.trim().replace(/\s+/g, ' ').slice(0, 40));
};

/** §1.3 - uppercase, fully-round status pills. Status belongs on a .status-dot. */
const PILLS = () => {
  const vis = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  return [...document.querySelectorAll('*')]
    .filter((e) => vis(e) && e.children.length === 0 && e.textContent.trim())
    .filter((e) => {
      const cs = getComputedStyle(e);
      return cs.textTransform === 'uppercase' && parseFloat(cs.borderRadius) > 50;
    })
    .map((e) => `${e.textContent.trim().slice(0, 20)} [${e.className.toString().slice(0, 24)}]`);
};

async function conforms(page, label) {
  const primaries = await page.evaluate(PRIMARIES);
  expect(
    primaries.length,
    `${label}: DESIGN.md §1.2 allows ONE solid .btn-primary per view - found ${primaries.length}: ${primaries.join(' | ')}`,
  ).toBeLessThanOrEqual(1);

  const pills = await page.evaluate(PILLS);
  expect(
    pills,
    `${label}: DESIGN.md §1.3 - use .status-indicator + .status-dot with mixed-case text, not uppercase pill capsules`,
  ).toEqual([]);
}

test.describe('22 - DESIGN.md §1 conformity', () => {
  test('Signed-out routes, including the landing page', async ({ page }) => {
    await setupStandardMockRoutes(page, {});
    for (const route of ['/', '/setup', '/sandbox', '/nope-404']) {
      await page.goto(route);
      await page.waitForTimeout(700);
      await conforms(page, `signed-out ${route}`);
    }
  });

  test('Sign-in cards on authenticated routes', async ({ page }) => {
    // Every one of these is an AuthCard; its GitHub button is the single CTA.
    await setupStandardMockRoutes(page, {});
    for (const route of [
      `/dashboard/${ORG}`, `/dashboard/${ORG}/admin`, `/dashboard/${ORG}/demo`,
      `/dashboard/${ORG}/usage`, '/usage',
    ]) {
      await page.goto(route);
      await page.waitForTimeout(700);
      await conforms(page, `sign-in ${route}`);
    }
  });

  test('Signed-in lecturer routes', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    for (const route of ['/', `/dashboard/${ORG}`, `/dashboard/${ORG}/admin`,
                         `/dashboard/${ORG}/usage`, '/usage']) {
      await page.goto(route);
      await page.waitForTimeout(1100);
      await conforms(page, `signed-in ${route}`);
    }
  });

  // The group views were the blind spot: this suite only ever visited the
  // dashboard, admin and usage routes, so the assignment detail page shipped
  // with two competing primaries and the student page rendered one per team row
  // - the exact case §1.2 names.
  const GROUP_ASSIGNMENT = {
    id: 'g',
    title: 'Group Assignment',
    organization: ORG,
    state: 'published',
    assignment_type: 'group',
    repository_name_pattern: 'g-{team_slug}',
    opens_at: '2026-01-01T00:00:00Z',
    deadline_at: '2099-01-01T00:00:00Z',
    template: { owner: ORG, repository: 'group-template' },
    group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
  };

  const GROUP_REPORT = {
    schema_version: 1,
    assignment_id: 'g',
    org: ORG,
    generated_at: new Date().toISOString(),
    students: [{ github_login: 'x', acceptance_state: 'accepted', team_slug: 'a' }],
    teams: [{ team_slug: 'a', team_name: 'Team A', members: ['x'], submission_status: 'no-submission' }],
  };

  async function openTeamsTab(page) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { g: GROUP_ASSIGNMENT },
      reports: { g: GROUP_REPORT },
    });
    await page.goto(`/dashboard/${ORG}/g`);
    await page.locator('.tab-pill', { hasText: /Teams View/i }).click();
    await page.waitForTimeout(400);
  }

  test('Lecturer group views: assignment detail and its Teams tab', async ({ page }) => {
    await openTeamsTab(page);
    await conforms(page, 'assignment detail / Teams tab');
  });

  test('Team management modals', async ({ page }) => {
    await openTeamsTab(page);

    await page.locator('button', { hasText: 'Create Team' }).first().click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await conforms(page, 'Create Team modal');
    await page.locator('.modal-foot button', { hasText: 'Cancel' }).click();

    await page.locator('button', { hasText: 'Manage' }).first().click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await conforms(page, 'Manage Team modal');
    await page.locator('.modal-foot button', { hasText: 'Close' }).click();

    await page.locator('button', { hasText: 'Seed teams' }).first().click();
    await expect(page.locator('.seed-modal')).toBeVisible();
    await conforms(page, 'Seed Teams modal');
  });

  test('Student group pages: team list, and a carried-over group', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { g: GROUP_ASSIGNMENT },
      teams: {
        g: [
          { team_slug: 'a', team_name: 'Team A', members: ['carol'], member_count: 1, max_members: 3, is_full: false },
          { team_slug: 'b', team_name: 'Team B', members: ['dave'], member_count: 1, max_members: 3, is_full: false },
          { team_slug: 'c', team_name: 'Team C', members: ['erin'], member_count: 1, max_members: 3, is_full: false },
        ],
      },
    });
    await page.goto(inviteUrl(ORG, 'g'));
    await page.waitForTimeout(1200);
    await conforms(page, 'student team list');

    await page.locator('.tab-pill', { hasText: '+ Create New Team' }).click();
    await page.waitForTimeout(300);
    await conforms(page, 'student create-team tab');
  });

  test('Student with a carried-over group, and its alternatives', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { g: GROUP_ASSIGNMENT },
      teams: {
        g: [
          {
            team_slug: 'a', team_name: 'Team A',
            members: [STUDENT_1.login, STUDENT_2.login],
            member_count: 2, max_members: 3, is_full: false,
            seeded_from: { source: 'assignment', assignment_id: 'prev', assignment_title: 'Previous' },
          },
          { team_slug: 'b', team_name: 'Team B', members: ['dave'], member_count: 1, max_members: 3, is_full: false },
        ],
      },
    });
    await page.goto(inviteUrl(ORG, 'g'));
    await page.waitForTimeout(1200);
    await conforms(page, 'student carried-over group');

    // Their own group stays the single emphasised choice among the alternatives.
    await page.locator('button', { hasText: 'Choose a different group' }).click();
    await page.waitForTimeout(300);
    await conforms(page, 'student alternatives list');
  });

  test('A modal is its own major section', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);
    await page.locator('button[aria-label="System health check"]').click();
    await expect(page.locator('.diagnostic-modal')).toBeVisible();
    await expect(page.locator('.modal-head .btn')).toBeEnabled({ timeout: 15000 });
    await conforms(page, 'System Health modal');
  });
});
