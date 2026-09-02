// 51 - The dashboard lists the assignments that exist.
//
// `reports/dashboard.json` is GENERATED, so it lags: publish an assignment and
// the dashboard cannot see it until the next regeneration, while the Admin
// Panel - which reads `assignments/*.yml` directly - shows it at once.
//
// The fallback that reads the YAML only ran when dashboard.json was MISSING or
// EMPTY. A present-but-stale one was trusted completely, so the newly published
// assignment was simply absent and the page said "No active assignments right
// now" - a statement about the assignments, when the truth was about the data.
// Reported from live use 2026-09-02: the lecturer went to the Admin Panel,
// found everything there, came back, and by then the dashboard had caught up.
//
// So: dashboard.json still supplies the figures, and the assignments directory
// decides the roll call.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const REPORTED = 'reported-assignment';
const FRESH = 'just-published';

const assignment = (id, over = {}) => ({
  schema_version: 1,
  id,
  title: id.replace(/-/g, ' '),
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${id}-{github_login}`,
  opens_at: '2026-08-01T08:00:00Z',
  deadline_at: '2026-12-30T20:00:00Z',
  state: 'published',
  assignment_type: 'individual',
  max_acceptances: 50,
  ...over,
});

// A dashboard that knows about ONE of the two assignments on disk - exactly the
// window between publishing and the next regeneration.
const staleDashboard = {
  schema_version: 1,
  org: ORG,
  generated_at: '2026-08-01T00:00:00Z',
  assignments: {
    [REPORTED]: {
      title: 'Reported assignment',
      state: 'published',
      deadline_at: '2026-12-30T20:00:00Z',
      accepted: 3,
    },
  },
};

async function dashboard(page, { assignments, dashboardJson = staleDashboard } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments,
    reports: { dashboard: dashboardJson },
  });
  await page.goto(`/dashboard/${ORG}`);
}

test.describe('51 - a stale dashboard.json does not hide an assignment', () => {
  test('an assignment published since the last regeneration is still listed', async ({ page }) => {
    await dashboard(page, {
      assignments: { [REPORTED]: assignment(REPORTED), [FRESH]: assignment(FRESH) },
    });

    // The positive first: the reported one proves the page rendered at all, so
    // finding the other is an addition rather than a page that never loaded.
    await expect(page.getByText('Reported assignment')).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(`text=${FRESH}`).first(),
      'an assignment on disk but not yet in dashboard.json must still appear',
    ).toBeVisible();
  });

  test('it does not say there are none when there are', async ({ page }) => {
    // The message the lecturer actually saw. It is a claim about the
    // assignments, and the truth was about the data.
    await dashboard(page, {
      assignments: { [REPORTED]: assignment(REPORTED), [FRESH]: assignment(FRESH) },
    });

    await expect(page.getByText('Reported assignment')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=No active assignments right now')).toHaveCount(0);
  });

  test('a draft is still kept out of the list', async ({ page }) => {
    // Drafts are excluded from the generated list too, and are counted
    // separately as a prompt to publish. Catching up on the roll call must not
    // quietly change that.
    await dashboard(page, {
      assignments: {
        [REPORTED]: assignment(REPORTED),
        'not-published-yet': assignment('not-published-yet', { state: 'draft' }),
      },
    });

    await expect(page.getByText('Reported assignment')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=not-published-yet')).toHaveCount(0);
  });

  test('an archived assignment missing from dashboard.json can still be revealed', async ({ page }) => {
    // Doubly invisible before: hidden by the archived filter, and absent from
    // the count that decides whether the "Show archived" toggle exists at all.
    await dashboard(page, {
      assignments: {
        [REPORTED]: assignment(REPORTED),
        'retired-2025': assignment('retired-2025', { state: 'archived' }),
      },
    });

    await expect(page.getByText('Reported assignment')).toBeVisible({ timeout: 15000 });

    const toggle = page.locator('.archived-toggle');
    await expect(toggle, 'the toggle must appear once an archived assignment is known').toBeVisible();
    await expect(page.locator('text=retired-2025')).toHaveCount(0);

    await toggle.locator('input[type="checkbox"]').check();
    await expect(page.locator('text=retired-2025')).toBeVisible();
  });
});
