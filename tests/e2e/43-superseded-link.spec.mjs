// 43 - The link a student was handed before the assignment migrated
//
// ARCHITECTURE §4.3.2 replaced the bearer token in the invitation with a private
// key the browser signs with. The migration happens on a republish, and from
// that moment the broker holds a public key and refuses a legacy
// `pxl-accept:<token>` title outright. Every link already handed out is dead.
//
// The student has done nothing wrong and cannot tell. Deleting the old
// acceptance card would put them on the "not found" page, which can only guess:
// "It may be out of date, incomplete, or the assignment isn't open yet". A page
// may not guess why it is stuck - the rule written after a live report of a
// student being told to accept a repository invitation that did not exist - so
// the old digest keeps resolving, to a document that states which of the three
// it is.
//
// What this pins:
//
//   * the out-of-date page renders, and names the assignment
//   * it does NOT offer Accept, or anything else implying the link still works
//   * it does not poll: the answer is definite, and six 5-second retries would
//     stall the student on a spinner in front of a reply already received
//   * a genuinely unknown digest still gets the not-found page, so the two
//     states have not been collapsed into one
//
// The negative assertions key on the HEADING, not on the phrase. The not-found
// copy contains the words "out of date" in its list of guesses - which is the
// whole reason this page exists - so a body-text check would pass against
// exactly the state it is meant to rule out.

import { test, expect } from '@playwright/test';
import {
  ORG,
  STUDENT_1,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
  inviteUrl,
  legacyInviteToken,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'hw-migrated';

/**
 * A published assignment that HAS migrated: it carries the pre-Phase-A token
 * as well as the key, which is how the fixture (following the generator) knows
 * to serve a superseded marker at the old digest.
 */
const assignment = () => ({
  id: ID,
  title: 'Shell Scripting 2026',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  repository_name_pattern: `${ID}-{github_login}`,
  broker_repo: `broker-${ID}`,
  // Both fields, which is what "migrated" means in a control repo: the key is
  // the link, and the token is the thing students are still holding.
  invite_key: inviteToken(ORG, ID),
  invite_token: legacyInviteToken(ORG, ID),
});

const oldLink = () => `/${ORG}/i/${legacyInviteToken(ORG, ID)}`;

const outOfDate = (page) =>
  page.getByRole('heading', { name: /This invitation link is out of date/i });

async function open(page, path, { signedIn = true } = {}) {
  if (signedIn) await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: { [ID]: assignment() },
  });
  await page.goto(path);
}

