import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// DESIGN.md §1 is the half of the design system no static test can check: the
// rules are about what is VISIBLE at once, and most of these views render their
// controls conditionally. Three violations shipped before this existed, all on
// the root portal - a landing page with two competing CTAs, a signed-in view
// whose header duplicated the card's own action, and an "Open on GitHub" button
// rendered once per assignment card.

/** §1.2 - visible solid primary buttons, scoped to the modal when one is open. */
const PRIMARIES = () => {
  const vis = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  const scope = document.querySelector('.modal-overlay') || document;
  return [...scope.querySelectorAll('.btn-primary')]
    .filter(vis)
    .map((b) => b.textContent.trim().replace(/\s+/g, ' ').slice(0, 40));
};

/** §1.3 - uppercase, fully-round status pills. Status belongs on a .status-dot. */
const PILLS = () => {
  const vis = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  return [...document.querySelectorAll('*')]
    .filter((e) => vis(e) && e.children.length === 0 && e.textContent.trim())
    .filter((e) => {
      const cs = getComputedStyle(e);
      return cs.textTransform === 'uppercase' && parseFloat(cs.borderRadius) > 50;
    })
    .map((e) => `${e.textContent.trim().slice(0, 20)} [${e.className.toString().slice(0, 24)}]`);
};

async function conforms(page, label) {
  const primaries = await page.evaluate(PRIMARIES);
  expect(
    primaries.length,
    `${label}: DESIGN.md §1.2 allows ONE solid .btn-primary per view - found ${primaries.length}: ${primaries.join(' | ')}`,
  ).toBeLessThanOrEqual(1);

  const pills = await page.evaluate(PILLS);
  expect(
    pills,
    `${label}: DESIGN.md §1.3 - use .status-indicator + .status-dot with mixed-case text, not uppercase pill capsules`,
  ).toEqual([]);
}

test.describe('22 - DESIGN.md §1 conformity', () => {
  test('Signed-out routes, including the landing page', async ({ page }) => {
    await setupStandardMockRoutes(page, {});
    for (const route of ['/', '/setup', '/sandbox', '/nope-404']) {
      await page.goto(route);
      await page.waitForTimeout(700);
      await conforms(page, `signed-out ${route}`);
    }
  });

  test('Sign-in cards on authenticated routes', async ({ page }) => {
    // Every one of these is an AuthCard; its GitHub button is the single CTA.
    await setupStandardMockRoutes(page, {});
    for (const route of [
      `/dashboard/${ORG}`, `/dashboard/${ORG}/admin`, `/dashboard/${ORG}/demo`,
      `/dashboard/${ORG}/usage`, '/usage',
    ]) {
      await page.goto(route);
      await page.waitForTimeout(700);
      await conforms(page, `sign-in ${route}`);
    }
  });

  test('Signed-in lecturer routes', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    for (const route of ['/', `/dashboard/${ORG}`, `/dashboard/${ORG}/admin`,
                         `/dashboard/${ORG}/usage`, '/usage']) {
      await page.goto(route);
      await page.waitForTimeout(1100);
      await conforms(page, `signed-in ${route}`);
    }
  });

  test('A modal is its own major section', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER });
    await page.goto(`/dashboard/${ORG}`);
    await page.locator('button[aria-label="System health check"]').click();
    await expect(page.locator('.diagnostic-modal')).toBeVisible();
    await expect(page.locator('.modal-head .btn')).toBeEnabled({ timeout: 15000 });
    await conforms(page, 'System Health modal');
  });
});
