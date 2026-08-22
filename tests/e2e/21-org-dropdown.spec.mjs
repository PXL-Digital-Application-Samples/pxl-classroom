import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, openMoreActionsMenu } from '../fixtures/e2e-fixtures.mjs';

// Regression: every popover in this app is absolutely positioned and escapes
// its trigger's box, so ANY ancestor with a clipping overflow silently hides
// it. That shipped once - AppHeader's .app-header-left carried
// `overflow: hidden` to truncate long breadcrumbs, which also clipped the
// dashboard org dropdown. The menu opened, Vue state was right, nothing
// errored; it simply was not painted.
//
// The obvious assertions do NOT catch this. Clipping removes painting but
// leaves the layout box intact, so toBeVisible() and boundingBox() both report
// a perfectly healthy element. Verified: an earlier version of this file
// passed with the bug reintroduced. Hit-testing is what actually matches the
// user-visible symptom.

/**
 * Assert an open popover is genuinely reachable, and name what is covering it
 * if not. `elementFromPoint` at the popover's own centre must land inside it -
 * a clipped region is neither painted nor hit-testable.
 */
async function expectNotClipped(page, selector, label) {
  const menu = page.locator(selector).first();
  await expect(menu, `${label}: menu not present`).toBeVisible();

  const probe = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const name = (n) =>
      `${n.tagName.toLowerCase()}${n.className ? '.' + n.className.toString().trim().split(/\s+/).join('.') : ''}`;

    const clippers = [];
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if ([cs.overflow, cs.overflowX, cs.overflowY].some((v) => v === 'hidden' || v === 'clip')) {
        clippers.push(name(n));
      }
    }
    return {
      width: r.width,
      height: r.height,
      insideMenu: Boolean(at && el.contains(at)),
      actuallyAt: at ? name(at) : null,
      clippers,
    };
  });

  expect(probe.height, `${label}: menu collapsed to zero height`).toBeGreaterThan(10);
  expect(probe.width, `${label}: menu collapsed to zero width`).toBeGreaterThan(60);
  expect(
    probe.clippers,
    `${label}: these ancestors clip overflow, which hides a popover that renders outside its trigger`,
  ).toEqual([]);
  expect(
    probe.insideMenu,
    `${label}: the centre of the menu hit "${probe.actuallyAt}" instead of the menu - it is clipped or covered`,
  ).toBe(true);
}


// The Export and More controls only render once the detail view has a report,
// so these mirror the fixture shape spec 15 uses.
const DETAIL_ID = 'clip-check';
const DETAIL_ASSIGNMENT = {
  id: DETAIL_ID,
  title: 'Clip Check',
  organization: ORG,
  assignment_type: 'individual',
  roster_mode: 'open',
  state: 'published',
  deadline_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${DETAIL_ID}-{github_login}`,
};
const DETAIL_REPORT = {
  schema_version: 1,
  assignment_id: DETAIL_ID,
  assignment_title: 'Clip Check',
  org: ORG,
  generated_at: new Date().toISOString(),
  students: [
    {
      github_login: 'student-dev1',
      name: 'Student Dev One',
      student_number: 'r0123456',
      email: 'student.one@student.pxl.be',
      repo_name: `${ORG}/${DETAIL_ID}-student-dev1`,
      acceptance_state: 'accepted',
      submission_status: 'on-time',
      preservation_status: 'preserved',
      preserved_sha: 'a1b2c3d4e5f67890abcdef1234567890abcdef12',
      commit_count: 5,
    },
  ],
};

async function gotoDetail(page) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [DETAIL_ID]: DETAIL_ASSIGNMENT },
    reports: { [DETAIL_ID]: DETAIL_REPORT },
  });
  await page.goto(`/dashboard/${ORG}/${DETAIL_ID}`);
}

test.describe('21 - Popovers are reachable, not clipped', () => {
  test('Dashboard: org dropdown', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);

    await expect(page.locator('.org-dropdown-menu')).toBeHidden();
    await page.locator('.org-dropdown-btn').click();
    await expectNotClipped(page, '.org-dropdown-menu', 'org dropdown');

    // And the row must be genuinely clickable, not merely painted.
    await page.locator('.org-dropdown-menu .org-dropdown-item').first().click({ trial: true });
  });

  test('Assignment detail: Export menu', async ({ page }) => {
    await gotoDetail(page);
    await page.getByRole('button', { name: /Export/i }).click();
    await expectNotClipped(page, '.export-dropdown-menu', 'export menu');
    await page.locator('.export-dropdown-menu .export-dropdown-item').first().click({ trial: true });
  });

  test('Assignment detail: More actions menu', async ({ page }) => {
    await gotoDetail(page);
    await openMoreActionsMenu(page);
    await expectNotClipped(page, '[role="menu"]', 'more actions menu');
  });

  test('Admin: template repository combobox', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/admin`);

    await page.locator('.new-btn').click();
    const combo = page.locator('.combobox-input-wrapper input').first();
    await expect(combo).toBeVisible();
    await combo.click();

    // The list only renders when there is something to suggest.
    const menu = page.locator('.combobox-dropdown');
    if (await menu.count()) {
      await expectNotClipped(page, '.combobox-dropdown', 'template combobox');
    } else {
      test.skip(true, 'no template suggestions in this fixture, nothing to clip');
    }
  });
});
