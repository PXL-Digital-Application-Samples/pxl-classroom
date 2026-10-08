// 105 - What a lecturer sees between pressing Save & publish and the publish
// being under way.
//
// 2026-10-08, a lecturer creating an assignment: "at least three seconds when I
// pressed the button, nothing happened ... I was going to press it again. And
// I was at the bottom of the page ... then the green and red boxes appeared and
// disappeared." The three seconds were the checks before a save (the form, the
// slug, the name against the organization's repositories) with no busy state.
// The red box was the "Publish Incomplete ... Action Required" card: the
// document says published a moment BEFORE the publish is dispatched, so the
// broker check found none and raised it over a publish that was going fine.
//
// And the date boxes are drawn by the browser in its own language, AM/PM in a
// US-English Chrome; the line under each says the moment in 24-hour time.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'draft-105';

const draft = () => ({
  schema_version: 1,
  id: ID,
  title: 'Draft 105',
  organization: ORG,
  state: 'draft',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'starter-template' },
  opens_at: '2026-09-01T08:00:00Z',
  deadline_at: '2026-12-30T20:00:00Z',
});

async function openDraft(page) {
  const dispatches = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: draft() },
    workflowDispatches: dispatches,
  });
  // The broker does not exist until the publish makes it - which is what drew
  // the red card. Without this the fixture may answer for it, and the check
  // below could never fail.
  await page.route(`**/repos/${ORG}/broker-${ID}`, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) }));
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Draft 105', { timeout: 15000 });
  return { dispatches };
}

test.describe('105 - pressing Save & publish', () => {
  test('the press says what it is doing at once, where it was pressed, and the red card never flashes', async ({ page }) => {
    const { dispatches } = await openDraft(page);

    // Record the red card if it is EVER drawn, however briefly.
    await page.evaluate(() => {
      window.__redCardSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('.published-info-card.is-error')) window.__redCardSeen = true;
      }).observe(document.body, { childList: true, subtree: true });
    });

    // Hold the save, so "in progress" can be looked at.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**/contents/assignments/${ID}.yml`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      await held;
      return route.fallback();
    });

    const bar = page.locator('.editor-action-bar');
    const press = bar.getByRole('button', { name: 'Save & publish' });
    await press.click();

    // At once: the bar says so, and nothing can be pressed twice.
    await expect(bar.locator('[data-publish-bar]')).toHaveText(/Checking…|Saving…/, { timeout: 1000 });
    await expect(bar.locator('button.btn-primary')).toHaveText(/Checking…|Saving…/);
    await expect(bar.locator('button.btn-primary')).toBeDisabled();

    release();
    await expect.poll(() => dispatches.filter((d) => d.workflow === 'publish-assignment.yml').length, { timeout: 15000 }).toBe(1);

    // The publish is followed in steps, at the top and in the bar.
    await expect(page.locator('.publish-steps li')).toHaveCount(4, { timeout: 10000 });
    await expect(bar.locator('[data-publish-bar]')).toContainText('Publishing');
    // No box that flashes and goes: the steps say it.
    await expect(page.locator('.toast', { hasText: 'Publish workflow triggered' })).toHaveCount(0);
    expect(await page.evaluate(() => window.__redCardSeen), 'the "Publish Incomplete" card was drawn during a publish going fine').toBe(false);
  });
});

test.describe('105 - the date boxes', () => {
  test('under each box, the same moment in 24-hour time', async ({ page }) => {
    await openDraft(page);
    const readouts = page.locator('[data-date-readout]');
    await expect(readouts).toHaveCount(2, { timeout: 10000 });
    for (const r of await readouts.all()) {
      const text = await r.textContent();
      expect(text).toMatch(/\b\d{2}:\d{2}\b/);
      expect(text).not.toMatch(/\b(AM|PM)\b/i);
      expect(text).toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/);
    }
  });
});
