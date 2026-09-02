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

  // A second test asserting "the form still holds what you typed after a
  // reload" was written and deleted: it passed with the fix reverted, because
  // dispatching a focus event does not actually make AdminView reload its list.
  // A test that cannot fail is not a guard, and leaving it in would have made
  // this file look like it covered twice what it covers.
  //
  // The reachable trigger is a save, and driving a full valid assignment form
  // to a commit belongs in the CRUD spec rather than here. The check above is
  // the mechanism, and it is proven: reverting `router.replace` fails it.
});
