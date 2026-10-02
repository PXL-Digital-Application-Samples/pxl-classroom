// 88 - An organization's three views: Assignments, Roster, Admin.
//
// One switch in the header of every page in the org (OrgSwitch.vue), replacing
// an assignment's Overview / Admin pair and the org's Assignments / Roster
// pair. The assignment on screen travels both ways: from its overview Admin
// opens it in the editor, and from the editor Assignments goes back to its
// overview - the most-used move, kept at one click. With no assignment in hand
// every tab goes to its plain view.

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

async function setup(page) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: ASSIGNMENTS, reports: REPORTS });
}

test.describe('88 - Assignments, Roster, Admin', () => {
  test('on an assignment, Admin opens THAT assignment in the editor', async ({ page }) => {
    await setup(page);
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(current(page)).toHaveText('Assignments');
    await expect(tab(page, 'Admin')).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}/admin\\?edit=${ID}$`));

    await tab(page, 'Admin').click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/admin\\?edit=${ID}$`));
    await expect(page.locator('.app-header-heading')).toHaveText(ID);
    await expect(current(page)).toHaveText('Admin');
  });

  test('in the editor with an assignment open, Assignments goes back to its overview', async ({ page }) => {
    await setup(page);
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await expect(page.locator('.app-header-heading')).toHaveText(ID);
    await expect(tab(page, 'Assignments')).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}/${ID}$`));

    await tab(page, 'Assignments').click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${ID}$`));
  });

  test('in the editor with nothing open, Assignments is the list', async ({ page }) => {
    await setup(page);
    await page.goto(`/dashboard/${ORG}/admin`);
    await expect(current(page)).toHaveText('Admin');
    await expect(tab(page, 'Assignments')).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}$`));
  });

  test('on the roster, both other tabs go to their plain views', async ({ page }) => {
    await setup(page);
    await page.goto(`/dashboard/${ORG}/roster`);
    await expect(current(page)).toHaveText('Roster');
    await expect(tab(page, 'Assignments')).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}$`));
    await expect(tab(page, 'Admin')).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}/admin$`));
  });

  test('the three tabs are the same three on every page, in the same order', async ({ page }) => {
    await setup(page);
    for (const path of ['', `/${ID}`, '/roster', '/admin']) {
      await page.goto(`/dashboard/${ORG}${path}`);
      await expect(views(page).locator('.primer-tab')).toHaveText(['Assignments', 'Roster', 'Admin']);
    }
  });
});
