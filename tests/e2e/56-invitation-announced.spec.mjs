// 56 - The hub tells the student what their own token cannot.
//
// Measured 2026-09-03 on PXL-Automation-II/test-pe3. The repository existed and
// GitHub held a pending invitation for the signed-in student; from that
// student's own token, in their own browser:
//
//   GET /user/repository_invitations          -> 200 []
//   GET /user/memberships/orgs/{org}          -> 403
//
// So the page can see neither the invitation nor the org membership that would
// imply one, and the best it could do was offer a guessed link after a minute
// of waiting while saying it could not tell what was happening.
//
// The hub CAN see it, and always could: provision.mjs gets 201 from the
// collaborator grant when GitHub sends an invitation, and 204 when it does not.
// acceptance-handler.yml writes that onto the student's own broker issue as a
// LABEL - public, already open, and readable by the page.
//
// A label rather than a comment, and all three reasons were found the same day:
// a comment EMAILS the student (they authored the issue, so they are subscribed
// - one reported "Re: Acceptance (processed) - Closed #1 has been completed"
// arriving in their inbox); a comment can be forged, because anyone may comment
// on a public issue; and commenting was returning 403 on the locked issue while
// labelling the same issue returned 200.
//
// What this pins is the whole point: a student who is invited stops waiting.

import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';
import { INVITED_LABEL, REJECTED_LABEL } from '../../lib/acceptance-labels.mjs';

const GROUP_ID = 'grp-announce';
const TEAM = 'team-alpha';
const GROUP_REPO = `${GROUP_ID}-${TEAM}`;

const ID = 'hw-announce';
const REPO = `${ID}-${STUDENT_1.login}`;

const assignment = () => ({
  id: ID,
  title: 'Announced Invitation',
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
 * Accept, with the repository invisible (404 - which is what a private repo
 * behind an unaccepted invitation looks like) and the invitations endpoint
 * answering exactly as production does: 200, empty.
 */
async function acceptWith(page, brokerIssueLabels) {
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: { [ID]: assignment() },
    brokerIssueLabels,
  });
  await page.route(`**/api.github.com/repos/${ORG}/${REPO}`, (route) =>
    route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
  await page.route('**/api.github.com/user/repository_invitations*', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([]) }));

  await page.goto(inviteUrl(ORG, ID));
  await page.getByRole('button', { name: /Accept assignment/i }).click();
}

test.describe('56 - An announced invitation', () => {
  test('the student is told in seconds, not left to time out', async ({ page }) => {
    await acceptWith(page, [INVITED_LABEL]);

    // The label is read from the third tick (~6s), and the whole point is
    // that this arrives long before the 60s hold-back on the guessed link and
    // the ~160s timeout.
    await expect(page.locator('.invited-state')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.invited-state')).toContainText(/accept the collaboration invitation/i);

    // A real link to the invitation, not a tour of GitHub's notifications.
    const accept = page.getByRole('link', { name: /Accept your invitation on GitHub/i });
    await expect(accept).toBeVisible();
    await expect(accept).toHaveAttribute('href', `https://github.com/${ORG}/${REPO}/invitations`);
  });

  test('and never reaches the state that says it cannot tell', async ({ page }) => {
    await acceptWith(page, [INVITED_LABEL]);
    await expect(page.locator('.invited-state')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.pending-state')).toHaveCount(0);
    await expect(page.locator('.timeout-state')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/cannot see your GitHub invitations/i);
  });

  test('a rejection outranks a success, whichever order they arrive in', async ({ page }) => {
    // The two must never both be set - the hub writes one per attempt, and a
    // student cannot apply either. If a bug ever set both, "you were refused"
    // is the answer that sends them to their lecturer rather than to a link
    // that cannot work.
    //
    // The rejected state shares .timeout-state; its wording is what tells them
    // apart.
    await acceptWith(page, [REJECTED_LABEL, INVITED_LABEL]);
    await expect(page.locator('.timeout-state')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.invited-state'), 'the rejection is the answer').toHaveCount(0);
    await expect(page.locator('.timeout-state')).toContainText(/lecturer can see the reason/i);
  });

  test('a group student is told too', async ({ page }) => {
    // The group card is a second reader of the same labels, and it was the
    // copy that would have been left behind: it had no outcome reading at all,
    // so a team member behind an invitation got nothing an individual student
    // got. It recovers its own acceptance issue from the broker issue list it
    // already fetches to reconcile teams.
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        [GROUP_ID]: {
          id: GROUP_ID,
          title: 'Announced Group Invitation',
          organization: ORG,
          state: 'published',
          assignment_type: 'group',
          group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
          repository_name_pattern: `${GROUP_ID}-{team_slug}`,
          broker_repo: `broker-${GROUP_ID}`,
        },
      },
      teams: {
        [GROUP_ID]: [{
          team_slug: TEAM,
          team_name: 'Team Alpha',
          members: [STUDENT_1.login],
          member_count: 1,
          max_members: 3,
          is_full: false,
        }],
      },
      brokerIssues: [{
        number: 7,
        title: `pxl-accept:sometoken team:${TEAM}`,
        user: { login: STUDENT_1.login },
        created_at: new Date().toISOString(),
      }],
      brokerIssueLabels: [INVITED_LABEL],
    });
    await page.route(`**/api.github.com/repos/${ORG}/${GROUP_REPO}`, (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
    await page.route('**/api.github.com/user/repository_invitations*', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify([]) }));

    await page.goto(inviteUrl(ORG, GROUP_ID));

    const accept = page.getByRole('link', { name: /Accept your invitation on GitHub/i });
    await expect(accept).toBeVisible({ timeout: 30000 });
    await expect(accept).toHaveAttribute('href', `https://github.com/${ORG}/${GROUP_REPO}/invitations`);
  });

  test('no label means no claim - the old behaviour is untouched', async ({ page }) => {
    // Absence is still "unknown". A 204 grant earns no label at all, and a
    // failed publish leaves none either, so this is the ordinary path and it
    // must keep waiting rather than invent an invitation.
    await acceptWith(page, []);
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.pending-state')).toContainText(/Setting up your repository/i);
    await expect(page.locator('.invited-state')).toHaveCount(0);
  });
});
