// 54 - The dashboard's "+ Assignment" shortcut must not wipe the form mid-save.
//
// THE BUG THIS FILE EXISTS FOR PRODUCED A PUBLISHED ASSIGNMENT WITH NO BROKER,
// AND NO ERROR ANYWHERE.
//
// That button links to /dashboard/:org/admin?new=1. AdminView read the query
// inside loadAssignments() and called newAssignment(), which resets form.value
// to a blank draft - and never cleared it, so a one-shot intent became standing
// state that fired on EVERY reload of the assignment list.
//
// saveAssignment() awaits loadAssignments() immediately after the commit lands:
//
//   commit the YAML with state: published   -> written
//   form.value.state = 'published'          -> set
//   await loadAssignments()   ->  ?new=1 still set  ->  newAssignment()
//                                 form.value is now a blank DRAFT
//   back in saveAndPublish:   form.value.state === 'published'  ->  FALSE
//                             no dispatch, and no revert either
//
// The YAML says published, no broker is ever created, no workflow runs, and
// nothing appears on screen until the panel is reopened and shows "Publish
// Incomplete". What a lecturer notices is the form switching to some other
// assignment right after they save.
//
// It only ever hit this entry point - opening the Admin panel directly and
// clicking New assignment carries no query and always worked - which is why a
// sweep of thirteen orgs found exactly one affected assignment until it was
// reproduced on purpose. PXL-Automation-II/test-pe-1 and test-pe-2, 2026-09-02.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

test.describe('54 - the + Assignment shortcut', () => {
  test('the ?new=1 intent is consumed rather than left standing', async ({ page }) => {
    // The mechanism itself, independent of form validation: the query must not
    // survive, because anything that reloads the list while it is still set
    // resets the form underneath the user - including the save that is running.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });

    await page.goto(`/dashboard/${ORG}/admin?new=1`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible({ timeout: 15000 });

    await expect
      .poll(() => new URL(page.url()).searchParams.get('new'), {
        timeout: 10000,
        message: '?new=1 must be consumed once - left in the URL it re-fires on every list reload and wipes the form mid-save',
      })
      .toBeNull();
  });

  test('a save with ?edit= standing publishes the assignment you saved', async ({ page }) => {
    // THE PRODUCTION FAILURE, reproduced end to end.
    //
    // A save is the reachable trigger: saveAssignment() awaits loadAssignments()
    // right after the commit. With the route intent applied in there, the form
    // was pulled back to the ?edit= assignment before saveAndPublish read
    // form.value.state - so the publish dispatched with the WRONG id, or not at
    // all.
    //
    // Asserting on the dispatched id is what makes this non-vacuous: a version
    // that dispatches for `other-one` passes any test that only asks "did a
    // publish happen".
    const dispatches = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { 'other-one': { id: 'other-one', title: 'Other One', state: 'published' } },
      workflowDispatches: dispatches,
    });

    await page.goto(`/dashboard/${ORG}/admin?edit=other-one`);
    await expect(page.locator('.new-btn')).toBeVisible({ timeout: 15000 });

    await page.locator('.new-btn').click();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Brand New Thing');
    await expect(page.getByPlaceholder('linux-processes-2026')).toHaveValue('brand-new-thing');
    await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);

    await page.getByRole('button', { name: /Save & publish/i }).first().click();

    await expect
      .poll(() => dispatches.filter((d) => d.workflow === 'publish-assignment.yml').length, { timeout: 15000 })
      .toBeGreaterThan(0);

    const publish = dispatches.find((d) => d.workflow === 'publish-assignment.yml');
    expect(
      publish.inputs.assignment_id,
      'the publish must be for the assignment that was just saved, not the one ?edit= points at',
    ).toBe('brand-new-thing');
  });

  // TWO other tests were written for this file and deleted, both for the same
  // reason: they passed with the bug deliberately reintroduced.
  //
  //   "the form still holds what you typed after a reload" - a synthetic focus
  //   event does not make AdminView reload its list, so nothing was exercised.
  //
  //   "starting a new assignment wins over the ?edit= that got you here" -
  //   clicking New assignment does not reload the list either. The only
  //   reachable trigger is a SAVE, which is why the test above drives a real
  //   one all the way to a dispatch.
  //
  // A test that cannot fail is not a guard, and three of them would have made
  // this file look like it covered three times what it does.
});
