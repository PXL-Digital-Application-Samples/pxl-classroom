// 47 - A dialog opens where the user is looking.
//
// THE BUG THIS FILE EXISTS FOR LOOKED LIKE A DEAD BUTTON.
//
// Reported from live use: "Automated checks ... if I press Set up, I get an
// empty screen" (2026-09-02). The button worked, the modal rendered, its
// content was correct - and it was drawn 1245 pixels ABOVE the top of the
// viewport, so the lecturer saw a dimmed page and nothing else.
//
// `.admin-view` carried the `fade-in` class. `fadeIn` ends on
// `transform: translateY(0)` with `animation-fill-mode: forwards`, so the
// element keeps `transform: matrix(1,0,0,1,0,0)` permanently - and ANY
// transform other than `none` makes an element the containing block for its
// `position: fixed` descendants. `.modal-overlay { position: fixed; inset: 0 }`
// therefore resolved against the 2000px-tall page wrapper instead of the
// viewport, and landed exactly `scrollY` pixels off-screen.
//
// A unit test cannot see this and neither can a screenshot of an unscrolled
// page: the modal is only lost once the page has been scrolled far enough to
// reach the button that opens it. So this measures the rendered box against the
// viewport, on a scrolled page, which is the only thing that would have caught
// it.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

test.describe('47 - a dialog opens inside the viewport', () => {
  test('the Automated checks modal is on screen, not scrolled off the top', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/admin`);

    await page.locator('button', { hasText: 'New assignment' }).first().click();
    const setup = page.locator('.autograde-summary-row button').first();
    await expect(setup).toBeVisible({ timeout: 15000 });

    // Reaching the button scrolls the page, which is the whole precondition.
    await setup.click();

    const modal = page.locator('.modal-overlay .modal');
    await expect(modal).toBeVisible();

    const viewport = page.viewportSize();
    const box = await modal.boundingBox();
    expect(box, 'the dialog must have a rendered box').not.toBeNull();

    // The POSITIVE assertion, and the one that failed: its top edge is on
    // screen. It was -1245.
    expect(
      box.y,
      `DESIGN.md - a dialog must open where the user is looking. Its top edge is at ` +
        `y=${Math.round(box.y)}, outside the ${viewport.height}px viewport. An ancestor ` +
        `with a transform (a leftover \`fade-in\`, most likely) turns .modal-overlay's ` +
        `position:fixed into position:absolute against that ancestor.`,
    ).toBeGreaterThanOrEqual(0);
    expect(box.y, 'the dialog must not start below the fold either').toBeLessThan(viewport.height);
  });

  test('the overlay covers the viewport rather than the document', async ({ page }) => {
    // The same fault seen from the other side, and the cheaper signal: a fixed
    // overlay is exactly the viewport. Trapped, it becomes the full scroll
    // height (measured at 2000px tall, starting at y=-1281).
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/admin`);

    await page.locator('button', { hasText: 'New assignment' }).first().click();
    const setup = page.locator('.autograde-summary-row button').first();
    await expect(setup).toBeVisible({ timeout: 15000 });
    await setup.click();

    const viewport = page.viewportSize();
    const box = await page.locator('.modal-overlay').boundingBox();

    // A few pixels of slack, deliberately: the overlay runs `fadeIn` itself and
    // that animation starts at translateY(4px), so catching it mid-flight is
    // normal and means nothing. The fault this guards against is off by ~1281px
    // with a height of ~2000 - it is not a near miss, and no tolerance that
    // stays honest about the animation could hide it.
    expect(
      Math.abs(box.y),
      `a fixed overlay sits at the top of the viewport; this one starts at y=${Math.round(box.y)}`,
    ).toBeLessThan(20);
    expect(
      Math.abs(box.height - viewport.height),
      `and is viewport-high (${viewport.height}px); this one is ${Math.round(box.height)}px, ` +
        `which means the page is sizing it rather than the screen`,
    ).toBeLessThan(20);
  });

  test('no page wrapper carries a class that traps fixed positioning', async ({ page }) => {
    // Generic, and the reason this catches the NEXT one rather than only this
    // one: whatever holds a modal must not establish a containing block.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('button', { hasText: 'New assignment' }).first().click();
    const setup = page.locator('.autograde-summary-row button').first();
    await expect(setup).toBeVisible({ timeout: 15000 });
    await setup.click();
    await expect(page.locator('.modal-overlay')).toBeVisible();

    const culprits = await page.evaluate(() => {
      const out = [];
      let n = document.querySelector('.modal-overlay')?.parentElement;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        const bad = [];
        // Every property that creates a containing block for fixed descendants.
        if (cs.transform !== 'none') bad.push(`transform:${cs.transform}`);
        if (cs.filter !== 'none') bad.push(`filter:${cs.filter}`);
        if (cs.perspective !== 'none') bad.push(`perspective:${cs.perspective}`);
        if (cs.willChange !== 'auto') bad.push(`will-change:${cs.willChange}`);
        if (cs.contain !== 'none') bad.push(`contain:${cs.contain}`);
        if (bad.length) out.push(`${n.tagName}.${n.className} -> ${bad.join(' ')}`);
        n = n.parentElement;
      }
      return out;
    });

    expect(
      culprits,
      'an ancestor of .modal-overlay establishes a containing block, so the dialog ' +
        'is positioned against it instead of the viewport and will render off-screen ' +
        'once the page is scrolled',
    ).toEqual([]);
  });
});
