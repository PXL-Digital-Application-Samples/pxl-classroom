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
// `invited` state with a real in-app Accept button, so the guess was gated on
// that call not answering.
//
// THAT GATE WAS WRONG, and this file now pins its replacement. Live on
// 3 Sep 2026, PXL-Automation-II/test-pe3: the repository existed, GitHub held
// a pending invitation for the signed-in student, and
// /user/repository_invitations answered 200 without it. The page therefore
// concluded there was no invitation and told the student setup had failed.
//
// So an answer is not knowledge - only a MATCH is. The link is now offered
// whenever nothing has been proven, held back past ~60s so it is not put in
// front of every student on the 20-40s happy path, and the copy beside it says
// the page cannot tell rather than that an invitation is waiting.
// tests/invitation-evidence.test.mjs holds the measurement.

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
 * yet, and neither answer from the invitations endpoint settles whether one is
 * waiting.
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
  test('Nothing in the first half-minute, whatever the invitations API says', async ({ page }) => {
    // The reported bug. Fifteen seconds in, with the repository still being
    // created, the page offered a link that 404s - and blamed the student for
    // not having accepted something that was never sent. The threshold is what
    // prevents that now: before the repository exists the URL cannot resolve,
    // so the affordance would be offered exactly where it cannot work.
    await waiting(page, { invitationsAnswer: 'empty' });
    await expect(page.locator('.pending-state')).toContainText('Waiting');

    // Well past pollCount >= 5, which is where the first bad hint appeared.
    await expect
      .poll(async () => Number((await page.locator('.pending-state').innerText()).match(/Waiting (\d+)s/)?.[1] ?? 0),
        { timeout: 40000 })
      .toBeGreaterThanOrEqual(18);

    await expect(guessLink(page), 'the repository probably does not exist yet - the link would 404')
      .toHaveCount(0);
    await expect(page.locator('.invitation-hint')).toHaveCount(0);
  });

  test('It reassures instead, without naming a cause it cannot know', async ({ page }) => {
    await waiting(page, { invitationsAnswer: 'empty' });
    const pending = page.locator('.pending-state');
    await expect(pending).toContainText(/Still going, and that is normal/i, { timeout: 30000 });
    await expect(pending, 'no accusation').not.toContainText(/waiting for you to accept/i);
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

// Each of these has to sit through the real ~60s hold-back before the link is
// allowed to appear, so they run beside each other rather than one after the
// other. They share nothing: a page, a set of routes and a clock each.
test.describe('40 - Past the ordinary window, the link is offered either way', () => {
  test.describe.configure({ mode: 'parallel' });

  for (const invitationsAnswer of ['empty', 'blind']) {
    test(`invitations answer: ${invitationsAnswer}`, async ({ page }) => {
      // BOTH answers, and that is the whole fix. A 200 with an empty list used
      // to suppress this link entirely - and that is the exact response the
      // live page got on 3 Sep 2026 while an invitation with the student's
      // name on it sat unaccepted in PXL-Automation-II/test-pe3-tomccargo.
      test.setTimeout(120000);
      await waiting(page, { invitationsAnswer });
      await expect(guessLink(page)).toBeVisible({ timeout: 90000 });

      const hint = page.locator('.invitation-hint');
      await expect(hint).toContainText(/cannot see your GitHub invitations/i);
      await expect(hint, 'and a 404 there is explained rather than mysterious')
        .toContainText(/404/);
      await expect(guessLink(page)).toHaveAttribute('href', `https://github.com/${ORG}/${REPO}/invitations`);
    });
  }
});

test.describe('40 - An invitation on page two is still an invitation', () => {
  test('The poll finds it past the first page', async ({ page }) => {
    // /user/repository_invitations defaults to THIRTY per page, and a student
    // who has accepted across several courses without accepting the repo
    // invitations accumulates them. Theirs lands last.
    //
    // This got worse when the waiting screen started trusting this call: a
    // truncated success reads as "there is no invitation", and the timeout
    // state then tells the student setup failed - the opposite of what
    // happened, and with no way for them to find the invitation that exists.
    const filler = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      repository: { name: `other-course-${i}`, full_name: `other/other-course-${i}`, owner: { login: 'other' } },
    }));
    const mine = {
      id: 555,
      repository: { name: REPO, full_name: `${ORG}/${REPO}`, html_url: `https://github.com/${ORG}/${REPO}`, owner: { login: ORG } },
    };

    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: assignment() } });
    await page.route(`**/api.github.com/repos/${ORG}/${REPO}`, (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));

    let pagesServed = 0;
    await page.route('**/api.github.com/user/repository_invitations*', (route) => {
      const u = new URL(route.request().url());
      const p = Number(u.searchParams.get('page') || 1);
      pagesServed = Math.max(pagesServed, p);
      const body = p === 1 ? filler : [mine];
      const next = new URL(u);
      next.searchParams.set('page', String(p + 1));
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // `access-control-expose-headers` is not decoration: this is a
        // cross-origin response, so JS cannot read `link` without it and the
        // pagination under test silently sees one page.
        headers: p === 1
          ? { link: `<${next}>; rel="next"`, 'access-control-expose-headers': 'link' }
          : { 'access-control-expose-headers': 'link' },
        body: JSON.stringify(body),
      });
    });

    await page.goto(inviteUrl(ORG, ID));
    await expect.poll(() => pagesServed, { timeout: 25000 }).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole('button', { name: /^Accept invitation$/i })).toBeVisible({ timeout: 25000 });
    expect(pagesServed, 'the second page must actually be requested').toBeGreaterThanOrEqual(2);
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
