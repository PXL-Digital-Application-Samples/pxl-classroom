// 84 - Changing the template of an assignment students already accepted says
// what that does, and where to go next.
//
// 2026-09-25, PXL-Automation-II / 2627-pe-1-test-1: published on the wrong
// template, accepted, template changed, saved, published again - and the
// student repository still held the old starter. Nothing is wrong with that:
// the template is what NEW acceptances are created from, and only a starter
// sync changes a repository that exists. But the screen where the template
// was changed said nothing, and the sync is on another page, under More.
//
// lib/template-change.js decides (tests/template-change.test.mjs); this is the
// wiring: the save reads the repository records only when the template
// changed, the notice names the count, and its button opens the sync dialog.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes, inviteToken, expandSettings } from '../fixtures/e2e-fixtures.mjs';

const ID = 'pe-1-test';

const liveAssignment = () => ({
  schema_version: 1,
  id: ID,
  title: 'PE 1 test',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 150,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'wrong-template' },
  invite_key: inviteToken(ORG, ID),
  invite_nonce: 'e2e00084',
  invite_expires_at: '2099-01-01T00:00:00.000Z',
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 60 * 86400_000).toISOString(),
});

const record = (s) => ({
  schema_version: 1,
  assignment_id: ID,
  github_login: s.login,
  repo_id: 1000 + s.login.length,
  repo_name: `${ORG}/${ID}-${s.login}`,
  repo_url: `https://github.com/${ORG}/${ID}-${s.login}`,
});

const brokerRepo = { name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}`, html_url: `https://github.com/${ORG}/broker-${ID}` };

async function openEditor(page, { accepted = [STUDENT_1, STUDENT_2] } = {}) {
  const reads = [];
  page.on('request', (r) => { if (r.url().includes(`/contents/repositories/${ID}`)) reads.push(r.url()); });
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: liveAssignment() },
    userRepos: [brokerRepo],
    controlRepositories: accepted.length ? { [ID]: accepted.map(record) } : {},
  });
  await page.route((url) => url.href.includes('/actions/workflows/') && url.href.includes('/dispatches'),
    (route) => route.fulfill({ status: 204, body: '' }));
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(page.getByText('Assignment is Published & Verified Live')).toBeVisible({ timeout: 15000 });
  await expandSettings(page);
  return { reads };
}

const notice = (page) => page.locator('[role="status"]', { hasText: 'Existing repositories still have the old template' });
const templateBox = (page) => page.getByPlaceholder('Type or select a template repository');

async function changeTemplateAndSave(page, to = `${ORG}/right-template`) {
  await templateBox(page).fill(to);
  await expect(page.locator('.template-preflight-badge .badge-success')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast', { hasText: `Saved ${ID}` })).toBeVisible({ timeout: 15000 });
}

test.describe('84 - changing the template under an accepted cohort', () => {
  test('says how many repositories keep the old template, and opens the sync from there', async ({ page }) => {
    await openEditor(page);
    await changeTemplateAndSave(page);

    const n = notice(page);
    await expect(n).toBeVisible();
    await expect(n).toContainText('2 students have a repository made from the previous template');
    await expect(n).toContainText(`${ORG}/right-template`);
    await expect(n).toContainText('publishing again does not change existing repositories');
    // Not a second solid button beside Save (DESIGN.md §1.2).
    await expect(n.locator('.btn-primary')).toHaveCount(0);

    await n.getByRole('link', { name: 'Sync Starter Code' }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${ID}$`));
    await expect(page.locator('.modal.card.modal-wide')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.modal.card.modal-wide')).toContainText('Sync Starter Code');
  });

  test('one student: singular', async ({ page }) => {
    await openEditor(page, { accepted: [STUDENT_1] });
    await changeTemplateAndSave(page);
    await expect(notice(page)).toContainText('1 student has a repository');
  });

  test('nobody accepted yet: nothing to say', async ({ page }) => {
    const { reads } = await openEditor(page, { accepted: [] });
    await changeTemplateAndSave(page);
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    await expect(notice(page)).toHaveCount(0);
  });

  test('a save that does not change the template reads nothing and says nothing', async ({ page }) => {
    const { reads } = await openEditor(page);
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('PE 1 test, renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast', { hasText: `Saved ${ID}` })).toBeVisible({ timeout: 15000 });
    await expect(notice(page)).toHaveCount(0);
    expect(reads, 'no directory read without a template change').toHaveLength(0);
  });

  test('Dismiss clears it, and the next unrelated save does not bring it back', async ({ page }) => {
    await openEditor(page);
    await changeTemplateAndSave(page);
    await notice(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice(page)).toHaveCount(0);
    // The stored template is now the new one, so this compares against it.
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('PE 1 test, again');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast', { hasText: `Saved ${ID}` }).last()).toBeVisible({ timeout: 15000 });
    await expect(notice(page)).toHaveCount(0);
  });

  test('?sync=1 is consumed: a refresh of the assignment page does not reopen the dialog', async ({ page }) => {
    await openEditor(page);
    await page.goto(`/dashboard/${ORG}/${ID}?sync=1`);
    await expect(page.locator('.modal.card.modal-wide')).toBeVisible({ timeout: 15000 });
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${ID}$`));
    await page.reload();
    await expect(page.locator('.cohort-table, table').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.modal.card.modal-wide')).toHaveCount(0);
  });
});
