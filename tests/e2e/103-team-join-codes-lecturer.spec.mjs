// 103 - Team join codes, the lecturer's side: the editor's setting and the
// Teams tab, where every team's code can be read out to a student who lost it.
//
// The setting is on for a NEW group assignment and absent - off - on every
// assignment saved before it existed, which must load, and save, unchanged:
// five live organizations had self-service teams forming on the day it shipped.

import { test, expect } from '@playwright/test';
import { parse } from 'yaml';
import { ORG, LECTURER, answerConfirm, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';
import { formatJoinCode, newJoinCode } from '../../lib/team-join-code.mjs';

const ID = 'codes-2026';
const CODE = newJoinCode();

const groupAssignment = (groupConfig = {}, over = {}) => ({
  id: ID,
  title: 'Codes 2026',
  organization: ORG,
  state: 'draft',
  assignment_type: 'group',
  group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true, ...groupConfig },
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{team_slug}`,
  opens_at: '2026-01-01T08:00:00.000Z',
  deadline_at: '2027-01-01T16:00:00.000Z',
  ...over,
});

const checkbox = (page) => page.locator('[data-field="require-join-code"]');

async function openEditor(page, groupConfig) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [ID]: groupAssignment(groupConfig) }, contentWrites });
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(page.locator('.group-config-box')).toBeVisible({ timeout: 15000 });
  return contentWrites;
}

async function savedDoc(page, writes) {
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect.poll(() => writes.find((w) => w.path === `assignments/${ID}.yml`), { timeout: 15000 }).toBeTruthy();
  return parse(writes.findLast((w) => w.path === `assignments/${ID}.yml`).content);
}

test.describe('103 - team join codes, for the lecturer', () => {
  test('a new group assignment asks for codes unless the lecturer says otherwise', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/new`);
    await page.locator('input[type="radio"][value="group"]').check();
    await expect(checkbox(page)).toBeChecked();
    await expect(page.locator('.field', { has: checkbox(page) })).toContainText('You can see every team\'s code on the Teams tab');
  });

  test('an assignment saved before the setting loads with it off, and is not counted as edited', async ({ page }) => {
    const writes = await openEditor(page, {});
    await expect(checkbox(page)).not.toBeChecked();
    await expect(page.locator('.editor-action-bar [data-unsaved]')).toHaveCount(0);
    const doc = await savedDoc(page, writes);
    expect(doc.group_config.require_join_code, 'absent stays absent').toBeUndefined();
  });

  test('ticking writes true; unticking removes the field rather than writing false', async ({ page }) => {
    const writes = await openEditor(page, {});
    await checkbox(page).check();
    expect((await savedDoc(page, writes)).group_config.require_join_code).toBe(true);

    const again = await openEditor(page, { require_join_code: true });
    await expect(checkbox(page)).toBeChecked();
    await checkbox(page).uncheck();
    expect((await savedDoc(page, again)).group_config.require_join_code).toBeUndefined();
  });

  test('not offered where students cannot form teams: pre-assigned with no way out', async ({ page }) => {
    await openEditor(page, { formation_mode: 'pre-assigned', unassigned_fallback: 'block' });
    await expect(checkbox(page)).toHaveCount(0);
    await page.getByLabel('Let students with no assigned team form their own').check();
    await expect(checkbox(page)).toBeVisible();
  });

  test('not offered where students cannot create a team: it would do nothing (DESIGN.md §1.5)', async ({ page }) => {
    await openEditor(page, {});
    await expect(checkbox(page)).toBeVisible();
    await page.getByLabel('Allow students to create new teams').uncheck();
    await expect(checkbox(page)).toHaveCount(0);
  });

  test('the Teams tab shows each team\'s code while codes are on, and keeps it through a move', async ({ page }) => {
    const gitCommits = [];
    const stored = (slug, members, more = {}) => ({
      schema_version: 1, assignment_id: ID, team_slug: slug, team_name: slug, members, max_members: 3,
      created_at: '2026-10-06T09:00:00Z', created_by: members[0] || 'lecturer', ...more,
    });
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: groupAssignment({ require_join_code: true }, { state: 'published' }) },
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students: [], teams: [] } },
      controlTeams: { [ID]: [stored('alpha', ['ann'], { join_code: CODE }), stored('beta', ['bob'])] },
      gitCommits,
    });
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    const alpha = page.locator('tr', { hasText: 'alpha' }).first();
    await expect(alpha.locator('[data-join-code]')).toHaveText(formatJoinCode(CODE), { timeout: 15000 });
    await expect(page.locator('tr', { hasText: 'beta' }).first().locator('[data-join-code]')).toHaveCount(0);

    // A move rewrites both manifests; the code must ride along, not be rebuilt away.
    await alpha.getByRole('button', { name: /Manage/i }).click();
    const modal = page.locator('.modal.card', { hasText: 'Manage alpha' });
    await modal.locator('.member-manage-row', { hasText: 'ann' }).locator('select').selectOption('beta');
    await answerConfirm(page);
    await expect.poll(() => gitCommits.length, { timeout: 15000 }).toBeGreaterThan(0);
    const files = new Map(gitCommits.at(-1).files.map((f) => [f.path, JSON.parse(f.content)]));
    expect(files.get(`teams/${ID}/alpha.json`).join_code, 'the team that was left keeps its code').toBe(CODE);
    expect(files.get(`teams/${ID}/beta.json`).join_code, 'and the other is not given one').toBeUndefined();
  });

  test('with codes off the Teams tab shows none, because none opens anything', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: groupAssignment({}, { state: 'published' }) },
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students: [], teams: [] } },
      controlTeams: { [ID]: [{ schema_version: 1, assignment_id: ID, team_slug: 'alpha', team_name: 'alpha', members: ['ann'], created_at: '2026-10-06T09:00:00Z', created_by: 'ann', join_code: CODE }] },
    });
    await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
    await expect(page.locator('tr', { hasText: 'alpha' }).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-join-code]')).toHaveCount(0);
  });
});
