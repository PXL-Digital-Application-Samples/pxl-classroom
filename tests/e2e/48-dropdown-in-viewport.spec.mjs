// 48 - A menu opens where it can be read.
//
// Reported from live use: narrow the window until the toolbar wraps, open the
// Invite link menu, and "you only see a small part of the menu, the right part,
// and the left is just in the minus x direction" (2026-09-02).
//
// The triggers live in a RIGHT-ALIGNED toolbar, so the menus anchor to their
// trigger's right edge. That is correct until the toolbar wraps onto its own
// row and the triggers land at the LEFT edge - a 437px menu anchored right of a
// button at x=15 then starts at x=-315. Measured: fine at 960px, off-screen
// from 950px down.
//
// The fix is a media query at the toolbar's wrap point, which means it is
// COUPLED to what that toolbar contains - adding one more button moves the
// point at which it wraps. So this file does not assert the breakpoint; it
// measures the rendered menu against the viewport across a range of widths. If
// the wrap point moves, this says so rather than a lecturer.
//
// The same shape bit this project in the other direction once already: the
// menus were `left: 0` and overflowed the RIGHT edge, which is why they anchor
// right at all (see the note on .export-dropdown-menu). Both directions are
// covered here.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, inviteToken } from '../fixtures/e2e-fixtures.mjs';

const ID = 'linux-processes-2026';

const assignment = () => ({
  schema_version: 1,
  id: ID,
  title: 'Linux Processes 2026',
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: '2026-08-01T08:00:00Z',
  deadline_at: '2026-09-30T20:00:00Z',
  state: 'published',
  assignment_type: 'individual',
  max_acceptances: 50,
  invite_key: inviteToken(ORG, ID),
  invite_nonce: '0badc0de',
});

const report = {
  schema_version: 1,
  assignment_id: ID,
  org: ORG,
  generated_at: new Date().toISOString(),
  students: [
    {
      github_login: 'alice',
      acceptance_state: 'provisioned',
      submission_status: 'on-time',
      repo_name: `${ORG}/${ID}-alice`,
      repo_url: `https://github.com/${ORG}/${ID}-alice`,
      commit_count: 4,
    },
  ],
};

async function openDetail(page, width) {
  await page.setViewportSize({ width, height: 800 });
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment() },
    reports: { [ID]: report },
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.locator('.report-content')).toBeVisible({ timeout: 15000 });
}

/** Assert a rendered box lies inside the viewport horizontally. */
function expectWithinViewport(box, width, label) {
  expect(box, `${label}: the menu must render`).not.toBeNull();
  expect(
    Math.round(box.x),
    `${label}: the menu starts at x=${Math.round(box.x)}, off the LEFT edge - it is ` +
      `anchored to its trigger's right edge while the trigger sits at the left of a ` +
      `wrapped toolbar`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    Math.round(box.x + box.width),
    `${label}: the menu ends at x=${Math.round(box.x + box.width)}, past the ${width}px ` +
      `viewport - anchoring it left overflows the RIGHT edge instead`,
  ).toBeLessThanOrEqual(width);
}

// Wide enough for the toolbar to sit on one row, and narrow enough that it has
// wrapped. 950 and 960 straddle the measured wrap point deliberately.
const WIDTHS = [1280, 1024, 960, 950, 900, 800];

for (const width of WIDTHS) {
  test(`the Invite link menu is fully on screen at ${width}px`, async ({ page }) => {
    await openDetail(page, width);

    await page.locator('button:has(span:text-is("Invite link"))').click();
    const menu = page.locator('.invite-menu');
    await expect(menu).toBeVisible();

    expectWithinViewport(await menu.boundingBox(), width, `Invite link @ ${width}px`);
  });
}

test('the Export and More menus stay on screen once the toolbar has wrapped', async ({ page }) => {
  // Same toolbar, same anchoring, same failure - the reporter only happened to
  // open the Invite link one first.
  await openDetail(page, 900);

  for (const label of ['Export', 'More']) {
    await page.locator(`button:has(span:text-is("${label}"))`).click();
    const menu = page.locator('.export-dropdown-menu').first();
    await expect(menu).toBeVisible();
    expectWithinViewport(await menu.boundingBox(), 900, `${label} @ 900px`);
    await page.keyboard.press('Escape');
  }
});
