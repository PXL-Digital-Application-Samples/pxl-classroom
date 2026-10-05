// 88 - An organization's three views: Assignments, Roster, Organization.
//
// One switch in the header of every page in the org (OrgSwitch.vue). There is
// no Admin view (BETA-UX.md, 2026-10-02): the editor is each assignment's
// Settings tab, so everything about one assignment - Progress, Teams, Grading,
// Settings - is under Assignments, which stays lit there and still leads back
// to the list. Organization holds what is the organization's own.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'lab-switch';
const ASSIGNMENTS = {
  [ID]: {
    id: ID,
    title: 'Lab Switch',
    organization: ORG,
    state: 'published',
    assignment_type: 'individual',
    template: { owner: ORG, repository: 'template-lab' },
  },
};
const REPORTS = {
  [ID]: { schema_version: 1, generated_at: new Date().toISOString(), assignment_id: ID, students: [] },
};

const views = (page) => page.getByRole('navigation', { name: 'Course views' });
const tab = (page, name) => views(page).getByRole('link', { name, exact: true });
const current = (page) => views(page).locator('[aria-current="page"]');
const assignmentTabs = (page) => page.locator('.assignment-tabs .primer-tab');

async function setup(page) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: ASSIGNMENTS, reports: REPORTS });
}

test.describe('88 - Assignments, Roster, Organization', () => {
  test('on an assignment, its own tabs carry it, Settings included', async ({ page }) => {
    await setup(page);
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(assignmentTabs(page)).toHaveText(['Progress', 'Grading', 'Settings']);

    await assignmentTabs(page).filter({ hasText: /^Settings$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${ID}\\?tab=settings$`));
    // Its title, not its slug (lib/assignment-crumb.js).
    await expect(page.locator('.app-header-heading')).toHaveText('Lab Switch');
    await expect(page.locator('.assignment-tabs [aria-current="page"]')).toHaveText('Settings');

    await assignmentTabs(page).filter({ hasText: /^Progress$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${ID}$`));
  });

  test('the breadcrumb leads back to the assignment cards: org / Assignments / the assignment', async ({ page }) => {
    // The centre tab lit on every assignment read as "where you are", not as a
    // way back (2026-10-05). The way back is in the trail, where "up" is.
    await setup(page);
    for (const [path, here] of [[`/${ID}?tab=settings`, 'Lab Switch'], ['/new', 'New assignment']]) {
      await page.goto(`/dashboard/${ORG}${path}`);
      const crumbs = page.locator('.app-header-crumbs');
      await expect(crumbs.locator('.app-header-heading')).toHaveText(here, { timeout: 15000 });
      const back = crumbs.getByRole('link', { name: 'Assignments', exact: true });
      await expect(back).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}$`));
    }
    await page.locator('.app-header-crumbs').getByRole('link', { name: 'Assignments', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}$`));
    await expect(page.getByRole('link', { name: 'New assignment' })).toBeVisible({ timeout: 15000 });
    // On the list itself there is no step back to take.
    await expect(page.locator('.app-header-crumbs').getByRole('link', { name: 'Assignments', exact: true })).toHaveCount(0);
  });

  test('inside an assignment Assignments stays lit, and leads back to the list', async ({ page }) => {
    await setup(page);
    for (const path of [`/${ID}`, `/${ID}?tab=settings`, '/new']) {
      await page.goto(`/dashboard/${ORG}${path}`);
      const assignments = tab(page, 'Assignments');
      await expect(assignments).toHaveClass(/active/);
      await expect(assignments).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}$`));
    }
  });

  test('old Admin links land where their page went', async ({ page }) => {
    await setup(page);
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${ID}\\?tab=settings$`));
    // Settings was its own address for a day; those links land too.
    await page.goto(`/dashboard/${ORG}/${ID}/settings`);
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${ID}\\?tab=settings$`));
    await page.goto(`/dashboard/${ORG}/admin?new=1`);
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/new$`));
    await page.goto(`/dashboard/${ORG}/admin`);
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}$`));
  });

  test('on the roster, both other tabs go to their plain views', async ({ page }) => {
    await setup(page);
    await page.goto(`/dashboard/${ORG}/roster`);
    await expect(current(page)).toHaveText('Roster');
    await expect(tab(page, 'Assignments')).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}$`));
    await expect(tab(page, 'Organization')).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}/organization$`));
  });

  test('the three tabs are the same three on every page, in the same order', async ({ page }) => {
    await setup(page);
    for (const path of ['', `/${ID}`, `/${ID}?tab=settings`, '/roster', '/organization']) {
      await page.goto(`/dashboard/${ORG}${path}`);
      await expect(views(page).locator('.primer-tab')).toHaveText(['Assignments', 'Roster', 'Organization']);
    }
  });
});
