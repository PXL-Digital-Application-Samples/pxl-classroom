// The team list in the window where the published file has not caught up yet.
//
// THE OUTAGE THIS EXISTS FOR (2026-09-22, PXL-2TIW-DevOps-2627/groepsindeling).
// A student's acceptance writes `teams/<id>/<slug>.json` in the control repo,
// and the published teams file that every other student reads is written by a
// `regenerate-dashboard.yml` run dispatched after the acceptance finishes. That
// is one to two minutes. The live read of the broker's issues exists to cover
// exactly that window - and it had been dead for months, because it matched
// `issue.title.startsWith('team:')` while the broker redacts every title to
// "Acceptance (processed)" seconds after dispatching.
//
// Four people accepted inside 90 seconds. Each saw an empty list. Each created
// their own team. It was reported as "group work is broken", and it was.
//
// So `teams: {}` below is not laziness - it IS the scenario. The published file
// is empty because the regeneration has not run yet, and everything these
// tests assert has to come from the broker's issues.

import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

const ID = 'groepsindeling';

const ASSIGNMENT = {
  [ID]: {
    id: ID,
    title: 'Groepsindeling',
    organization: ORG,
    state: 'published',
    assignment_type: 'group',
    group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
    repository_name_pattern: `${ID}-{team_slug}`,
  },
};

/**
 * An acceptance issue as it looks to anyone reading the broker AFTER the broker
 * has handled it - which is every reader, because redaction happens within
 * seconds of the dispatch and the hub's own run takes longer than that.
 *
 * The title is the redacted one. The body is what the hub itself parses
 * (scripts/read-team-payload.mjs) and is never rewritten.
 */
function handledAcceptance({ number, login, slug, name }) {
  return {
    number,
    title: 'Acceptance (processed)',
    user: { login },
    created_at: new Date().toISOString(),
    body: JSON.stringify({ team_slug: slug, team_name: name, team_action: 'create' }),
  };
}

test.describe('79 - the team list during the regeneration lag', () => {
  test('a team created seconds ago is visible although the published file is empty', async ({ page }) => {
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: ASSIGNMENT,
      teams: {}, // the regeneration has not run yet - this is the whole point
      brokerIssues: [
        handledAcceptance({ number: 1, login: STUDENT_1.login, slug: 'rojaro', name: 'Rojaro' }),
      ],
    });

    await page.goto(inviteUrl(ORG, ID));

    await expect(page.locator('h2', { hasText: 'Group Assignment: Team Selection' })).toBeVisible({ timeout: 10000 });

    // The team is THERE, and joinable. Before 2026-09-22 this list was empty
    // and the student's only option was to create a second team.
    await expect(page.locator('.team-item-card')).toHaveCount(1);
    await expect(page.locator('.team-name', { hasText: /^Rojaro$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join Team' })).toBeEnabled();
  });

  test('the student who created it is shown as its member', async ({ page }) => {
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: ASSIGNMENT,
      teams: {},
      brokerIssues: [
        handledAcceptance({ number: 1, login: STUDENT_1.login, slug: 'rojaro', name: 'Rojaro' }),
      ],
    });

    await page.goto(inviteUrl(ORG, ID));
    await expect(page.locator('h2', { hasText: 'Group Assignment: Team Selection' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.member-tag', { hasText: `@${STUDENT_1.login}` })).toBeVisible();
  });

  test('several teams formed in the same minute are all visible', async ({ page }) => {
    // The live shape of the outage: four people, 90 seconds, four teams. A
    // student arriving fifth must see all four rather than a fifth empty list.
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: ASSIGNMENT,
      teams: {},
      brokerIssues: [
        handledAcceptance({ number: 4, login: 'MietWelkenhuyzenPXL', slug: 'felmiroen', name: 'Felmiroen' }),
        handledAcceptance({ number: 3, login: 'd-ries', slug: 'de-docenten', name: 'De Docenten' }),
        handledAcceptance({ number: 2, login: 'WouterSwinnenPXl', slug: 'wim', name: 'Wim' }),
        handledAcceptance({ number: 1, login: STUDENT_1.login, slug: 'rojaro', name: 'Rojaro' }),
      ],
    });

    await page.goto(inviteUrl(ORG, ID));
    await expect(page.locator('h2', { hasText: 'Group Assignment: Team Selection' })).toBeVisible({ timeout: 10000 });

    await expect(page.locator('.team-item-card')).toHaveCount(4);
    for (const name of ['Felmiroen', 'De Docenten', 'Wim', 'Rojaro']) {
      await expect(page.locator('.team-name', { hasText: new RegExp(`^${name}$`) })).toBeVisible();
    }
  });

  test('a body claiming somebody else does not put them in a team on screen', async ({ page }) => {
    // Any GitHub account can open an issue on a public broker. The member is
    // the issue's AUTHOR; a `github_login` in the body is not evidence of
    // anything. The list is display only - the hub decides membership - but a
    // student picks a team from what this screen says.
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: ASSIGNMENT,
      teams: {},
      brokerIssues: [{
        number: 1,
        title: 'Acceptance (processed)',
        user: { login: 'passer-by' },
        created_at: new Date().toISOString(),
        body: JSON.stringify({ team_slug: 'rojaro', team_name: 'Rojaro', github_login: STUDENT_1.login }),
      }],
    });

    await page.goto(inviteUrl(ORG, ID));
    await expect(page.locator('h2', { hasText: 'Group Assignment: Team Selection' })).toBeVisible({ timeout: 10000 });

    await expect(page.locator('.team-name', { hasText: /^Rojaro$/ })).toBeVisible();
    await expect(page.locator('.member-tag', { hasText: '@passer-by' })).toBeVisible();
    await expect(page.locator('.member-tag', { hasText: `@${STUDENT_1.login}` })).toHaveCount(0);
  });

  test('an individual acceptance on the broker adds no team', async ({ page }) => {
    // Not every issue names a team. A body with no `team_slug` must contribute
    // nothing rather than a team named after something else.
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: ASSIGNMENT,
      teams: {},
      brokerIssues: [{
        number: 1,
        title: 'Acceptance (processed)',
        user: { login: STUDENT_1.login },
        created_at: new Date().toISOString(),
        body: JSON.stringify({ claim: 'sealed' }),
      }],
    });

    await page.goto(inviteUrl(ORG, ID));
    await expect(page.locator('h2', { hasText: 'Group Assignment: Team Selection' })).toBeVisible({ timeout: 10000 });

    await expect(page.locator('.team-item-card')).toHaveCount(0);
  });
});
