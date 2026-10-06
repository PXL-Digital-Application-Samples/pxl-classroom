// 102 - Team join codes (group_config.require_join_code), on the student's page.
//
// Self-service teams were first come, first served: anyone holding the link
// could join any team with room. A team a student makes now gets a code, made
// in their browser and shown to them at once, and joining it needs that code.
// What the browser sends is opened here with the hub's own reader and the
// suite's private key, so these specs prove the page and the hub agree - not
// only that a field appeared.

import { test, expect } from '@playwright/test';
import {
  ORG, STUDENT_1, STUDENT_2, E2E_CLAIM_KEYPAIR, injectAuth, setupStandardMockRoutes, inviteUrl, inviteToken,
} from '../fixtures/e2e-fixtures.mjs';
import { parseTeamPayload } from '../../lib/team-payload.mjs';
import { decryptTeamCodeWithAnyKey } from '../../lib/claim.mjs';
import { formatJoinCode, isWellFormedJoinCode, newJoinCode } from '../../lib/team-join-code.mjs';
import { JOIN_CODES_KEY } from '../../frontend/src/lib/team-code-memory.js';
import { REJECTED_LABEL } from '../../lib/acceptance-labels.mjs';

const ID = 'team-codes';
const CODE = newJoinCode();

const assignment = (groupConfig = {}) => ({
  id: ID,
  title: 'Team Codes Lab',
  organization: ORG,
  state: 'published',
  assignment_type: 'group',
  group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true, require_join_code: true, ...groupConfig },
  repository_name_pattern: `${ID}-{team_slug}`,
  broker_repo: `broker-${ID}`,
  invite_key: inviteToken(ORG, ID),
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
});

const published = (slug, members, more = {}) => ({
  team_slug: slug, team_name: slug[0].toUpperCase() + slug.slice(1), members, member_count: members.length,
  max_members: 3, is_full: members.length >= 3, ...more,
});

/** Where team-code-memory.js keeps a code: per account, org, assignment and team. */
const storedKey = (user, slug) => `${user.login.toLowerCase()}/${ORG.toLowerCase()}/${ID}/${slug}`;

async function open(page, { user = STUDENT_2, groupConfig = {}, teams = [], teamsFile = {}, userRepos = [], labels = [], storedCodes = null } = {}) {
  const bodies = [];
  if (storedCodes) {
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [JOIN_CODES_KEY, JSON.stringify(storedCodes)]);
  }
  await injectAuth(page, user);
  await setupStandardMockRoutes(page, {
    currentUser: user,
    assignments: { [ID]: assignment(groupConfig) },
    teams: { [ID]: teams },
    teamsFile: { [ID]: teamsFile },
    userRepos,
    brokerIssueLabels: labels,
    acceptanceBodies: bodies,
  });
  await page.goto(inviteUrl(ORG, ID));
  await expect(page.locator('h2', { hasText: 'Group Assignment: Team Selection' }).or(page.locator('.provisioned-state'))).toBeVisible({ timeout: 15000 });
  return bodies;
}

/** What the hub reads out of the body the page posted. */
async function openBody(body, user) {
  const team = parseTeamPayload({ body });
  if (!team.team_code_payload) return { team, code: null };
  const opened = await decryptTeamCodeWithAnyKey({ privateKeys: [E2E_CLAIM_KEYPAIR.privateKey], payload: team.team_code_payload });
  expect(opened.githubId).toBe(user.id);
  expect(opened.assignmentId).toBe(ID);
  expect(opened.teamSlug).toBe(team.team_slug);
  return { team, code: opened.code };
}

const card = (page, name) => page.locator('.team-item-card', { hasText: name });

