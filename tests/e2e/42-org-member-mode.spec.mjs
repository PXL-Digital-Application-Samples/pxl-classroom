// 42 - roster_mode: org_member on the two surfaces a person sees
//
// The gate itself is tested against a real HTTP server in
// tests/org-member-gate.test.mjs. These are the seams that file cannot reach:
// whether the lecturer's form survives a round trip through the mode, and
// whether the student is told the right thing when acceptance does not
// complete.
//
// The lecturer half exists because `loadAssignmentIntoForm` used to normalise
// with `roster_mode === 'open' ? 'open' : 'enforced'` - a ternary that silently
// rewrites any mode it predates. Opening an org_member assignment would have
// downgraded it to enforced on load, and buildDoc would have saved the
// downgrade back: the same shape as buildDoc deleting invitation tokens, and
// just as quiet. A cohort gated on membership would have quietly become a
// cohort gated on an empty roster.

import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
  expandSettings,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'net-advanced-2627';

function assignment(over = {}) {
  return {
    schema_version: 1,
    id: ID,
    title: '.NET Advanced 2627',
    organization: ORG,
    template: { owner: ORG, repository: 'starter-template' },
    repository_name_pattern: `${ID}-{github_login}`,
    opens_at: new Date(Date.now() - 86400000).toISOString(),
    deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
    state: 'published',
    assignment_type: 'individual',
    roster_mode: 'org_member',
    max_acceptances: 50,
    invite_token: inviteToken(ORG, ID),
    invite_nonce: '0badc0de',
    ...over,
  };
}

// ============================================ the lecturer's form

test.describe('42 - the Admin Panel round-trips the mode', () => {
  async function openEditor(page, a = assignment()) {
    const contentWrites = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [a.id]: a },
      userRepos: [{ name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}` }],
      contentWrites,
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${a.id}`);
    await expandSettings(page);
    return contentWrites;
  }

  const modeSelect = (page) => page.locator('select').filter({ has: page.locator('option[value="org_member"]') });

  test('the mode is offered at all', async ({ page }) => {
    await openEditor(page, assignment({ roster_mode: 'enforced' }));
    await expect(modeSelect(page).locator('option[value="org_member"]')).toHaveCount(1);
  });

  test('LOADING an org_member assignment does not downgrade it to enforced', async ({ page }) => {
    // The regression this spec exists for. Put the old ternary back in
    // loadAssignmentIntoForm and this goes red.
    await openEditor(page);
    await expect(modeSelect(page)).toHaveValue('org_member');
  });

  test('and SAVING it writes org_member back, not enforced', async ({ page }) => {
    const writes = await openEditor(page);
    await page.getByRole('button', { name: /Save/ }).first().click();
    await expect
      .poll(() => writes.find((w) => w.path === `assignments/${ID}.yml`), { timeout: 15000 })
      .toBeTruthy();
    const yaml = writes.find((w) => w.path === `assignments/${ID}.yml`).content;
    expect(yaml).toMatch(/roster_mode:\s*org_member/);
  });

  test('it explains the precondition the system cannot enforce', async ({ page }) => {
    // Students must have the invited address VERIFIED on their GitHub account,
    // or GitHub cannot connect the invitation and they read as an outsider.
    // No code can check that, so the form has to say it.
    await openEditor(page);
    const field = page.locator('.field', { has: modeSelect(page) });
    await expect(field).toContainText('verified on their GitHub account');
    await expect(field).toContainText('by email address');
  });

  test('it does NOT claim the roster decides who may accept', async ({ page }) => {
    await openEditor(page);
    const field = page.locator('.field', { has: modeSelect(page) });
    await expect(field).not.toContainText('students/roster.yml');
    await expect(field).not.toContainText('nobody can accept');
  });

  test('switching to enforced brings the roster status back', async ({ page }) => {
    await openEditor(page);
    await modeSelect(page).selectOption('enforced');
    await expect(page.locator('.roster-status')).toBeVisible();
  });

  test('org_member does not require a cap, the way open does', async ({ page }) => {
    const a = assignment();
    delete a.max_acceptances;
    await openEditor(page, a);
    await expect(page.getByText('Max acceptances is required')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Save/ }).first()).toBeEnabled();
  });
});

// The student-facing half is NOT tested here. Reaching the timeout state means
// accepting and letting the poll give up, and two `not.toContainText` tests
// written against a page that never got there passed while the mutation they
// were meant to catch was live - the vacuous-assertion trap. That copy is
// checked at source level instead, the way tests/student-wait-copy.test.mjs
// already checks the waiting screen's: see tests/org-member-gate.test.mjs.
