import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// Reported live: narrowing the window pushed the heading and cards flush to the
// left edge with no gutter, and the page scrolled sideways. Two causes:
//
//   main { padding: var(--space-xl) 0 }  - `main` is an ELEMENT selector inside
//     a scoped block, so it carries the component attribute and out-specifies
//     .container. The shorthand therefore wiped .container's horizontal padding
//     at every width; content only looked inset above the 1240px max-width,
//     where margin:auto happened to create the gap.
//
//   .org-dropdown-container { min-width: 200px } - a hard floor in the header,
//     so the bar could not fit a narrow viewport and forced a sideways scroll.
//
// Neither is visible at desktop width, which is why nothing caught them.

const WIDTHS = [1280, 900, 700, 560, 480, 390, 360];
const MIN_GUTTER = 16;

/** Leftmost gutter of the page's own content, and any sideways overflow. */
const MEASURE = () => {
  const de = document.documentElement;
  const vw = window.innerWidth;

  const overflowing = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1) {
      overflowing.push(
        `${el.tagName.toLowerCase()}${el.className ? '.' + el.className.toString().trim().split(/\s+/).slice(0, 2).join('.') : ''}` +
        ` (right=${Math.round(r.right)} > ${vw})`,
      );
    }
  }

  // The main content block: whatever .container renders inside <main>.
  const main = document.querySelector('main.container') || document.querySelector('main');
  const block = main?.querySelector(':scope > div, :scope > section');
  const br = block?.getBoundingClientRect();

  return {
    scrollsSideways: de.scrollWidth > vw + 1,
    overflowing: overflowing.slice(0, 4),
    contentLeft: br ? Math.round(br.left) : null,
    contentRight: br ? Math.round(vw - br.right) : null,
  };
};

test.describe('25 - Responsive layout', () => {
  for (const route of ['/', `/dashboard/${ORG}`, `/dashboard/${ORG}/usage`, '/usage']) {
    test(`No sideways scroll and a real gutter at every width: ${route}`, async ({ page }) => {
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, { currentUser: LECTURER });

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route);
        await page.waitForTimeout(900);

        const m = await page.evaluate(MEASURE);

        expect(
          m.scrollsSideways,
          `${route} @${width}px scrolls sideways. Overflowing: ${m.overflowing.join(', ') || 'unknown'}`,
        ).toBe(false);

        if (m.contentLeft !== null) {
          expect(
            m.contentLeft,
            `${route} @${width}px: content sits ${m.contentLeft}px from the left edge. ` +
              'A scoped `main { padding: X 0 }` out-specifies .container and removes its gutter.',
          ).toBeGreaterThanOrEqual(MIN_GUTTER);
        }
      }
    });
  }

  test('The header itself never forces a horizontal scrollbar', async ({ page }) => {
    // A long org name plus the brand, separator and "Lecturer" tag exceeded a
    // phone-width viewport while the dropdown had a 200px floor.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });

    for (const width of [420, 390, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/dashboard/${ORG}`);
      await page.waitForTimeout(700);

      const over = await page.evaluate(() => {
        const vw = window.innerWidth;
        const out = [];
        for (const el of document.querySelectorAll('header.app-header *')) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > vw + 1) {
            out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().trim().split(/\s+/)[0]}`);
          }
        }
        return out;
      });
      expect(over, `header overflows at ${width}px`).toEqual([]);
    }
  });
});
