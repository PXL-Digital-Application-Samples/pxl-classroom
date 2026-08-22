import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
import { EXPECTED_APP_PERMISSIONS, MANIFEST_APP_PERMISSIONS } from '../../lib/audit.mjs';

test.describe('06 - System Health & Diagnostics Modal', () => {
  test('Happy Path: System Health modal opens top-anchored and displays diagnostic tiers', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
    });

    await page.goto(`/dashboard/${ORG}`);

    // The System Health button is icon-only - aria-label is the only handle.
    await page.locator('button[aria-label="System health check"]').click();

    const overlay = page.locator('.modal-overlay:has(.diagnostic-modal)');
    await expect(overlay).toBeVisible();

    // Top-anchored: SystemHealthModal's scoped .modal-overlay must beat the
    // global centred one in style.css, or a long tier list overflows the fold.
    const alignItems = await overlay.evaluate((el) => window.getComputedStyle(el).alignItems);
    expect(alignItems).toBe('flex-start');

    // Verdict banner - rendered only once the diagnostic pass has a report.
    // That pass awaits 17 checks strictly in sequence, so this is the one wait
    // in the file gated on real work rather than a render. Mocks answer
    // instantly, but on a loaded runner the 5s default is the plausible flake;
    // 15s is still far below the modal's own 30s pass budget, so a genuine
    // hang still fails here rather than timing out the whole test.
    const banner = overlay.locator('.diag-banner');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toHaveClass(/banner-(ok|warn|fail)/);
    await expect(banner.locator('.banner-text h4')).not.toBeEmpty();

    // Ordered dependency tiers (ARCHITECTURE.md: Auth -> Org -> Control repo -> ...).
    await expect(overlay.locator('.tier-card').first()).toBeVisible();
    expect(await overlay.locator('.tier-card').count()).toBeGreaterThan(1);
  });
});

// Regression: on 2026-08-21 an org onboarding failed for two hours because the
// App itself had never declared organization_administration. Every surface
// reported it as installation drift and pointed lecturers at an org-level
// "re-approve" that could not work. The modal must name the App owner instead.
// A tier auto-expands only when it is not ok, so open it explicitly rather
// than toggling blind - a blind click collapses an already-open failing tier.
async function openTier1(page) {
  const tier1 = page.locator('.tier-card', { hasText: 'Course Organization & GitHub App' });
  await expect(tier1).toBeVisible();
  if (!(await tier1.locator('.tier-checks').isVisible())) {
    await tier1.locator('.tier-header').click();
  }
  await expect(tier1.locator('.tier-checks')).toBeVisible();
  return tier1;
}

const row = (scope, label) => scope.locator(`.check-item:has(.check-label:text-is("${label}"))`);

test.describe('06b - App-level permission attribution', () => {
  test('An undeclared permission is attributed to the App, not to the org owner', async ({ page }) => {
    const declared = { ...MANIFEST_APP_PERMISSIONS };
    delete declared.organization_administration;
    const installed = { ...EXPECTED_APP_PERMISSIONS };
    delete installed.organization_administration;

    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
      appPermissions: declared,
      installationPermissions: installed,
    });

    await page.goto(`/dashboard/${ORG}`);
    await page.locator('button[aria-label="System health check"]').click();
    const tier1 = await openTier1(page);

    const declaration = row(tier1, 'GitHub App Declaration');
    await expect(declaration).toBeVisible();
    await expect(declaration.locator('.check-msg')).toContainText('organization_administration');
    await expect(declaration.locator('.check-msg')).toContainText('the App owner adds it');
    await expect(declaration.locator('.fix-action-box')).toBeVisible();

    // The org-level row must not send the lecturer off to approve something
    // that is not on offer yet.
    const perms = row(tier1, 'GitHub App Permissions');
    await expect(perms.locator('.check-msg')).toContainText('Blocked upstream');
  });

  test('A fully declared App reports the declaration healthy', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
      installationPermissions: { ...EXPECTED_APP_PERMISSIONS },
    });

    await page.goto(`/dashboard/${ORG}`);
    await page.locator('button[aria-label="System health check"]').click();

    const tier1 = await openTier1(page);
    await expect(row(tier1, 'GitHub App Declaration')).toHaveClass(/check-ok/);
  });

  test('A selected-repositories installation is flagged before students accept', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: {},
      installationPermissions: { ...EXPECTED_APP_PERMISSIONS },
      installationRepositorySelection: 'selected',
    });

    await page.goto(`/dashboard/${ORG}`);
    await page.locator('button[aria-label="System health check"]').click();

    const tier1 = await openTier1(page);
    const access = row(tier1, 'App Repository Access');
    await expect(access).toBeVisible();
    await expect(access.locator('.check-msg')).toContainText('All repositories');
  });
});
