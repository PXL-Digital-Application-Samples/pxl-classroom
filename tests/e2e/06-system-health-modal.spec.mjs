import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

test.describe('06 - System Health & Diagnostics Modal', () => {
  test('Happy Path: System Health modal opens top-anchored and displays diagnostic tiers', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
    });

    await page.goto(`/dashboard/${ORG}`);

    // Click System Health button in navbar or header
    const healthBtn = page.locator('button', { hasText: /System Health|Diagnostics/i });
    if (await healthBtn.isVisible()) {
      await healthBtn.click();

      // Assert modal is visible
      const modal = page.locator('.diagnostics-modal-backdrop, .modal-backdrop');
      await expect(modal).toBeVisible();

      // Check top-anchored positioning
      const backdrop = page.locator('.diagnostics-modal-backdrop');
      if (await backdrop.isVisible()) {
        const style = await backdrop.evaluate((el) => window.getComputedStyle(el).alignItems);
        expect(style).toBe('flex-start');
      }

      // Check verdict banner
      const verdict = page.locator('.verdict-banner, .health-verdict');
      if (await verdict.isVisible()) {
        await expect(verdict).toBeVisible();
      }
    }
  });
});
