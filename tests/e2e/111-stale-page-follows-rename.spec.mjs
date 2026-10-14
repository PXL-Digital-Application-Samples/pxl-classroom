// 111 - A team page opened before the lecturer renamed the team.
//
// Review 2026-10-14: the page sent the team's OLD slug; the hub took it as the
// renamed team for its member (acceptance/accept.mjs, `renamed_from`) and made
// the repository under the NEW name - while the page waited for the old one and
// ended on "tell your lecturer". It reads the teams again when the wait would
// end, and follows the rename the published file now carries.
import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';
import { INVITED_LABEL } from '../../lib/acceptance-labels.mjs';

const ID = 'grp-renamed';
const OLD = `${ID}-team-alpha`;
const NEW = `${ID}-team-beta`;
// A stale page's attempt, under the team's old slug. A title of the form
// `pxl-accept:token team:team-alpha` parses to no team at all, which is how
// these tests once passed without ever reaching the code they were about (TS-12).
const ALPHA_BODY = JSON.stringify({ team_slug: 'team-alpha', team_name: 'Team Alpha' });

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
      // As the page sends it: the team in the body (lib/team-payload.mjs).
      number: 1, title: 'pxl-accept:token', body: ALPHA_BODY, user: { login: STUDENT_1.login },
      created_at: new Date().toISOString(), labels: [{ name: INVITED_LABEL }],
    }]),
  }));
  // Never "tell your lecturer" on the way: watched for the whole wait, since
  // the timeout and the ready state are one v-if chain, and asked only at the
  // end it could never be anything but absent (TS-12).
  await page.evaluate(() => {
    window.__sawTimeout = false;
    new MutationObserver(() => {
      if (document.querySelector('.timeout-state')) window.__sawTimeout = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await join.click();

  await expect(page.getByRole('heading', { name: 'Your team repository is ready!' })).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.team-badge-banner')).toContainText('team-beta');
  expect(asked).toContain(NEW);
  expect(await page.evaluate(() => window.__sawTimeout), 'the timeout state was shown on the way').toBe(false);
});

test('TS-12: an attempt under the old slug made AFTER the rebuilt file lists its student in the renamed team, not a phantom one', async ({ page }) => {
  // The case `attemptTeamSlug` exists for. Above, the published file is newer
  // than the attempt and wins (attemptYields), and the wait follows the rename
  // by itself, so the attempt's slug never decides anything; here the rename
  // was published first and a page loaded before it sent the old slug
  // afterwards. Read literally, that attempt put its student in a team-alpha
  // nobody has, and every other student choosing a team saw it on the list -
  // and the renamed team, emptied, beside it.
  const before = { team_slug: 'team-alpha', team_name: 'Team Alpha', members: [STUDENT_1.login], member_count: 1, max_members: 3, is_full: false };
  const after = { ...before, team_slug: 'team-beta', team_name: 'Team Beta', renamed_from: ['team-alpha'] };
  await injectAuth(page, STUDENT_2);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_2,
    assignments: {
      [ID]: {
        id: ID, title: 'Renamed Team Lab', organization: ORG, state: 'published', assignment_type: 'group',
        group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
        repository_name_pattern: `${ID}-{team_slug}`, broker_repo: `broker-${ID}`,
        opens_at: new Date(Date.now() - 3600_000).toISOString(),
        deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      },
    },
    teams: { [ID]: [before] },
    brokerIssueLabels: [INVITED_LABEL],
  });
  const asked = [];
  await page.route(`**/api.github.com/repos/${ORG}/${OLD}`, (route) => { asked.push(OLD); return route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }); });
  await page.route(`**/api.github.com/repos/${ORG}/${NEW}`, (route) => {
    asked.push(NEW);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: NEW, full_name: `${ORG}/${NEW}`, html_url: `https://github.com/${ORG}/${NEW}` }) });
  });
  await page.route('**/api.github.com/user/repository_invitations*', (route) => route.fulfill({ status: 200, body: JSON.stringify([]) }));

  const attemptAt = Date.now();
  // Rebuilt a minute before the attempt, rename and all.
  await page.route('**/data/*/i/*.teams.json*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ schema_version: 1, assignment_id: ID, generated_at: new Date(attemptAt - 60_000).toISOString(), teams: [after] }),
  }));
  await page.route(`**/repos/${ORG}/broker-${ID}/issues?**`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{
      // As the page sends it: the team in the body (lib/team-payload.mjs).
      number: 1, title: 'pxl-accept:token', body: ALPHA_BODY, user: { login: STUDENT_1.login },
      created_at: new Date(attemptAt).toISOString(), labels: [{ name: INVITED_LABEL }],
    }]),
  }));
  await page.goto(inviteUrl(ORG, ID));
  const beta = page.locator('.team-item-card', { hasText: 'Team Beta' });
  await expect(beta).toBeVisible({ timeout: 15000 });
  await expect(beta).toContainText(`@${STUDENT_1.login}`);
  await expect(beta).toContainText('1/3 members');
  await expect(page.locator('.team-item-card')).toHaveCount(1);
  await expect(page.locator('.team-slug-badge', { hasText: /^team-alpha$/ })).toHaveCount(0);
});

test('P2-14: when the hub answers before the rebuilt teams file is live, the page keeps following until it is', async ({ page }) => {
  // Review 2026-10-14: followed once, at the hub's answer. The site rebuilds a
  // minute or two after a rename and the hub answers in about one, so the page
  // read the old file, found no rename, and settled on the old repository.
  const before = { team_slug: 'team-alpha', team_name: 'Team Alpha', members: [STUDENT_1.login], member_count: 1, max_members: 3, is_full: false };
  const after = { ...before, team_slug: 'team-beta', team_name: 'Team Beta', renamed_from: ['team-alpha'] };
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
    teams: { [ID]: [before] },
    brokerIssueLabels: [INVITED_LABEL],
  });
  await page.route(`**/api.github.com/repos/${ORG}/${OLD}`, (route) => route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
  await page.route(`**/api.github.com/repos/${ORG}/${NEW}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ name: NEW, full_name: `${ORG}/${NEW}`, html_url: `https://github.com/${ORG}/${NEW}` }),
  }));
  await page.route('**/api.github.com/user/repository_invitations*', (route) => route.fulfill({ status: 200, body: JSON.stringify([]) }));

  await page.goto(inviteUrl(ORG, ID));
  const join = page.getByRole('button', { name: /Accept & Join Team/i });
  await expect(join).toBeVisible({ timeout: 15000 });

  // After the click: the old file, made before the attempt, for the next few
  // reads - then the rebuilt one.
  let reads = 0;
  const clickedAt = Date.now();
  await page.route('**/data/*/i/*.teams.json*', (route) => {
    reads++;
    const rebuilt = reads > 3;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        schema_version: 1, assignment_id: ID,
        generated_at: new Date(rebuilt ? Date.now() : clickedAt - 600_000).toISOString(),
        teams: [rebuilt ? after : before],
      }),
    });
  });
  await page.route(`**/repos/${ORG}/broker-${ID}/issues?**`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{
      // As the page sends it: the team in the body (lib/team-payload.mjs).
      number: 1, title: 'pxl-accept:token', body: ALPHA_BODY, user: { login: STUDENT_1.login },
      created_at: new Date(clickedAt).toISOString(), labels: [{ name: INVITED_LABEL }],
    }]),
  }));
  await join.click();

  await expect(page.getByRole('heading', { name: 'Your team repository is ready!' })).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.team-badge-banner')).toContainText('team-beta');
  expect(reads, 'it read the file again after the first answer').toBeGreaterThan(3);
});
