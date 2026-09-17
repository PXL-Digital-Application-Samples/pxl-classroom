// 77 - The organization switcher lists lit lamps first.
//
// Asked for 2026-09-17: it was the order GitHub listed the App's installations
// in, so a course running now could sit below last year's empty organizations.
// Green (an assignment open now), then amber (assignments, none open), then
// unlit; A-Z within each (frontend/src/lib/org-order.js).
//
// The lamps load one fetch per organization after the page, so the second spec
// is about the menu NOT reordering under the pointer while it is open.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const DAY = 24 * 60 * 60 * 1000;
const assignment = (id, state, deadlineOffset) => ({
  [id]: {
    id,
    title: id,
    state,
    assignment_type: 'individual',
    roster_mode: 'open',
    deadline_at: new Date(Date.now() + deadlineOffset).toISOString(),
  },
});

// ORG itself is the selected one and has no assignments: unlit.
const LIVE_Z = 'PXL-zeta-Live';
const LIVE_A = 'PXL-Alpha-Live';
const CLOSED = 'PXL-beta-Closed';
const PAST = 'PXL-Gamma-Past';
const EMPTY = 'PXL-Aardvark-Empty';

async function arrange(page) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: {},
    participatingOrgs: [EMPTY, CLOSED, ORG, LIVE_Z, PAST, LIVE_A],
    allOrgAssignments: {
      [LIVE_Z]: assignment('lab-z', 'published', 3 * DAY),
      [LIVE_A]: assignment('lab-a', 'published', 3 * DAY),
      [CLOSED]: assignment('lab-closed', 'closed', -3 * DAY),
      // Published with its deadline gone is amber too: nothing open now.
      [PAST]: assignment('lab-past', 'published', -3 * DAY),
    },
  });
}

const listed = (page) => page.locator('.org-dropdown-menu .org-choice-item .org-item-text').allTextContents();

test.describe('77 - Organization switcher order', () => {
  test('green, then amber, then unlit, A-Z within each', async ({ page }) => {
    await arrange(page);
    await page.goto(`/dashboard/${ORG}`);
    await page.waitForLoadState('networkidle');

    await page.locator('.org-dropdown-btn').click();
    // A-Z ignoring case: ASCII would put "PXL-Gamma" before "PXL-beta".
    expect((await listed(page)).map((s) => s.trim())).toEqual([
      LIVE_A, LIVE_Z,
      CLOSED, PAST,
      ORG, EMPTY,
    ]);
    await expect(page.locator('.org-dropdown-menu .org-choice-item').first().locator('.status-lamp'))
      .toHaveClass(/lamp-active/);
  });

  test('an open menu does not reorder when a lamp arrives late', async ({ page }) => {
    await arrange(page);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**/data/${LIVE_Z}/assignments.json*`, async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ schema_version: 1, assignments: assignment('lab-z', 'published', 3 * DAY) }),
      });
    });

    await page.goto(`/dashboard/${ORG}`);
    const zeta = page.locator('.org-choice-item', { hasText: LIVE_Z });
    await page.locator('.org-dropdown-btn').click();
    await expect(zeta.locator('.status-lamp')).not.toHaveClass(/lamp-active/);
    const before = (await listed(page)).map((s) => s.trim());
    expect(before.indexOf(LIVE_Z), 'not loaded yet, so it sorts with the unlit ones').toBeGreaterThan(before.indexOf(PAST));

    release();
    await expect(zeta.locator('.status-lamp'), 'the lamp itself updates').toHaveClass(/lamp-active/);
    expect((await listed(page)).map((s) => s.trim()), 'but the rows stay where the pointer found them').toEqual(before);

    // Closing and reopening sorts by what is known now.
    await page.locator('.org-dropdown-btn').click();
    await page.locator('.org-dropdown-btn').click();
    const after = (await listed(page)).map((s) => s.trim());
    expect(after.slice(0, 2)).toEqual([LIVE_A, LIVE_Z]);
  });
});
