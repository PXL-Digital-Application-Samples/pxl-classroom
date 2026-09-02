import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

// Guards DESIGN.md §5 in a real browser. The static tests in
// tests/theme-tokens.test.mjs check the source shape; these check what a user
// actually gets - which theme resolves, whether it survives a reload, and
// whether the toggle is reachable at all.

// Read from the palette rather than hardcoded, so a deliberate --bg-canvas
// change does not fail these tests for the wrong reason. What matters here is
// WHICH theme resolved, not the exact hex - tests/theme-tokens.test.mjs owns
// the token values themselves.
async function canvasFor(page, theme) {
  return page.evaluate((t) => {
    const root = document.documentElement;
    const prev = root.dataset.theme;
    root.dataset.theme = t;
    const probe = document.createElement('div');
    probe.style.background = 'var(--bg-canvas)';
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).backgroundColor;
    probe.remove();
    if (prev === undefined) delete root.dataset.theme; else root.dataset.theme = prev;
    return v;
  }, theme);
}

const canvas = (page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const dataTheme = (page) =>
  page.evaluate(() => document.documentElement.dataset.theme);
const stored = (page) =>
  page.evaluate(() => localStorage.getItem('pxl_theme'));

test.describe('19 - Theme toggle', () => {
  test('First visit follows the OS: dark machine gets dark, light machine gets light', async ({ browser }) => {
    for (const [scheme, expected] of [['dark', 'dark'], ['light', 'light']]) {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await setupStandardMockRoutes(page);
      await page.goto('/');

      expect(await dataTheme(page)).toBe('system');
      expect(await canvas(page)).toBe(await canvasFor(page, expected));
      // A plain visit must not manufacture a preference the user never expressed,
      // or 'system' could never follow a later OS change.
      expect(await stored(page)).toBeNull();

      await context.close();
    }
  });

  test('Toggle flips dark/light only, and never returns to system', async ({ browser }) => {
    // A light OS makes the "explicit dark pins against the OS" step meaningful.
    const context = await browser.newContext({ colorScheme: 'light' });
    const page = await context.newPage();
    await setupStandardMockRoutes(page);
    await page.goto('/');

    const toggle = page.locator('.theme-toggle');
    await expect(toggle).toBeVisible();

    // First visit: implicitly following the OS, nothing stored yet.
    expect(await dataTheme(page)).toBe('system');
    expect(await stored(page)).toBeNull();
    expect(await canvas(page)).toBe(await canvasFor(page, 'light'));

    // One press leaves 'system' behind for good.
    await toggle.click();
    expect(await dataTheme(page)).toBe('dark');
    expect(await stored(page)).toBe('dark');
    // An explicit choice must win over the OS.
    expect(await canvas(page)).toBe(await canvasFor(page, 'dark'));

    // From here it is a two-state flip. Eight presses must never land on
    // 'system' again - it is a starting condition, not a cycle stop.
    const seen = new Set();
    for (let i = 0; i < 8; i++) {
      await toggle.click();
      const t = await dataTheme(page);
      seen.add(t);
      expect(await stored(page), 'every press persists').toBe(t);
    }
    expect([...seen].sort(), 'the toggle must only ever produce dark or light')
      .toEqual(['dark', 'light']);

    await context.close();
  });

  test('An explicit choice survives a reload with no flash of the other theme', async ({ browser }) => {
    // OS is dark, so a stored 'light' can only come from the boot script.
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await setupStandardMockRoutes(page);
    await page.goto('/');
    // One press: the OS resolves dark, so the flip lands on light immediately.
    await page.locator('.theme-toggle').click();
    expect(await stored(page)).toBe('light');

    // Capture the attribute as early as the document exists: if the inline
    // <head> script did not set it before first paint, a light-mode user would
    // flash dark on every load.
    const earlyTheme = [];
    page.on('domcontentloaded', async () => {
      earlyTheme.push(await dataTheme(page).catch(() => null));
    });

    await page.reload();
    expect(await dataTheme(page)).toBe('light');
    expect(await canvas(page)).toBe(await canvasFor(page, 'light'));
    expect(earlyTheme.filter(Boolean)).not.toContain('dark');

    await context.close();
  });

  test('?theme= overrides and persists', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await setupStandardMockRoutes(page);

    await page.goto('/?theme=light');
    expect(await dataTheme(page)).toBe('light');
    expect(await canvas(page)).toBe(await canvasFor(page, 'light'));
    expect(await stored(page)).toBe('light');

    // The override is persisted, so a plain URL keeps it.
    await page.goto('/');
    expect(await canvas(page)).toBe(await canvasFor(page, 'light'));

    // An unrecognised value must not be applied or stored.
    await page.goto('/?theme=chartreuse');
    expect(await dataTheme(page)).toBe('light');
    expect(await stored(page)).toBe('light');

    await context.close();
  });

  test('The toggle is present on every route, signed in and signed out', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });

    const signedOut = await context.newPage();
    await setupStandardMockRoutes(signedOut);
    for (const route of ['/', '/setup', '/sandbox']) {
      await signedOut.goto(route);
      await expect(signedOut.locator('.theme-toggle'), `no toggle on ${route}`).toBeVisible();
    }
    await signedOut.close();

    const signedIn = await context.newPage();
    await injectAuth(signedIn, STUDENT_1);
    await setupStandardMockRoutes(signedIn, { currentUser: STUDENT_1 });
    for (const route of [`/dashboard/${ORG}`, `/dashboard/${ORG}/admin`, `/dashboard/${ORG}/usage`, '/usage']) {
      await signedIn.goto(route);
      await expect(signedIn.locator('.theme-toggle'), `no toggle on ${route}`).toBeVisible();
    }
    await signedIn.close();

    await context.close();
  });

  test('The sign-in card is a centred 480px card on the Usage route', async ({ browser }) => {
    // Regression: .center-card was declared in five view <style scoped> blocks
    // while seven views used it, so these rendered full-bleed and
    // left-aligned. Vue scoped styles do not leak.
    //
    // `/usage`, the cross-org aggregate, was removed in 2026-09; the per-org
    // report below is the one that remains.
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await setupStandardMockRoutes(page);

    for (const route of [`/dashboard/${ORG}/usage`]) {
      await page.goto(route);
      const card = page.locator('.center-card').first();
      await expect(card).toBeVisible();
      const box = await card.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { display: cs.display, maxWidth: cs.maxWidth, textAlign: cs.textAlign };
      });
      expect(box, `unstyled sign-in card on ${route}`).toEqual({
        display: 'flex', maxWidth: '480px', textAlign: 'center',
      });
    }

    await context.close();
  });
});
