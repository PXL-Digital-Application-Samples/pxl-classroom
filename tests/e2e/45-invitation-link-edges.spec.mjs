// 45 - The edges of an invitation link, and of the panel that reports on it
//
// Two surfaces that only meet at the wire format:
//
//   the student pastes a link into the portal, and parseInvitationLink decides
//   whether it is a link at all - a decision that got strictly harder when the
//   secret changed from a 122-character token to a 184-character key, because
//   both shapes have to be accepted during the migration
//
//   the lecturer opens System Health, where Tier 4 reports on the same two
//   shapes - and reported a MIGRATED assignment as malformed, then stopped,
//   taking the acceptance switch and the exposure sweep with it
//
// The link-box tests exist because "not a link" and "not found" are different
// answers: a truncated link has to be refused where it was pasted, not sent to
// a page whose only possible reply is that it does not exist.

import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  STUDENT_1,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
  legacyInviteToken,
  expandSettings,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'link-edges-2026';

const assignment = (over = {}) => ({
  id: ID,
  title: 'Link Edges 2026',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'a-template' },
  broker_repo: `broker-${ID}`,
  invite_key: inviteToken(ORG, ID),
  invite_pubkey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-e2e-public-half',
  invite_nonce: 'e2e00001',
  invite_expires_at: '2099-01-01T00:00:00.000Z',
  ...over,
});

const brokerRepo = {
  name: `broker-${ID}`,
  full_name: `${ORG}/broker-${ID}`,
  html_url: `https://github.com/${ORG}/broker-${ID}`,
};

// ============================================================ the paste box

async function portal(page) {
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: { [ID]: assignment() },
    userRepos: [],
  });
  await page.goto('/');
  const box = page.locator('.jump-input');
  await expect(box).toBeVisible({ timeout: 20000 });
  return box;
}

test.describe('45 - What the portal accepts as an invitation link', () => {
  test('a whole current link is taken', async ({ page }) => {
    const box = await portal(page);
    await box.fill(`https://example.test/${ORG}/i/${inviteToken(ORG, ID)}`);
    await page.getByRole('button', { name: 'Go' }).click();
    await expect(page).toHaveURL(new RegExp(`/${ORG}/i/`), { timeout: 15000 });
  });

  test('a pre-migration link is taken too, and lands on a page that explains itself', async ({ page }) => {
    // Refusing the old shape here would tell a student their link is not a link
    // at all, when it is simply out of date. Getting them to the page is this
    // function's whole job; the page decides what to say.
    const box = await portal(page);
    await box.fill(`${ORG}/${legacyInviteToken(ORG, ID)}`);
    await page.getByRole('button', { name: 'Go' }).click();
    await expect(page).toHaveURL(new RegExp(`/${ORG}/i/`), { timeout: 15000 });
  });

  test('a truncated link is refused where it was pasted', async ({ page }) => {
    // An email client wrapping a URL, or a student copying half of it. The
    // alternative is a page whose only possible answer is "not found", which
    // sends them looking for a problem with the assignment.
    const box = await portal(page);
    const short = inviteToken(ORG, ID).slice(0, 183);
    await box.fill(`${ORG}/i/${short}`);
    await page.getByRole('button', { name: 'Go' }).click();

    await expect(page.locator('body')).toContainText(/does not look like an invitation link/i);
    await expect(page).not.toHaveURL(new RegExp(`/${ORG}/i/`));
  });

  test('a link with one character too many is refused', async ({ page }) => {
    const box = await portal(page);
    await box.fill(`${ORG}/i/${inviteToken(ORG, ID)}x`);
    await page.getByRole('button', { name: 'Go' }).click();
    await expect(page.locator('body')).toContainText(/does not look like an invitation link/i);
  });

  test('a link carrying a character outside the alphabet is refused', async ({ page }) => {
    const box = await portal(page);
    const bad = `${inviteToken(ORG, ID).slice(0, 183)}+`;
    await box.fill(`${ORG}/i/${bad}`);
    await page.getByRole('button', { name: 'Go' }).click();
    await expect(page.locator('body')).toContainText(/does not look like an invitation link/i);
  });

  test('query strings, fragments and trailing slashes survive', async ({ page }) => {
    // Real links arrive from Toledo, Canvas and mail clients, all of which add
    // things.
    for (const suffix of ['/', '?ref=canvas', '#instructions', '/?utm_source=toledo']) {
      const box = await portal(page);
      await box.fill(`https://example.test/${ORG}/i/${inviteToken(ORG, ID)}${suffix}`);
      await page.getByRole('button', { name: 'Go' }).click();
      await expect(page, `suffix ${suffix} was refused`).toHaveURL(
        new RegExp(`/${ORG}/i/`),
        { timeout: 15000 },
      );
    }
  });

  test('an empty box says nothing at all', async ({ page }) => {
    // The button is disabled, and a blank submit must not produce an error
    // message about a link nobody pasted.
    const box = await portal(page);
    await box.fill('   ');
    await expect(page.getByRole('button', { name: 'Go' })).toBeDisabled();
    await expect(page.locator('body')).not.toContainText(/does not look like an invitation link/i);
  });
});

// ============================================================ mount cost

