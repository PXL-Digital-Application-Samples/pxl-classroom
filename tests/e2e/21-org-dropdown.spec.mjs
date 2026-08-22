import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// Regression: the dashboard org dropdown opens BELOW the header
// (position: absolute; top: calc(100% + 4px)). When AppHeader landed,
// .app-header-left carried `overflow: hidden` to truncate long breadcrumbs -
// which also clips absolutely positioned descendants, so the menu rendered
// with zero height and the control looked dead. Vue state was fine; only the
// paint was gone, which is why a DOM-presence assertion would have missed it.

test.describe('21 - Dashboard org dropdown', () => {
  test('The menu is actually visible and clickable when opened', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);

    const trigger = page.locator('.org-dropdown-btn');
    await expect(trigger).toBeVisible();

    const menu = page.locator('.org-dropdown-menu');
    await expect(menu).toBeHidden();

    await trigger.click();

    // NOT toBeVisible() / boundingBox(): `overflow: hidden` on an ancestor
    // clips PAINTING while leaving the layout box intact, so both of those
    // report a healthy element for a dropdown the user cannot see. Verified -
    // with the bug reintroduced, both still passed.
    //
    // Hit-testing is what actually matches the complaint. A clipped region is
    // neither painted nor hit-testable, so elementFromPoint at the menu's own
    // centre returns whatever is behind it instead.
    const hit = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        height: r.height,
        width: r.width,
        insideMenu: Boolean(at && el.contains(at)),
        actuallyAt: at ? `${at.tagName.toLowerCase()}.${at.className.toString().trim().split(/\s+/).join('.')}` : null,
      };
    });

    expect(hit.height, 'the menu is collapsed to zero height').toBeGreaterThan(10);
    expect(hit.width).toBeGreaterThan(100);
    expect(
      hit.insideMenu,
      `the centre of the menu hit "${hit.actuallyAt}" instead of the menu - it is clipped or covered`,
    ).toBe(true);

    // And the row must be genuinely clickable, not merely painted.
    const option = menu.locator('.org-dropdown-item').first();
    await expect(option).toBeVisible();
    await expect(option).toContainText(/\w/);
    await option.click({ trial: true });
  });

  test('No ancestor of the dropdown clips overflow', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);
    await page.locator('.org-dropdown-btn').click();

    // Names the offending element directly, so the next person does not have to
    // rediscover which ancestor is doing it.
    const clippers = await page.locator('.org-dropdown-menu').evaluate((el) => {
      const bad = [];
      for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const { overflow, overflowX, overflowY } = getComputedStyle(n);
        if ([overflow, overflowX, overflowY].some((v) => v === 'hidden' || v === 'clip')) {
          bad.push(`${n.tagName.toLowerCase()}.${n.className.toString().trim().split(/\s+/).join('.')}`);
        }
      }
      return bad;
    });

    expect(
      clippers,
      'these ancestors clip overflow, which hides the dropdown that renders below the header',
    ).toEqual([]);
  });
});
