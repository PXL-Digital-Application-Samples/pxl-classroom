// 49 - One organization, two sections.
//
// The roster is org-wide: one `students/roster.yml`, and every assignment gated
// on it sees the same list. A course running two class groups in a year had one
// gate for both - change the roster for one section's assignment and you have
// changed it for the other's.
//
// An assignment names the class groups it admits now. `class_group` was already
// on every roster entry, already imported from CSV, already shown in the roster
// tab and already carried into reports; only the predicate was missing. It is
// deliberately the same idea as a GitHub Classroom "classroom" - a roster
// belongs to a section - stored as a column instead of a folder, so a student
// exists once and there is no second file to keep in step.
//
// What this file holds is the part a unit test cannot see: that the control
// appears only where it MEANS something, and that it states the consequence of
// a restriction before the lecturer saves rather than at the accept button.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// Two sections and one student nobody grouped - the shape that makes the
// warning worth printing.
const ROSTER = [
  { student_number: '0001', full_name: 'Alice Example', github_login: 'alice', class_group: '3A', active: true },
  { student_number: '0002', full_name: 'Bram Example', github_login: 'bram', class_group: '3A', active: true },
  { student_number: '0003', full_name: 'Cara Example', github_login: 'cara', class_group: '3B', active: true },
  { student_number: '0004', full_name: 'Dries Example', github_login: 'dries', class_group: '3B', active: true },
  { student_number: '0005', full_name: 'Eva Example', github_login: 'eva', active: true },
];

// The same five students with the column stripped, for the org that has never
// used class groups at all.
const UNGROUPED = ROSTER.map((s) => {
  const copy = { ...s };
  delete copy.class_group;
  return copy;
});

const guardrails = (page) =>
  page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) });

async function newAssignment(page, { roster = ROSTER } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, roster });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('button', { hasText: 'New assignment' }).first().click();
  await expect(guardrails(page)).toBeVisible({ timeout: 15000 });
}

/** Put the roster back in charge of who may accept. */
async function gateOnRoster(page) {
  await guardrails(page).locator('select').first().selectOption('enforced');
}

test.describe('49 - choosing which section an assignment is for', () => {
  test('the picker offers this org\'s real groups, once each', async ({ page }) => {
    await newAssignment(page);
    await gateOnRoster(page);

    await expect(page.locator('.group-picker')).toBeVisible();
    // Two groups across five students - not five chips, and not one per row.
    expect(await page.locator('.group-chip').allInnerTexts()).toEqual(['3A', '3B']);
  });

  test('nothing ticked means every group, and says so', async ({ page }) => {
    // The default has to be legible as a decision rather than as an empty
    // control - a lecturer who ticks nothing must not wonder whether they have
    // just excluded everybody.
    await newAssignment(page);
    await gateOnRoster(page);

    await expect(guardrails(page)).toContainText('All class groups');
    await expect(guardrails(page)).toContainText('Everyone on the roster may accept');
  });

  test('restricting says who it turns away, before the assignment is saved', async ({ page }) => {
    // THE POINT OF THE WHOLE CONTROL. The gate fails closed on an ungrouped
    // student, so restricting to 3A silently costs Cara, Dries and Eva their
    // way in. Being right at the accept button is no use if that is where the
    // lecturer finds out.
    await newAssignment(page);
    await gateOnRoster(page);

    await page.locator('.group-chip', { hasText: '3A' }).click();

    const text = guardrails(page);
    await expect(text).toContainText('Only');
    await expect(text).toContainText('3A');
    // 2 in 3B plus 1 with no group at all, out of 5.
    await expect(text).toContainText('3 of 5 roster students');
    await expect(text).toContainText('turned away');
  });

  test('the picker is absent under open enrolment', async ({ page }) => {
    // Under `open` the roster does not decide who may accept, so a cohort
    // filter there would be a control that changes nothing - DESIGN.md §1.5.
    // A new assignment defaults to open, so this is the state it opens in.
    await newAssignment(page);

    // Positive first: the fieldset really is on screen, so a count of zero
    // below is an absence rather than a page that had not rendered.
    await expect(guardrails(page)).toContainText('Who may accept');
    await expect(page.locator('.group-picker')).toHaveCount(0);
  });

  test('the picker is absent when the roster has no class groups', async ({ page }) => {
    // Offering a distinction this organization has never made is worse than
    // offering none: it invites a lecturer to look for groups that do not
    // exist. Same roster, every class_group removed.
    await newAssignment(page, { roster: UNGROUPED });
    await gateOnRoster(page);

    await expect(guardrails(page)).toContainText('on the roster');
    await expect(page.locator('.group-picker')).toHaveCount(0);
  });
});
