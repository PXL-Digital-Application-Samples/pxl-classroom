// 44 - What the browser actually puts in the public event
//
// Phase A's whole claim is that the acceptance title is useless to anyone but
// the account that made it. Every part of that claim lives in the seam between
// two halves: the SPA builds the title, and the broker decides whether to
// accept it. Both halves had unit tests. The seam had none - and that is where
// the bug was.
//
//   The team hint is appended AFTER signing, and the broker splits the title on
//   ".", so the signature arrived as `<signature> team:alpha`. Every group
//   acceptance on the signed path was rejected as malformed, on every group
//   assignment, while individual acceptance worked perfectly.
//
// The e2e suite could not see it because the mocked broker returned 201 for any
// title at all. It now runs the REAL verifier (see
// verifyAcceptanceTitleForBroker in the fixture), so every spec that accepts
// proves the seam - and these tests assert on the verdicts directly.

import { test, expect } from '@playwright/test';
import {
  ORG,
  STUDENT_1,
  STUDENT_2,
  injectAuth,
  setupStandardMockRoutes,
  inviteUrl,
  inviteToken,
  legacyInviteToken,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'signed-acceptance-2026';
const GROUP_ID = 'signed-group-2026';

const base = (over = {}) => ({
  organization: ORG,
  state: 'published',
  roster_mode: 'open',
  max_acceptances: 50,
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  ...over,
});

const individual = (id = ID) => base({
  id,
  title: 'Signed Acceptance',
  assignment_type: 'individual',
  repository_name_pattern: `${id}-{github_login}`,
  broker_repo: `broker-${id}`,
  invite_key: inviteToken(ORG, id),
});

const group = (id = GROUP_ID) => base({
  id,
  title: 'Signed Group Acceptance',
  assignment_type: 'group',
  group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
  repository_name_pattern: `${id}-{team_slug}`,
  broker_repo: `broker-${id}`,
  invite_key: inviteToken(ORG, id),
});

const teamsFor = (id) => ({
  [id]: [
    {
      team_slug: 'team-alpha',
      team_name: 'Team Alpha',
      members: ['someone-else'],
      member_count: 1,
      max_members: 3,
      is_full: false,
    },
  ],
});

/** Land a signed-in student on an assignment, collecting broker verdicts. */
async function student(page, { user = STUDENT_1, assignments, teams = {}, id = ID } = {}) {
  const titles = [];
  await injectAuth(page, user);
  await setupStandardMockRoutes(page, {
    currentUser: user,
    assignments,
    teams,
    acceptanceTitles: titles,
  });
  await page.goto(inviteUrl(ORG, id));
  return titles;
}

test.describe('44 - An individual acceptance, through the real verifier', () => {
  test('the title the browser posts is one the broker accepts', async ({ page }) => {
    const titles = await student(page, { assignments: { [ID]: individual() } });

    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });

    expect(titles.length, 'the SPA must have posted exactly one acceptance').toBe(1);
    expect(titles[0].ok, `broker verdict: ${titles[0].reason}`).toBe(true);
    expect(titles[0].signed).toBe(true);
  });

  test('the private key is not in it, in whole or in part', async ({ page }) => {
    // The title goes into a permanent public archive. This is the property the
    // whole phase exists for, asserted against what the browser really sent.
    const secret = inviteToken(ORG, ID);
    const titles = await student(page, { assignments: { [ID]: individual() } });

    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });

    const { title } = titles[0];
    expect(title).not.toContain(secret);
    for (let i = 0; i + 24 <= secret.length; i += 8) {
      expect(title, `key fragment at ${i} leaked`).not.toContain(secret.slice(i, i + 24));
    }
  });

  test('it names the accepting account, so a replay is detectable', async ({ page }) => {
    const titles = await student(page, { assignments: { [ID]: individual() } });
    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });

    // The fixture verifier returns the broker's own verdict; the payload it
    // parsed carries the id, and the anti-replay check compares it to the
    // issue's author. Different students must therefore produce different
    // payloads for the same assignment.
    const first = titles[0].title;

    const secondTitles = await student(page, {
      user: STUDENT_2,
      assignments: { [ID]: individual() },
    });
    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });

    const payload = (t) => t.slice('pxl-accept:'.length).split('.')[1];
    expect(payload(secondTitles[0].title)).not.toBe(payload(first));
    expect(secondTitles[0].ok).toBe(true);
  });
});

