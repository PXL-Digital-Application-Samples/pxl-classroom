// 40 - What a student sees while their repository is being made
//
// Reported live, 24 Aug 2026: a student accepted, waited, and at fifteen
// seconds the page said GitHub might be waiting for them to accept an
// invitation and offered a link. The link 404'd. The repository turned up at
// twenty to thirty seconds.
//
// Two separate faults, and neither was the poll interval:
//
//   * The hint asserted a CAUSE from a timer. It fired at `pollCount >= 5`
//     with no evidence of an invitation - and for an org owner (added as a
//     direct collaborator, never invited) there was no invitation to accept
//     at all.
//   * The link is a guess built from the naming pattern, and
//     /<org>/<repo>/invitations 404s until the repository exists. At fifteen
//     seconds it usually does not. The affordance was offered exactly in the
//     window where it could not work.
//
// The page already polls /user/repository_invitations every tick and has an
// `invited` state with a real in-app Accept button, so the guess is only ever
// right when that call does not answer. That is the rule this pins.

import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

const ID = 'hw-wait';
const REPO = `${ID}-${STUDENT_1.login}`;

const assignment = () => ({
  id: ID,
  title: 'Waiting Room',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 50,
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  repository_name_pattern: `${ID}-{github_login}`,
  broker_repo: `broker-${ID}`,
});

/**
 * Land on the student page mid-provisioning: the repository does not exist
 * yet, and `invitationsReadable` decides what the page may say about it.
 */
async function waiting(page, { invitationsAnswer = 'empty' } = {}) {
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: { [ID]: assignment() },
  });

  // The repository is not there yet - the whole point of this state.
  await page.route(`**/api.github.com/repos/${ORG}/${REPO}`, (route) =>
    route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));

  await page.route('**/api.github.com/user/repository_invitations*', (route) => {
    if (invitationsAnswer === 'empty') {
      return route.fulfill({ status: 200, body: JSON.stringify([]) });
    }
    // Blind: the token cannot list invitations.
    return route.fulfill({ status: 403, body: JSON.stringify({ message: 'Forbidden' }) });
  });

  await page.goto(inviteUrl(ORG, ID));
  await page.getByRole('button', { name: /Accept assignment/i }).click();
  await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });
}

const guessLink = (page) => page.getByRole('link', { name: /repository invitation/i });

test.describe('40 - The waiting state does not guess', () => {
  test('No invitation link while GitHub is telling us there is no invitation', async ({ page }) => {
    // The reported bug. Fifteen seconds in, with the repository still being
    // created, the page offered a link that 404s - and blamed the student for
    // not having accepted something that was never sent.
    await waiting(page, { invitationsAnswer: 'empty' });
    await expect(page.locator('.pending-state')).toContainText('Waiting');

    // Well past pollCount >= 5, which is where the old hint appeared.
    await expect
      .poll(async () => Number((await page.locator('.pending-state').innerText()).match(/Waiting (\d+)s/)?.[1] ?? 0),
        { timeout: 40000 })
      .toBeGreaterThanOrEqual(18);

    await expect(guessLink(page), 'the invitations API answered - there is nothing to accept')
      .toHaveCount(0);
    await expect(page.locator('.invitation-hint')).toHaveCount(0);
  });

  test('It reassures instead, without naming a cause it cannot know', async ({ page }) => {
    await waiting(page, { invitationsAnswer: 'empty' });
    const pending = page.locator('.pending-state');
    await expect(pending).toContainText(/Still going, and that is normal/i, { timeout: 30000 });
    await expect(pending, 'no accusation').not.toContainText(/waiting for you to accept/i);
  });

  test('The link comes back when we genuinely cannot see invitations', async ({ page }) => {
    // A 403 is the one case where a guess beats silence: we cannot tell
    // whether an invitation is waiting, so we say exactly that.
    await waiting(page, { invitationsAnswer: 'blind' });
    await expect(guessLink(page)).toBeVisible({ timeout: 60000 });

    const hint = page.locator('.invitation-hint');
    await expect(hint).toContainText(/could not check your GitHub invitations/i);
    await expect(hint, 'and a 404 there is explained rather than mysterious')
      .toContainText(/404/);
    await expect(guessLink(page)).toHaveAttribute('href', `https://github.com/${ORG}/${REPO}/invitations`);
  });

  test('Even blind, it is held back past the window where it would 404', async ({ page }) => {
    // pollCount >= 10, not >= 5. Before ~30s the repository probably does not
    // exist and the guessed URL cannot resolve.
    await waiting(page, { invitationsAnswer: 'blind' });
    await expect(page.locator('.pending-state')).toContainText('Waiting');
    await expect(guessLink(page), 'not in the first few seconds').toHaveCount(0);
  });

  test('The wait sets an expectation instead of promising "less than a minute"', async ({ page }) => {
    // The student expected ten seconds because nothing said otherwise, then
    // concluded at thirty that the tool was broken.
    await waiting(page);
    await expect(page.locator('.pending-state')).toContainText(/20 to 40 seconds/i);
  });

  test('It counts the wait, not the poll', async ({ page }) => {
    // "Checking every 3s… (attempt 7)" is this page's telemetry; how long they
    // have been waiting is the student's question.
    await waiting(page);
    const pending = page.locator('.pending-state');
    await expect(pending).toContainText(/Waiting \d+s/);
    await expect(pending).not.toContainText(/attempt/i);
    await expect(pending).not.toContainText(/Checking every/i);
  });
});

test.describe('40 - A real invitation is handled in-app, not by a guess', () => {
  test('An invitation we CAN see gets the Accept button, never the guessed link', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [ID]: assignment() },
      invitations: [{
        id: 555,
        repository: {
          name: REPO,
          full_name: `${ORG}/${REPO}`,
          html_url: `https://github.com/${ORG}/${REPO}`,
          owner: { login: ORG },
        },
      }],
    });
    await page.route(`**/api.github.com/repos/${ORG}/${REPO}`, (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));

    // No click needed: checkExistingState finds the invitation on mount and
    // goes straight to `invited`, which is the point - the student never had
    // to wait for a timer to learn this.
    await page.goto(inviteUrl(ORG, ID));

    await expect(page.getByRole('button', { name: /^Accept invitation$/i })).toBeVisible({ timeout: 20000 });
    await expect(guessLink(page), 'we hold the real invitation - a guess adds nothing')
      .toHaveCount(0);
  });
});