test.describe('43 - A superseded invitation link', () => {
  test('says the link is out of date, and names the assignment', async ({ page }) => {
    await open(page, oldLink());

    await expect(outOfDate(page)).toBeVisible({ timeout: 20000 });
    // Naming it is the point: a student holding links to several courses has to
    // know which one to ask their lecturer to replace.
    await expect(page.locator('body')).toContainText('Shell Scripting 2026');
    await expect(page.locator('body')).toContainText(/lecturer/i);
  });

  test('offers nothing that implies the link still works', async ({ page }) => {
    await open(page, oldLink());
    await expect(outOfDate(page)).toBeVisible({ timeout: 20000 });

    await expect(page.getByRole('button', { name: /Accept assignment/i })).toHaveCount(0);
    // The not-found page's "Check again" would be a false promise here: nothing
    // about this digest is going to change.
    await expect(page.getByRole('button', { name: /Check again/i })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/Accepting Submissions/i);
  });

  test('does not poll - the reply already answered the question', async ({ page }) => {
    // Counted with a listener rather than a route, so it is independent of
    // handler registration order and cannot itself change what is served.
    let cardRequests = 0;
    page.on('request', (req) => {
      if (/\/data\/[^/]+\/i\/[0-9a-f]{64}\.json/.test(req.url())) cardRequests++;
    });

    await open(page, oldLink());
    await expect(outOfDate(page)).toBeVisible({ timeout: 20000 });

    // Past two poll intervals (5 s each).
    await page.waitForTimeout(11000);
    expect(cardRequests, 'a definite answer must not be re-fetched').toBe(1);
    await expect(page.locator('body')).not.toContainText(/Looking for newly published/i);
  });

  test('an unknown link is still "not found", not "out of date"', async ({ page }) => {
    // The two states must stay distinct. Collapsing them would tell a student
    // with a mistyped link that their lecturer replaced it, and a student with
    // a replaced link that they typed it wrong.
    await open(page, `/${ORG}/i/${'z'.repeat(184)}`);

    await expect(
      page.getByRole('heading', { name: /Assignment not found|Looking for newly published/i }),
    ).toBeVisible({ timeout: 20000 });
    await expect(outOfDate(page)).toHaveCount(0);
  });

  test('the current link still works alongside it', async ({ page }) => {
    // The migration breaks the old link, not the assignment.
    await open(page, inviteUrl(ORG, ID));

    await expect(page.locator('body')).toContainText('Shell Scripting 2026', { timeout: 20000 });
    await expect(outOfDate(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeVisible();
  });

  test('a signed-out student gets the same answer', async ({ page }) => {
    // The card is public data - the page must not make them sign in only to
    // tell them the link is dead.
    await open(page, oldLink(), { signedIn: false });

    await expect(outOfDate(page)).toBeVisible({ timeout: 20000 });
    await expect(page.locator('body')).toContainText('Shell Scripting 2026');
  });
});

// --- the lecturer half of the same event ------------------------------------
//
// The republish that migrates an assignment is the one that kills its links,
// and two pieces of copy in the panel promise the exact opposite - "links
// already handed out keep working", "leave this off to repair the broker while
// every link already handed out keeps working". Left alone they would say that
// on the single publish where it is false, which is UX_PLAN C4.
//
// The lecturer is the only one who can fix it, by redistributing the new link,
// and they will not know to unless the panel says so before they click.

const brokerRepo = {
  name: `broker-${ID}`,
  full_name: `${ORG}/broker-${ID}`,
  html_url: `https://github.com/${ORG}/broker-${ID}`,
};

/** Open the editor on an assignment and bring up the republish modal. */
async function republishModal(page, assignmentDoc) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignmentDoc },
    userRepos: [brokerRepo],
  });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('li, .assignment-row', { hasText: 'Shell Scripting 2026' }).first().click();
  await page.locator('button', { hasText: 'Republish broker' }).first().click();
  const modal = page.locator('.republish-modal');
  await expect(modal).toBeVisible({ timeout: 15000 });
  return modal;
}

/** Published before Phase A: a bearer token, and no keypair yet. */
const unmigrated = () => {
  const doc = assignment();
  delete doc.invite_key;
  return doc;
};

/** Already migrated: the keypair is reused from here on, like the nonce. */
const migrated = () => assignment();

test.describe('43 - The republish that cannot keep the links', () => {
  test('warns before the click, on an assignment that has not migrated', async ({ page }) => {
    const modal = await republishModal(page, unmigrated());

    await expect(modal.locator('.alert-warning')).toContainText(
      /Links handed out so far will stop working/i,
    );
    // And it says what to do about it, which is the only reason to say it at
    // all: the lecturer is the only one who can send the replacement.
    await expect(modal.locator('.alert-warning')).toContainText(/Copy the new link/i);

    // The reassurance beside the checkbox is the same claim in miniature.
    await expect(modal.locator('.regen-choice')).not.toContainText(
      /repair the broker while every link already handed out keeps working/i,
    );
  });

  test('a migrated assignment keeps the reassurance, because it is true again', async ({ page }) => {
    // The warning is a one-off. Leaving it up afterwards would train lecturers
    // to click past it, which costs more than never showing it.
    const modal = await republishModal(page, migrated());

    await expect(modal.locator('.alert-warning')).toHaveCount(0);
    await expect(modal.locator('.regen-choice')).toContainText(
      /every link already handed out keeps working/i,
    );
  });

  test('the lifecycle hint says the same thing as the modal', async ({ page }) => {
    // A lecturer can read the hint and click without ever opening the modal, so
    // the two cannot disagree.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: unmigrated() },
      userRepos: [brokerRepo],
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('li, .assignment-row', { hasText: 'Shell Scripting 2026' }).first().click();

    const repair = page.locator('.lifecycle-repair');
    await expect(repair).toContainText(/old invitation format/i, { timeout: 15000 });
    await expect(repair).not.toContainText(/links already handed out keep working/i);
  });
});