test.describe('44 - A GROUP acceptance, which was rejected for months', () => {
  test('joining a team produces a title the broker accepts', async ({ page }) => {
    const titles = await student(page, {
      assignments: { [GROUP_ID]: group() },
      teams: teamsFor(GROUP_ID),
      id: GROUP_ID,
    });

    const card = page.locator('.team-item-card', { hasText: 'Team Alpha' });
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.locator('button', { hasText: 'Join Team' }).click();

    await expect
      .poll(() => titles.length, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect(titles[0].ok, `broker verdict: ${titles[0].reason} for ${titles[0].title}`).toBe(true);
    expect(titles[0].title, 'the hint must still be there').toMatch(/ team:team-alpha$/);
  });

  test('creating a team produces a title the broker accepts', async ({ page }) => {
    const titles = await student(page, {
      assignments: { [GROUP_ID]: group() },
      teams: teamsFor(GROUP_ID),
      id: GROUP_ID,
    });

    await page.locator('.tab-pill', { hasText: /Create/i }).click();
    await page.locator('input[type="text"]').first().fill('The Newcomers');
    await page.locator('button', { hasText: 'Create & Join Team' }).click();

    await expect.poll(() => titles.length, { timeout: 15000 }).toBeGreaterThan(0);
    expect(titles[0].ok, `broker verdict: ${titles[0].reason} for ${titles[0].title}`).toBe(true);
    expect(titles[0].title).toMatch(/ team:/);
  });

  test('the title stays inside the budget with a long id and a long team name', async ({ page }) => {
    // The failure this guards is a student blocked at accept time for a reason
    // the lecturer chose months earlier, when naming the assignment. GitHub
    // enforces 1024 (measured 2026-08-26) but its own 422 says 256, so 256 is
    // the budget and the title has to fit it with the hint attached.
    const longId = '2526-automation-scripting-practicum-exam-2';
    const titles = await student(page, {
      assignments: { [longId]: group(longId) },
      teams: {
        [longId]: [
          {
            team_slug: 'a-deliberately-long-team-slug-for-the-budget-check-0123456789',
            team_name: 'A Deliberately Long Team Name For The Budget Check',
            members: ['someone-else'],
            member_count: 1,
            max_members: 3,
            is_full: false,
          },
        ],
      },
      id: longId,
    });

    const card = page.locator('.team-item-card').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.locator('button', { hasText: 'Join Team' }).click();

    await expect.poll(() => titles.length, { timeout: 15000 }).toBeGreaterThan(0);
    expect(titles[0].ok, `broker verdict: ${titles[0].reason}`).toBe(true);
    expect(titles[0].title.length, `title was ${titles[0].title.length} characters`).toBeLessThanOrEqual(256);
  });
});

test.describe('44 - Assignments that have not migrated', () => {
  test('a legacy link produces the legacy title, and is accepted', async ({ page }) => {
    // Every assignment live today is in this state. Signing with a bearer token
    // throws "not base64url" inside the crypto, which the accept button renders
    // verbatim - so without the wire-shape branch this is a broken cohort.
    const legacy = individual();
    delete legacy.invite_key;
    legacy.invite_token = legacyInviteToken(ORG, ID);

    const titles = [];
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [ID]: legacy },
      acceptanceTitles: titles,
    });
    await page.goto(`/${ORG}/i/${legacy.invite_token}`);

    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });

    expect(titles[0].ok, `broker verdict: ${titles[0].reason}`).toBe(true);
    expect(titles[0].signed).toBe(false);
    expect(titles[0].title).toBe(`pxl-accept:${legacy.invite_token}`);
  });
});

test.describe('44 - When the browser cannot sign at all', () => {
  test('a session with no account id says so, in words a student can act on', async ({ page }) => {
    // The signature names the account, so an absent id is an acceptance that
    // cannot succeed. It used to become a payload claiming no account, which
    // the broker rejects with a deliberately generic "this link is not valid" -
    // sending the student to hunt for a problem with their link.
    await injectAuth(page, { ...STUDENT_1, id: undefined });
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [ID]: individual() },
    });
    await page.goto(inviteUrl(ORG, ID));

    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('body')).toContainText(/account id is missing from this session/i, {
      timeout: 15000,
    });
    await expect(page.locator('body')).toContainText(/sign out and sign in again/i);
    // And not the crypto's own wording, which reads like a bad link.
    await expect(page.locator('body')).not.toContainText(/base64url/i);
  });

  test('no Web Crypto is named as such, not reported as a network problem', async ({ page }) => {
    // GitHub Pages is HTTPS, so this is a local http:// origin or a browser old
    // enough to lack the API. Without the check it surfaces from inside the
    // card fetch as "couldn't load the assignment data", pointing the student
    // at a connection that is fine.
    await page.addInitScript(() => {
      try {
        Object.defineProperty(window.crypto, 'subtle', { get: () => undefined, configurable: true });
      } catch { /* some engines refuse; the assertion below will say so */ }
    });
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [ID]: individual() },
    });
    await page.goto(inviteUrl(ORG, ID));

    await expect(page.locator('body')).toContainText(/Web Crypto/i, { timeout: 15000 });
    await expect(page.locator('body')).toContainText(/HTTPS/i);
  });
});
