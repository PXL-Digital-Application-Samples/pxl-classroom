// 101 - The Organization tab is the lecturer's: what needs them, then Advanced.
//
// Live on the testbed, 2026-10-06: the page sat on a spinner while some 35 reads
// finished - a 100-run list for a folded section the slowest of them - and then
// showed four notices of which three were about assignments deleted days ago,
// in full prose, above a "Course activity" list that repeated the assignment
// cards. Now: what needs you first, one sentence each and linked, notices about
// assignments that are gone left out (never the organization-wide ones); the
// rest - usage, health, connection, runs - in one Advanced section that reads
// nothing until opened; and the count on the tab, from every page of the org.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, openAdvanced } from '../fixtures/e2e-fixtures.mjs';
import { DEDUP_MARKER } from '../../lib/org-notices.mjs';

const ISSUE = { number: 7, state: 'open', html_url: `https://github.com/${ORG}/pxl-classroom-control/issues/7`, labels: [{ name: 'pxl-tracking' }] };
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

/** A notification exactly as notify.mjs writes one. */
const notice = (key, type, assignment, hours, details) => ({
  id: Math.floor(Math.random() * 1e6),
  body: `${DEDUP_MARKER}${key}-->\n### [ERROR] ${type}\n\n**Assignment:** ${assignment}\n**Time:** ${hoursAgo(hours)}\n\n${details}\n`,
  html_url: `${ISSUE.html_url}#${key}`,
  updated_at: hoursAgo(hours),
});

const NOTICES = [
  notice('lab-fail', 'provisioning-failed', 'lab-3', 2,
    'A student could not be given their repository.\nPress Retry on the assignment page.\n\n- `ann`'),
  notice('gone', 'preservation-failed', 'drill-race-1629', 5, 'Finalizing this assignment did not complete.'),
  notice('orphans', 'provisioning-failed', 'unrecorded-repositories', 8,
    'A student repository exists that PXL Classroom has no record of.\n\n- `lab-3-bob` (assignment lab-3)'),
];

const lab = {
  id: 'lab-3',
  title: 'Lab 3',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  template: { owner: ORG, repository: 'starter' },
  repository_name_pattern: 'lab-3-{github_login}',
};

async function open(page, { path = 'organization', comments = NOTICES } = {}) {
  const runReads = [];
  page.on('request', (r) => { if (r.url().includes('acceptance-handler.yml/runs')) runReads.push(r.url()); });
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { 'lab-3': lab },
    reports: {
      dashboard: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        assignments: { 'lab-3': { title: 'Lab 3', state: 'published', total_students: 3, accepted: 2, on_time: 0, late: 0, no_submission: 2 } },
      },
    },
    trackingIssue: ISSUE,
    trackingComments: comments,
  });
  await page.goto(`/dashboard/${ORG}${path ? `/${path}` : ''}`);
  return { runReads };
}

const needs = (page) => page.locator('.org-needs');

test.describe('101 - the Organization tab', () => {
  test('what needs you: assignments that are gone are left out, the organization\'s own are kept', async ({ page }) => {
    await open(page);
    await expect(needs(page).locator('.org-needs-title')).toHaveText(/2 things need you/, { timeout: 15000 });
    const items = needs(page).locator('.org-needs-item');
    await expect(items).toHaveCount(2);
    // By title, linked to the assignment.
    await expect(items.nth(0).getByRole('link', { name: 'Lab 3' })).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}/lab-3$`));
    // The organization-wide notice says what it is about in words, not its key.
    await expect(items.nth(1)).toContainText('Repositories nobody recorded');
    await expect(items.nth(1)).not.toContainText('unrecorded-repositories');
    // The deleted assignment's notice is not there at all.
    await expect(needs(page)).not.toContainText('drill-race-1629');
  });

  test('one sentence each, the rest behind More', async ({ page }) => {
    await open(page);
    const first = needs(page).locator('.org-needs-item').first();
    await expect(first.locator('.org-needs-text')).toHaveText('A student could not be given their repository.', { timeout: 15000 });
    const more = first.locator('details.org-needs-more');
    await expect(more.locator('.org-needs-rest')).toBeHidden();
    await more.locator('summary').click();
    await expect(more.locator('.org-needs-rest')).toContainText('Press Retry on the assignment page.');
    await expect(more.locator('.org-needs-rest')).toContainText('- ann');
  });

  test('Course activity is gone; Advanced is folded and reads nothing until opened', async ({ page }) => {
    const { runReads } = await open(page);
    await expect(needs(page).locator('.org-needs-title')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Course activity')).toHaveCount(0);
    const advanced = page.locator('details.org-advanced');
    await expect(advanced).not.toHaveAttribute('open', '');
    await expect(page.locator('.usage-panel')).toHaveCount(0);

    await openAdvanced(page);
    await expect(page.locator('.usage-panel')).toBeVisible();
    await expect(advanced.locator('details.org-fold summary')).toHaveText(['System health', 'Connection & setup', 'Recent runs']);
    expect(runReads, 'the run list is read only when Recent runs is opened').toEqual([]);

    await advanced.locator('details.org-fold summary', { hasText: 'Recent runs' }).click();
    await expect.poll(() => runReads.length, { timeout: 15000 }).toBe(1);
  });

  test('Advanced stays as it was left', async ({ page }) => {
    await open(page);
    await openAdvanced(page);
    await page.reload();
    await expect(page.locator('details.org-advanced')).toHaveAttribute('open', '', { timeout: 15000 });
  });

  test('the Organization tab carries the count from the other pages', async ({ page }) => {
    await open(page, { path: '' });
    const tab = page.getByRole('navigation', { name: 'Course views' }).getByRole('link', { name: /Organization/ });
    await expect(tab.locator('.tab-count')).toHaveText('2', { timeout: 15000 });
    await expect(tab.locator('.tab-count')).toHaveAttribute('aria-label', '2 things need you');
  });

  test('nothing to do: no count, and the page says all quiet', async ({ page }) => {
    await open(page, { comments: [] });
    await expect(needs(page)).toContainText('All quiet - nothing needs you.', { timeout: 15000 });
    await expect(page.locator('.tab-count')).toHaveCount(0);
  });
});