test.describe('102 - team join codes', () => {
  test('creating a team: the page makes a code, sends it sealed, and shows it at once', async ({ page }) => {
    const bodies = await open(page, { user: STUDENT_1 });
    await page.locator('.tab-pill', { hasText: '+ Create New Team' }).click();
    await expect(page.locator('[data-create-code-hint]')).toContainText('Your team gets a join code');
    await page.locator('#new-team-name').fill('Gamma');
    await page.getByRole('button', { name: 'Create & Join Team' }).click();

    await expect(page.locator('.pending-state')).toBeVisible();
    await expect.poll(() => bodies.length).toBe(1);
    const { team, code } = await openBody(bodies[0], STUDENT_1);
    expect(team.team_action).toBe('create');
    expect(isWellFormedJoinCode(code)).toBe(true);
    expect(bodies[0], 'never the code itself on a public issue').not.toContain(code);
    expect(bodies[0]).not.toContain(formatJoinCode(code));

    // The creator can hand it out while the repository is still being made.
    const panel = page.locator('.pending-state [data-join-code-panel]');
    await expect(panel.locator('[data-join-code]')).toHaveText(formatJoinCode(code));
    await expect(panel).toContainText('They need it to join Gamma');
  });

  test('joining a team with a code: asked in the card, a typo caught before anything is sent', async ({ page }) => {
    const bodies = await open(page, { teams: [published('alpha', [STUDENT_1.login], { needs_code: true })] });
    const alpha = card(page, 'Alpha');
    await expect(alpha.locator('.team-needs-code')).toHaveText(/Needs a join code from someone in it/);
    await alpha.getByRole('button', { name: 'Join Team' }).click();

    const input = alpha.locator('[data-join-code-input]');
    await expect(input).toBeFocused();
    const join = alpha.getByRole('button', { name: 'Join', exact: true });
    await expect(join).toBeDisabled();

    // One character wrong: refused here, said in words, nothing posted.
    const typo = CODE.slice(0, 2) + (CODE[2] === 'A' ? 'B' : 'A') + CODE.slice(3);
    await input.fill(typo);
    await expect(alpha.locator('.field-error-msg')).toHaveText(/This code has a mistake in it/);
    await expect(join).toBeDisabled();
    await input.press('Enter');
    expect(bodies).toHaveLength(0);

    // Lower case, no dash: read as meant.
    await input.fill(CODE.toLowerCase());
    await expect(alpha.locator('.field-error-msg')).toHaveCount(0);
    await expect(join).toBeEnabled();
    await join.click();

    await expect.poll(() => bodies.length).toBe(1);
    const { team, code } = await openBody(bodies[0], STUDENT_2);
    expect(team).toMatchObject({ team_slug: 'alpha', team_action: 'join' });
    expect(code).toBe(CODE);

    // A typed code is a guess until the hub lets them in: not kept, and not
    // shown back as "the team's code" while it waits.
    await expect(page.locator('.pending-state')).toBeVisible();
    await expect(page.locator('[data-join-code-panel]')).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), JOIN_CODES_KEY) || '').not.toContain(CODE);
  });

  test('the code field closes with Escape or Cancel and sends nothing', async ({ page }) => {
    const bodies = await open(page, { teams: [published('alpha', [STUDENT_1.login], { needs_code: true })] });
    const alpha = card(page, 'Alpha');
    await alpha.getByRole('button', { name: 'Join Team' }).click();
    await alpha.locator('[data-join-code-input]').press('Escape');
    await expect(alpha.locator('[data-join-code-input]')).toHaveCount(0);
    await alpha.getByRole('button', { name: 'Join Team' }).click();
    await alpha.getByRole('button', { name: 'Cancel' }).click();
    await expect(alpha.locator('[data-join-code-input]')).toHaveCount(0);
    expect(bodies).toHaveLength(0);
  });

  test('a team with no code - made before the setting, or the lecturer\'s - is joined in one click', async ({ page }) => {
    const bodies = await open(page, { teams: [published('alpha', [STUDENT_1.login])] });
    const alpha = card(page, 'Alpha');
    await expect(alpha.locator('.team-needs-code')).toHaveCount(0);
    await alpha.getByRole('button', { name: 'Join Team' }).click();
    await expect.poll(() => bodies.length).toBe(1);
    const { team, code } = await openBody(bodies[0], STUDENT_2);
    expect(team.team_action).toBe('join');
    expect(code).toBeNull();
  });

  test('a full team asks for no code: there is nothing to join', async ({ page }) => {
    await open(page, { teams: [published('alpha', ['a', 'b', 'c'], { needs_code: true })] });
    const alpha = card(page, 'Alpha');
    await expect(alpha.locator('.team-needs-code')).toHaveCount(0);
    await expect(alpha.getByRole('button', { name: 'Full' })).toBeDisabled();
  });

  test('a team someone is making right now, known only from its request, needs a code', async ({ page }) => {
    // Not yet in the published file: the broker's issues are all the page has.
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_2,
      assignments: { [ID]: assignment() },
      teams: { [ID]: [] },
      brokerIssues: [{
        number: 7, title: 'pxl-accept:redacted', user: { login: STUDENT_1.login }, created_at: new Date().toISOString(),
        body: JSON.stringify({ team_slug: 'delta', team_name: 'Delta', team_action: 'create', team_code: 't1.a.b.c' }),
      }],
    });
    await page.goto(inviteUrl(ORG, ID));
    await expect(card(page, 'Delta').locator('.team-needs-code')).toBeVisible({ timeout: 15000 });
  });

  test('with codes off there is no code anywhere: not on create, not in the body', async ({ page }) => {
    const bodies = await open(page, { user: STUDENT_1, groupConfig: { require_join_code: undefined } });
    await page.locator('.tab-pill', { hasText: '+ Create New Team' }).click();
    await expect(page.locator('[data-create-code-hint]')).toHaveCount(0);
    await page.locator('#new-team-name').fill('Gamma');
    await page.getByRole('button', { name: 'Create & Join Team' }).click();
    await expect.poll(() => bodies.length).toBe(1);
    expect((await openBody(bodies[0], STUDENT_1)).code).toBeNull();
    await expect(page.locator('[data-join-code-panel]')).toHaveCount(0);
  });

  test('a refused join that carried a typed code says what to check, and forgets the code', async ({ page }) => {
    const bodies = await open(page, {
      teams: [published('alpha', [STUDENT_1.login], { needs_code: true })],
      labels: [REJECTED_LABEL],
    });
    const alpha = card(page, 'Alpha');
    await alpha.getByRole('button', { name: 'Join Team' }).click();
    await alpha.locator('[data-join-code-input]').fill(formatJoinCode(CODE));
    await alpha.getByRole('button', { name: 'Join', exact: true }).click();
    await expect.poll(() => bodies.length).toBe(1);
    await expect(page.locator('[data-code-refused-hint]')).toContainText('check it is this team\'s', { timeout: 20000 });
    const stored = await page.evaluate((key) => localStorage.getItem(key), JOIN_CODES_KEY);
    expect(stored || '').not.toContain(CODE);
  });

  test('the team\'s page shows its code to whoever has it, with Copy, and says where to get it otherwise', async ({ page }) => {
    const repo = { name: `${ID}-alpha`, full_name: `${ORG}/${ID}-alpha`, owner: { login: ORG }, html_url: `https://github.com/${ORG}/${ID}-alpha` };
    await open(page, {
      user: STUDENT_1,
      teams: [published('alpha', [STUDENT_1.login, STUDENT_2.login], { needs_code: true })],
      userRepos: [repo],
      storedCodes: { [storedKey(STUDENT_1, 'alpha')]: CODE },
    });
    const panel = page.locator('.provisioned-state [data-join-code-panel]');
    await expect(panel.locator('[data-join-code]')).toHaveText(formatJoinCode(CODE), { timeout: 15000 });
    await panel.getByRole('button', { name: 'Copy join code' }).click();
    await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
  });

  test('a member whose browser does not have the code is told who does', async ({ page }) => {
    const repo = { name: `${ID}-alpha`, full_name: `${ORG}/${ID}-alpha`, owner: { login: ORG }, html_url: `https://github.com/${ORG}/${ID}-alpha` };
    await open(page, {
      user: STUDENT_2,
      teams: [published('alpha', [STUDENT_1.login, STUDENT_2.login], { needs_code: true })],
      userRepos: [repo],
    });
    await expect(page.locator('.provisioned-state [data-join-code-elsewhere]')).toHaveText(
      // True for every member - the creator on another computer included,
      // whom "ask whoever made the team" sent to ask themselves.
      'New teammates need this team\'s join code. Your lecturer can see it.',
      { timeout: 15000 },
    );
    await expect(page.locator('[data-join-code-panel]')).toHaveCount(0);
  });

  test('one solid button on the page, code field open or not', async ({ page }) => {
    await open(page, { teams: [published('alpha', [STUDENT_1.login], { needs_code: true })] });
    await card(page, 'Alpha').getByRole('button', { name: 'Join Team' }).click();
    await expect(page.locator('.btn-primary:visible')).toHaveCount(0);
  });

  test('the name of a team everybody left, which keeps its repository, is taken - unless this browser was in it', async ({ page }) => {
    // Review, 2026-10-06: entering that team hands over its repository with
    // the former members' work in it, so the hub opens it only to its code.
    const taken = { generated_at: new Date().toISOString(), taken: [{ team_slug: 'alpha', team_name: 'Alpha' }] };
    await open(page, { user: STUDENT_1, teamsFile: taken });
    await page.locator('.tab-pill', { hasText: '+ Create New Team' }).click();
    await page.locator('#new-team-name').fill('Alpha');
    await expect(page.locator('[data-slug-taken]')).toHaveText('A team called alpha exists. Pick another name.');
    await expect(page.getByRole('button', { name: 'Create & Join Team' })).toBeDisabled();
  });

  test('a former member whose browser kept the code goes back in by its name, with that code', async ({ page }) => {
    const taken = { generated_at: new Date().toISOString(), taken: [{ team_slug: 'alpha', team_name: 'Alpha' }] };
    const bodies = await open(page, { user: STUDENT_1, teamsFile: taken, storedCodes: { [storedKey(STUDENT_1, 'alpha')]: CODE } });
    await page.locator('.tab-pill', { hasText: '+ Create New Team' }).click();
    await page.locator('#new-team-name').fill('Alpha');
    await expect(page.locator('[data-slug-taken]')).toHaveCount(0);
    await expect(page.locator('[data-rejoin-hint]')).toHaveText('You were in this team: this takes you back in, with its join code.');
    await page.getByRole('button', { name: 'Create & Join Team' }).click();
    await expect.poll(() => bodies.length).toBe(1);
    const { code } = await openBody(bodies[0], STUDENT_1);
    expect(code, 'the code it kept, not a new one').toBe(CODE);
  });

  test('a code kept by one account is not shown to the next one on the same computer', async ({ page }) => {
    const repo = { name: `${ID}-alpha`, full_name: `${ORG}/${ID}-alpha`, owner: { login: ORG }, html_url: `https://github.com/${ORG}/${ID}-alpha` };
    await open(page, {
      user: STUDENT_2,
      teams: [published('alpha', [STUDENT_1.login, STUDENT_2.login], { needs_code: true })],
      userRepos: [repo],
      storedCodes: { [storedKey(STUDENT_1, 'alpha')]: CODE },
    });
    await expect(page.locator('.provisioned-state [data-join-code-elsewhere]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-join-code]')).toHaveCount(0);
  });

  test('a team list it could not read in full says so, rather than presenting a guess as the list', async ({ page }) => {
    await injectAuth(page, STUDENT_2);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_2, assignments: { [ID]: assignment() }, teams: { [ID]: [] } });
    await page.route('**/data/**/i/*.teams.json*', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
    await page.goto(inviteUrl(ORG, ID));
    await expect(page.locator('[data-teams-partial]')).toContainText('could not be loaded', { timeout: 15000 });
  });
});
