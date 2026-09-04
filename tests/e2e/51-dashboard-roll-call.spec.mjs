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
import { buildDashboardEntry } from '../../lib/dashboard-aggregate.mjs';

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
//
// The ENTRY IS BUILT, not typed out. It used to be four hand-picked fields
// beside an invented top-level `org`, which is a shape no regeneration has ever
// produced - and the panel then merge-patched that and wrote it back, so the
// spec was proving something about a document the backend could not read. Now
// the same builder report.mjs uses supplies it, and the fixture rejects the
// write if it ever stops matching schemas/dashboard.schema.json.
const staleDashboard = {
  schema_version: 1,
  generated_at: '2026-08-01T00:00:00.000Z',
  assignments: {
    [REPORTED]: buildDashboardEntry(
      {
        title: 'Reported assignment',
        state: 'published',
        opens_at: '2026-08-01T08:00:00.000Z',
        deadline_at: '2026-12-30T20:00:00.000Z',
        timezone: 'Europe/Brussels',
        max_acceptances: 50,
      },
      // Three accepted students, so `accepted: 3` is a count of something
      // rather than a number written down.
      [
        { acceptance_state: 'accepted', repo_id: 1, submission_status: 'on-time', warnings: [] },
        { acceptance_state: 'accepted', repo_id: 2, submission_status: 'on-time', warnings: [] },
        { acceptance_state: 'accepted', repo_id: 3, submission_status: 'no-submission', warnings: [] },
      ],
    ),
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

// ============================ the other direction: an entry that has gone wrong

test.describe('51 - changing an assignment repairs what the overview reads', () => {
  // Reported from live use 2026-09-04: two assignments, one closed and one
  // archived, both still reading "accepting" on the overview afterwards.
  //
  // The roll call above fixed the assignment dashboard.json does not KNOW
  // about. This is the assignment it knows about and is wrong about, which the
  // fallback cannot help with: only `publish-assignment.yml` asks for a
  // regeneration, so a close or an archive changed nothing the overview reads.
  // For an archived one nothing would ever have corrected it, because the
  // nightly that regenerates disables itself once no assignment is active.
  async function adminPanel(page, { assignments, contentWrites }) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments,
      reports: { dashboard: staleDashboard },
      contentWrites,
    });
    page.on('dialog', (d) => d.accept());
    await page.goto(`/dashboard/${ORG}/admin?edit=${REPORTED}`);
    // The lifecycle row, not the title field: a published assignment opens
    // with its settings collapsed and the cohort card on top.
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible({ timeout: 15000 });
  }

  /** The dashboard.json body the SPA last wrote, parsed. */
  function writtenDashboard(contentWrites) {
    const write = [...contentWrites].reverse().find((w) => w.path === 'reports/dashboard.json');
    return write ? JSON.parse(write.content) : null;
  }

  for (const [label, state] of [['Stop accepting', 'closed'], ['Archive', 'archived']]) {
    test(`${label} writes the new state where the overview reads it`, async ({ page }) => {
      const contentWrites = [];
      await adminPanel(page, { assignments: { [REPORTED]: assignment(REPORTED) }, contentWrites });

      await page.getByRole('button', { name: label, exact: true }).click();

      await expect
        .poll(() => writtenDashboard(contentWrites)?.assignments?.[REPORTED]?.state, { timeout: 10000 })
        .toBe(state);
    });
  }

  test('the counts it did not measure are left alone', async ({ page }) => {
    // MERGE, NEVER REPLACE. The figures came from a report this never read;
    // rebuilding the entry from the document would blank every one of them.
    const contentWrites = [];
    await adminPanel(page, { assignments: { [REPORTED]: assignment(REPORTED) }, contentWrites });

    await page.getByRole('button', { name: 'Archive', exact: true }).click();

    await expect
      .poll(() => writtenDashboard(contentWrites)?.assignments?.[REPORTED]?.state, { timeout: 10000 })
      .toBe('archived');
    const entry = writtenDashboard(contentWrites).assignments[REPORTED];
    expect(entry.accepted, 'the accepted count is not this write to make').toBe(3);
  });

  test('an assignment the dashboard has never heard of is not invented', async ({ page }) => {
    // Regeneration owns creating an entry. Writing a half-built one here would
    // put an assignment on the overview with every figure null, which reads as
    // a cohort where nobody has accepted.
    const contentWrites = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [FRESH]: assignment(FRESH) },
      reports: { dashboard: staleDashboard },
      contentWrites,
    });
    page.on('dialog', (d) => d.accept());
    await page.goto(`/dashboard/${ORG}/admin?edit=${FRESH}`);
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.toast')).toContainText(`${FRESH} -> archived`, { timeout: 10000 });

    expect(writtenDashboard(contentWrites)).toBeNull();
  });
});

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