test.describe('45 - What one student page load costs', () => {
  test('each lookup happens once, not twice', async ({ page }) => {
    // checkExistingState ran from loadAssignment AND again from onMounted, so
    // every page load made both of a student's lookups twice. Measured, and
    // then halved. On a cohort opening the link at the start of a lecture, the
    // duplicate is the difference nobody would have thought to look for.
    const calls = [];
    page.on('request', (r) => {
      const u = r.url();
      if (/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(u) || u.includes('repository_invitations')) {
        calls.push(u.replace(/\?.*$/, ''));
      }
    });

    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [ID]: assignment() },
      userRepos: [],
    });
    await page.goto(`/${ORG}/i/${inviteToken(ORG, ID)}`);
    await expect(page.locator('body')).toContainText('Link Edges 2026', { timeout: 20000 });
    // Past the first poll tick, so a genuine retry would show up here.
    await page.waitForTimeout(4000);

    const counts = {};
    for (const c of calls) counts[c] = (counts[c] || 0) + 1;
    for (const [url, n] of Object.entries(counts)) {
      expect(n, `${url} was requested ${n} times on one page load`).toBeLessThanOrEqual(1);
    }
  });

  test('a failed lookup does not take the assignment down with it', async ({ page }) => {
    // Two faults met here. checkExistingState ran inside the card fetch's try,
    // so one rejected request replaced a perfectly well-loaded assignment with
    // "couldn't load the assignment data, check your connection" - about data
    // that was already in hand. And the interval driving the countdown sat
    // after two unguarded awaits, so the same rejection froze it.
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [ID]: assignment() },
      userRepos: [],
    });
    await page.route('**/api.github.com/user/repository_invitations*', (route) => route.abort());

    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/${ORG}/i/${inviteToken(ORG, ID)}`);

    // The assignment is still there, and the page does not blame the network
    // for something the network delivered.
    await expect(page.locator('body')).toContainText('Link Edges 2026', { timeout: 20000 });
    await expect(page.locator('body')).not.toContainText(/Couldn't load the assignment data/i);
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeVisible();
    expect(errors, `unhandled page errors: ${errors.join('; ')}`).toEqual([]);
  });
});

// ============================================================ System Health

async function troubleshoot(page, { doc = assignment(), variables = null } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: doc },
    userRepos: [brokerRepo],
  });
  // Registered AFTER the fixture so it wins. The fixture has no route for the
  // broker's Actions variables, so without this the whole INVITE_PUBKEY /
  // INVITE_NONCE branch degrades to "skipped" and cannot be exercised at all.
  if (variables) {
    await page.route('**/actions/variables*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          variables: Object.entries(variables).map(([name, value]) => ({ name, value })),
        }),
      }),
    );
  }
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('li, .assignment-row', { hasText: 'Link Edges 2026' }).first().click();
  await expandSettings(page);
  await page.locator('button', { hasText: 'Troubleshoot' }).first().click();
  const overlay = page.locator('.modal-overlay:has(.diagnostic-modal)');
  await expect(overlay).toBeVisible({ timeout: 20000 });
  const tier = overlay.locator('.tier-card', { hasText: /Broker|Acceptance/i }).first();
  await expect(tier).toBeVisible({ timeout: 20000 });
  if (!(await tier.locator('.tier-checks').isVisible())) {
    await tier.locator('.tier-header').click();
  }
  return overlay;
}

test.describe('45 - Tier 4 on an assignment that has migrated', () => {
  test('does not call a working keypair malformed', async ({ page }) => {
    // The regression: linkSecretFrom was swapped in without teaching the parse
    // the new shape, so a 184-character key came back null from parseToken and
    // the panel told the lecturer to republish over a perfectly good link.
    const overlay = await troubleshoot(page);

    await expect(overlay).not.toContainText(/invite_token is malformed/i);
    await expect(overlay).not.toContainText(/is not a usable acceptance key/i);
  });

  test('and keeps checking the things below it', async ({ page }) => {
    // The worse half of the same bug was the early return: everything after the
    // malformed report went unchecked. Reaching the broker-variable checks at
    // all is the proof.
    const overlay = await troubleshoot(page, {
      variables: {
        INVITE_NONCE: 'e2e00001',
        INVITE_ENABLED: 'true',
        INVITE_PUBKEY: assignment().invite_pubkey,
      },
    });
    await expect(overlay).toContainText(/Acceptance Public Key/i, { timeout: 20000 });
    await expect(overlay).toContainText(/The broker holds this assignment's acceptance key/i);
  });

  test('a broker holding somebody else\'s key is named as such', async ({ page }) => {
    // What a half-completed republish leaves behind, and it fails every
    // acceptance in silence otherwise.
    const overlay = await troubleshoot(page, {
      variables: {
        INVITE_NONCE: 'e2e00001',
        INVITE_ENABLED: 'true',
        INVITE_PUBKEY: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-a-completely-different-key',
      },
    });
    await expect(overlay).toContainText(/different acceptance key/i, { timeout: 20000 });
  });

  test('a broker with no key at all is named too, and not confused with a bad link', async ({ page }) => {
    const overlay = await troubleshoot(page, {
      variables: { INVITE_NONCE: 'e2e00001', INVITE_ENABLED: 'true' },
    });
    await expect(overlay).toContainText(/cannot verify a single acceptance/i, { timeout: 20000 });
  });

  test('acceptance switched off is still reported after the keypair check', async ({ page }) => {
    // The exact thing the early return used to swallow.
    const overlay = await troubleshoot(page, {
      variables: {
        INVITE_NONCE: 'e2e00001',
        INVITE_ENABLED: 'false',
        INVITE_PUBKEY: assignment().invite_pubkey,
      },
    });
    await expect(overlay).toContainText(/switched off/i, { timeout: 20000 });
  });

  test('the panel never prints the invitation back into itself', async ({ page }) => {
    // It is a screen a lecturer will screenshot into a support thread.
    const overlay = await troubleshoot(page);
    await expect(overlay).not.toContainText(inviteToken(ORG, ID));
  });
});
