// 111 - A team page opened before the lecturer renamed the team.
//
// Review 2026-10-14: the page sent the team's OLD slug; the hub took it as the
// renamed team for its member (acceptance/accept.mjs, `renamed_from`) and made
// the repository under the NEW name - while the page waited for the old one and
// ended on "tell your lecturer". It reads the teams again when the wait would
// end, and follows the rename the published file now carries.
import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';
import { INVITED_LABEL } from '../../lib/acceptance-labels.mjs';

const ID = 'grp-renamed';
const OLD = `${ID}-team-alpha`;
const NEW = `${ID}-team-beta`;

test('the page follows the rename to the repository the hub made, instead of waiting for the old one', async ({ page }) => {
  const before = { team_slug: 'team-alpha', team_name: 'Team Alpha', members: [STUDENT_1.login], member_count: 1, max_members: 3, is_full: false };
  const after = { ...before, team_slug: 'team-beta', team_name: 'Team Beta', renamed_from: ['team-alpha'] };
  // The published file as it was when the page loaded; replaced below by the
  // regeneration the rename dispatched.
  const teams = { [ID]: [before] };
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: {
      [ID]: {
        id: ID, title: 'Renamed Team Lab', organization: ORG, state: 'published', assignment_type: 'group',
        group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
        repository_name_pattern: `${ID}-{team_slug}`, broker_repo: `broker-${ID}`,
        opens_at: new Date(Date.now() - 3600_000).toISOString(),
        deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      },
    },
    teams,
    // What the hub says of the attempt: invited, as it would be to the new repository.
    brokerIssueLabels: [INVITED_LABEL],
  });
  const asked = [];
  await page.route(`**/api.github.com/repos/${ORG}/${OLD}`, (route) => {
    asked.push(OLD);
    return route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) });
  });
  await page.route(`**/api.github.com/repos/${ORG}/${NEW}`, (route) => {
    asked.push(NEW);
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ name: NEW, full_name: `${ORG}/${NEW}`, html_url: `https://github.com/${ORG}/${NEW}` }),
    });
  });
  await page.route('**/api.github.com/user/repository_invitations*', (route) => route.fulfill({ status: 200, body: JSON.stringify([]) }));

  await page.goto(inviteUrl(ORG, ID));
  const join = page.getByRole('button', { name: /Accept & Join Team/i });
  await expect(join).toBeVisible({ timeout: 15000 });
  // The lecturer renames the team; the published file catches up.
  teams[ID] = [after];
  // And the student's OWN attempt is on the broker now, under the OLD slug -
  // the case the first version of this fix missed: read literally, it moved
  // the student out of the renamed team into a phantom old-name one.
  await page.route(`**/repos/${ORG}/broker-${ID}/issues?**`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{
      number: 1, title: `pxl-accept:token team:team-alpha`, user: { login: STUDENT_1.login },
      created_at: new Date().toISOString(), labels: [{ name: INVITED_LABEL }],
    }]),
  }));
  await join.click();

  await expect(page.getByRole('heading', { name: 'Your team repository is ready!' })).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.team-badge-banner')).toContainText('team-beta');
  expect(asked).toContain(NEW);
  // Never "tell your lecturer" on the way.
  await expect(page.locator('.timeout-state')).toHaveCount(0);
});
