// 91 - Who may accept, asked as two plain questions (AdminView whoMayAccept /
// acceptIdentity, 2026-10-02).
//
// It was a dropdown of three modes plus a checkbox that applied to one of
// them. Now: "Who may accept: Anyone with the link / Only students on the
// roster" and "When accepting, students: confirm their email address / just
// click Accept". All four combinations are real and map onto the two stored
// fields without a schema change:
//   anyone + email -> open, require_claim: true    anyone + click -> open
//   roster + email -> claim                         roster + click -> enforced

import { test, expect } from '@playwright/test';
import { parse } from 'yaml';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'who-2026';
const draft = (over = {}) => ({
  id: ID,
  title: 'Who 2026',
  organization: ORG,
  state: 'draft',
  assignment_type: 'individual',
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: `${ID}-{github_login}`,
  opens_at: '2026-01-01T08:00:00.000Z',
  deadline_at: '2027-01-01T16:00:00.000Z',
  max_acceptances: 50,
  ...over,
});

async function openDraft(page, over) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [ID]: draft(over) }, contentWrites });
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(page.getByLabel('Anyone with the link')).toBeVisible({ timeout: 15000 });
  return contentWrites;
}

async function savedDoc(page, writes) {
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect.poll(() => writes.find((w) => w.path === `assignments/${ID}.yml`), { timeout: 15000 }).toBeTruthy();
  return parse(writes.findLast((w) => w.path === `assignments/${ID}.yml`).content);
}

const anyone = (page) => page.getByLabel('Anyone with the link');
const roster = (page) => page.getByLabel('Only students on the roster');
const email = (page) => page.getByRole('radio', { name: /confirm their .* email address/ });
const click = (page) => page.getByRole('radio', { name: 'just click Accept' });

test.describe('91 - Who may accept', () => {
  for (const [who, identity, roster_mode, require_claim] of [
    ['anyone', 'email', 'open', true],
    ['anyone', 'click', 'open', false],
    ['roster', 'email', 'claim', undefined],
    ['roster', 'click', 'enforced', undefined],
  ]) {
    test(`${who} + ${identity} is stored as ${roster_mode}${require_claim === undefined ? '' : ` + require_claim ${require_claim}`}`, async ({ page }) => {
      // Start from the opposite corner, so a field left behind would show.
      const opposite = who === 'anyone' ? { roster_mode: identity === 'email' ? 'enforced' : 'claim' } : { roster_mode: 'open', require_claim: identity !== 'email' };
      const writes = await openDraft(page, opposite);
      await (who === 'anyone' ? anyone : roster)(page).check();
      await (identity === 'email' ? email : click)(page).check();
      const doc = await savedDoc(page, writes);
      expect(doc.roster_mode).toBe(roster_mode);
      // require_claim is written under `open` only (lib/assignment-doc.mjs).
      if (require_claim === undefined) expect(doc.require_claim).toBeUndefined();
      else expect(doc.require_claim).toBe(require_claim);
    });
  }

  for (const [stored, who, identity] of [
    [{ roster_mode: 'claim' }, 'roster', 'email'],
    [{ roster_mode: 'enforced' }, 'roster', 'click'],
    [{ roster_mode: 'open', require_claim: true }, 'anyone', 'email'],
    [{ roster_mode: 'open' }, 'anyone', 'click'],
  ]) {
    test(`a stored ${JSON.stringify(stored)} opens on ${who} + ${identity}`, async ({ page }) => {
      await openDraft(page, stored);
      await expect((who === 'anyone' ? anyone : roster)(page)).toBeChecked();
      await expect((identity === 'email' ? email : click)(page)).toBeChecked();
    });
  }

  test('switching who keeps the address answer, and the sentence follows both', async ({ page }) => {
    await openDraft(page, { roster_mode: 'open', require_claim: true });
    await roster(page).check();
    await expect(email(page), 'the address answer survives the switch').toBeChecked();
    await expect(page.getByText("roster's Email column")).toBeVisible();
    await anyone(page).check();
    await expect(email(page)).toBeChecked();
    await expect(page.getByText('it turns nobody away')).toBeVisible();
  });
});
