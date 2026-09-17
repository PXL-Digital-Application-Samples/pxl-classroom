// 76 - A sign-in is kept on the computer, and every tab follows it.
//
// Reported 2026-09-17: a lecturer copied a device code "every time", because the
// token was kept per tab - every new tab, every link opened in a new tab and
// every browser restart asked for a new code. It is kept in localStorage now, for
// everyone, until GitHub's 8-hour expiry or a sign-out (auth-storage.js).
//
// Kept on the computer means one tab's sign-in, sign-out or account switch is
// every tab's next request. So the tabs follow it, and one of these specs is
// about the case where following it would throw away somebody's typing.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const signOutButton = (page) => page.getByRole('button', { name: 'Sign out' });
const signInButton = (page) => page.getByRole('button', { name: /Sign in with GitHub/i });
const mocked = (page) => setupStandardMockRoutes(page, { currentUser: LECTURER });

/** A tab that signed in: `injectAuth` writes the record the SPA itself writes. */
async function signedInTab(context, path = `/dashboard/${ORG}`) {
  const page = await context.newPage();
  await injectAuth(page, LECTURER);
  await mocked(page);
  await page.goto(path);
  await expect(signOutButton(page)).toBeVisible({ timeout: 20000 });
  return page;
}

/** A tab with nothing injected: it knows only what the browser has stored. */
async function plainTab(context, path = `/dashboard/${ORG}`) {
  const page = await context.newPage();
  await mocked(page);
  await page.goto(path);
  return page;
}

test.describe('76 - The sign-in outlives the tab', () => {
  test('a new tab is already signed in', async ({ context }) => {
    await signedInTab(context);
    const second = await plainTab(context);
    await expect(signOutButton(second)).toBeVisible({ timeout: 20000 });
    await expect(signInButton(second)).toHaveCount(0);
  });

  test('closing and reopening the browser keeps it', async ({ browser }) => {
    const before = await browser.newContext();
    await signedInTab(before);
    const state = await before.storageState();
    await before.close();

    const after = await browser.newContext({ storageState: state });
    const page = await plainTab(after);
    await expect(signOutButton(page)).toBeVisible({ timeout: 20000 });
    await after.close();
  });

  test('an expired sign-in is not restored', async ({ context }) => {
    const page = await context.newPage();
    await page.addInitScript(({ login }) => {
      localStorage.setItem('pxl_auth', JSON.stringify({
        access_token: 'ghu_expired',
        user: { login },
        expires_at: new Date(Date.now() - 60000).toISOString(),
      }));
    }, { login: LECTURER.login });
    await mocked(page);
    await page.goto(`/dashboard/${ORG}`);
    await expect(signInButton(page)).toBeVisible({ timeout: 20000 });
  });

  test('the sign-in card says the sign-in is kept, for whoever is at a shared computer', async ({ page }) => {
    await mocked(page);
    await page.goto(`/dashboard/${ORG}`);
    await expect(signInButton(page)).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.center-card')).toContainText(/stay signed in on this computer/i);
    await expect(page.locator('.center-card')).toContainText(/sign out when you are done/i);
  });
});

test.describe('76 - Every tab follows the sign-in', () => {
  test('signing out in one tab signs out the others', async ({ context }) => {
    const first = await signedInTab(context);
    const second = await plainTab(context);
    await expect(signOutButton(second)).toBeVisible({ timeout: 20000 });

    await signOutButton(first).click();
    await expect(signInButton(second), 'the other tab must not keep a session that was ended').toBeVisible({ timeout: 20000 });
  });

  test('signing in in one tab signs in the others', async ({ context }) => {
    const waiting = await plainTab(context);
    await expect(signInButton(waiting)).toBeVisible({ timeout: 20000 });

    await signedInTab(context);
    await expect(signOutButton(waiting)).toBeVisible({ timeout: 20000 });
  });

  test('a tab with unsaved work is not reloaded, and is told what changed', async ({ context }) => {
    const first = await signedInTab(context);
    const editor = await plainTab(context, `/dashboard/${ORG}/admin`);
    await editor.locator('.new-btn').click({ timeout: 20000 });
    const title = editor.getByPlaceholder('e.g. Linux Processes 2026');
    await title.fill('Half-typed assignment');

    await signOutButton(first).click();
    await expect(editor.locator('.toast')).toContainText(/signed out in another tab/i, { timeout: 20000 });
    await expect(title, 'what was typed is still there').toHaveValue('Half-typed assignment');
  });
});
