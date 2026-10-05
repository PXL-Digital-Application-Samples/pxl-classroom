// The Teams tab says what is true, and asks before it changes anything.
//
// Ten findings from a live run on the testbed (2026-10-04), each pinned here
// at the point a lecturer meets it: the table followed a report that lagged
// the team files by a minute; a move promised access to a repository that did
// not exist; students with no GitHub username were invisible; a username that
// is no account read as a permission failure; every dialog scrolled whole, so
// its buttons left the screen. lib halves: tests/team-rows.test.mjs,
// tests/team-edit.test.mjs, tests/team-candidates.test.mjs.

import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  answerConfirm,
  inviteToken,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'teams-truth';
const repo = (slug) => ({
  repo_name: `${ORG}/${ID}-${slug}`,
  repo_url: `https://github.com/${ORG}/${ID}-${slug}`,
});

function assignment(over = {}) {
  return {
    schema_version: 1,
    id: ID,
    title: 'Network Lab Teams',
    organization: ORG,
    assignment_type: 'group',
    roster_mode: 'enforced',
    state: 'published',
    template: { owner: ORG, repository: 'group-template' },
    repository_name_pattern: `${ID}-{team_slug}`,
    opens_at: '2026-08-01T08:00:00.000Z',
    deadline_at: '2026-12-31T22:00:00.000Z',
    group_config: { max_team_size: 3, min_team_size: 2, allow_team_creation: true },
    ...over,
  };
}

function teamFile(slug, name, members, extra = {}) {
  return {
    schema_version: 1,
    assignment_id: ID,
    team_slug: slug,
    team_name: name,
    members,
    max_members: 3,
    created_at: '2026-08-01T09:00:00.000Z',
    created_by: 'lecturer',
    ...extra,
  };
}

const accepted = (login, slug) => ({
  github_login: login,
  team_slug: slug,
  acceptance_state: 'provisioned',
  repo_url: repo(slug).repo_url,
  submission_status: 'on-time',
});

function report(teams, students) {
  return { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), teams, students };
}

async function openTeams(page, opts) {
  const gitCommits = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, gitCommits, ...opts });
  await page.goto(`/dashboard/${ORG}/${ID}?tab=teams`);
  return gitCommits;
}

async function openManage(page, teamName) {
  await page.locator('tr', { hasText: teamName }).getByRole('button', { name: 'Manage' }).click();
  const modal = page.locator('.modal.card', { hasText: `Manage ${teamName}` });
  await expect(modal).toBeVisible();
  return modal;
}

test.describe('96 - The Teams tab says what is true', () => {
  test('the table shows the team files, not a report that has not caught up', async ({ page }) => {
    // The report still has stud2 in Alpha and a team Echo whose file was
    // deleted a moment ago. The files are what is true now.
    await openTeams(page, {
      assignments: { [ID]: assignment() },
      reports: {
        [ID]: report(
          [
            { team_slug: 'alpha', team_name: 'Alpha', members: ['stud1', 'stud2'], ...repo('alpha'), commit_count: 4, submission_status: 'on-time' },
            { team_slug: 'echo', team_name: 'Echo', members: [], submission_status: 'no-submission' },
          ],
          [accepted('stud1', 'alpha'), accepted('stud2', 'alpha')],
        ),
      },
      controlTeams: { [ID]: [teamFile('alpha', 'Alpha', ['stud1'], { ...repo('alpha'), repo_id: 4001 })] },
    });

    const alpha = page.locator('tr', { hasText: 'Alpha' });
    await expect(alpha).toContainText('@stud1');
    await expect(alpha).not.toContainText('@stud2');
    await expect(alpha).toContainText('4', { useInnerText: true }); // commits still come from the report
    await expect(page.locator('tr', { hasText: 'Echo' })).toHaveCount(0);
    // One member under a minimum of two: amber, not grey.
    await expect(alpha.locator('.status-dot.dot-warning').first()).toBeVisible();
  });

  test('a move into a team with no repository says they must accept again, and Cancel writes nothing', async ({ page }) => {
    const gitCommits = await openTeams(page, {
      assignments: { [ID]: assignment() },
      reports: { [ID]: report([], [accepted('stud1', 'alpha'), accepted('stud2', 'alpha')]) },
      controlTeams: {
        [ID]: [
          teamFile('alpha', 'Alpha', ['stud1', 'stud2'], { ...repo('alpha'), repo_id: 4001 }),
          teamFile('delta', 'Delta', ['stud4']),
        ],
      },
    });

    const modal = await openManage(page, 'Alpha');
    await modal.locator('.member-manage-row', { hasText: 'stud2' }).locator('select').selectOption('delta');

    const ask = page.locator('.confirm-dialog');
    await expect(ask).toContainText('Move @stud2 to Delta?');
    await expect(ask).toContainText(`@stud2 loses access to ${ID}-alpha now.`);
    await expect(ask).toContainText('Delta has no repository yet, so @stud2 has no team repository until they open the invitation link and accept again.');
    await expect(ask).not.toContainText('granted access');
    // Someone loses access: the harmless answer has the focus, and the action
    // button names itself.
    await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(ask.getByRole('button', { name: 'Move @stud2' })).toHaveClass(/btn-danger/);

    await answerConfirm(page, { accept: false });
    await page.waitForTimeout(500);
    expect(gitCommits).toHaveLength(0);
    await expect(modal.locator('.member-manage-row', { hasText: 'stud2' })).toBeVisible();
  });

  test('Manage says where each member stands, and a username stays on one line', async ({ page }) => {
    await openTeams(page, {
      assignments: { [ID]: assignment() },
      reports: {
        [ID]: report([], [
          accepted('stud1', 'alpha'),
          { github_login: 'stud-with-a-long-name', team_slug: 'alpha', acceptance_state: 'not-accepted' },
        ]),
      },
      controlTeams: { [ID]: [teamFile('alpha', 'Alpha', ['stud1', 'stud-with-a-long-name'], { ...repo('alpha'), repo_id: 4001 })] },
    });

    const modal = await openManage(page, 'Alpha');
    await expect(modal.locator('.member-manage-row', { hasText: 'stud1' }).locator('[data-member-status]')).toHaveText('has the team repository');
    const pending = modal.locator('.member-manage-row', { hasText: 'stud-with-a-long-name' });
    await expect(pending.locator('[data-member-status]')).toHaveText('has not accepted yet');
    const login = pending.locator('.member-login');
    expect(await login.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap');

    // Remove is plain now: nothing happens until Save.
    await expect(pending.getByRole('button', { name: 'Remove' })).toHaveClass(/btn-secondary/);
  });

  test('a student with no GitHub username is named, greyed, and the confirm-email link is beside it', async ({ page }) => {
    await openTeams(page, {
      assignments: { [ID]: assignment({ roster_mode: 'claim', invite_key: inviteToken(ORG, ID) }) },
      reports: { [ID]: report([], []) },
      controlTeams: { [ID]: [teamFile('alpha', 'Alpha', ['stud1'])] },
      roster: [
        { student_number: '1', full_name: 'Stu One', github_login: 'stud1' },
        { student_number: '2', full_name: 'Nina Nieuw', email: 'nina@student.pxl.be' },
      ],
    });

    const note = page.locator('[data-note="waiting"]');
    await expect(note).toContainText("1 student can't be placed yet: no GitHub username.");
    await expect(note).toContainText('Send them the confirm-email link; they appear here once they confirm.');
    await expect(note.getByRole('button', { name: 'Copy confirm-email link' })).toBeVisible();

    await page.getByRole('button', { name: 'Create Team' }).click();
    const waiting = page.locator('.student-check-item.student-waiting', { hasText: 'Nina Nieuw' });
    await expect(waiting).toContainText('no GitHub username yet');
    await expect(waiting.locator('input[type="checkbox"]')).toBeDisabled();
  });

  test('once they confirm their address, they can be placed', async ({ page }) => {
    await openTeams(page, {
      assignments: { [ID]: assignment({ roster_mode: 'claim', invite_key: inviteToken(ORG, ID) }) },
      reports: { [ID]: report([], []) },
      controlTeams: { [ID]: [teamFile('alpha', 'Alpha', ['stud1'])] },
      roster: [
        { student_number: '1', full_name: 'Stu One', github_login: 'stud1' },
        { student_number: '2', full_name: 'Nina Nieuw', email: 'nina@student.pxl.be' },
      ],
      claims: [{
        schema_version: 1, github_login: 'nina-gh', github_id: 222, email: 'nina@student.pxl.be',
        claim_verified: true, student_number: null, claimed_at: '2026-09-01T10:00:00.000Z', claimed_via: ID,
      }],
    });

    await page.getByRole('button', { name: 'Create Team' }).click();
    await expect(page.locator('.student-check-item', { hasText: '@nina-gh' }).locator('input')).toBeEnabled();
    await expect(page.locator('.student-check-item.student-waiting')).toHaveCount(0);
    await expect(page.locator('[data-note="waiting"]')).toHaveCount(0);
  });

  test('on a draft the note says the link does not exist yet', async ({ page }) => {
    await openTeams(page, {
      assignments: { [ID]: assignment({ roster_mode: 'claim', state: 'draft' }) },
      reports: { [ID]: report([], []) },
      controlTeams: { [ID]: [] },
      roster: [{ student_number: '2', full_name: 'Nina Nieuw', email: 'nina@student.pxl.be' }],
    });
    const note = page.locator('[data-note="waiting"]');
    await expect(note).toContainText('Their confirm-email link exists once the assignment is published.');
    await expect(note.getByRole('button')).toHaveCount(0);
  });

  test('removing a username that is no GitHub account is a note, not a failure', async ({ page }) => {
    await openTeams(page, {
      assignments: { [ID]: assignment() },
      reports: { [ID]: report([], [accepted('stud1', 'alpha')]) },
      controlTeams: { [ID]: [teamFile('alpha', 'Alpha', ['stud1', 'ghost-typo'], { ...repo('alpha'), repo_id: 4001 })] },
      notAccounts: ['ghost-typo'],
    });

    const modal = await openManage(page, 'Alpha');
    await modal.locator('.member-manage-row', { hasText: 'ghost-typo' }).getByRole('button', { name: 'Remove' }).click();
    await modal.getByRole('button', { name: /Save Changes/ }).click();

    await expect(page.locator('.toast-success')).toContainText('@ghost-typo is not a GitHub account, so there was no access to remove.');
    await expect(page.locator('.toast-error')).toHaveCount(0);
  });

  test('a dialog keeps its title and buttons on screen; only the body scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    const roster = Array.from({ length: 30 }, (_, i) => ({
      student_number: String(100 + i), full_name: `Student ${i}`, github_login: `stu${i}`,
    }));
    await openTeams(page, {
      assignments: { [ID]: assignment() },
      reports: { [ID]: report([], []) },
      controlTeams: { [ID]: [teamFile('alpha', 'Alpha', ['stu0'])] },
      roster,
    });

    await page.getByRole('button', { name: 'Create Team' }).click();
    const modal = page.locator('.modal.card', { hasText: 'Create a team in Network Lab Teams' });
    await expect(modal).toBeVisible();

    const create = modal.locator('.modal-foot').getByRole('button', { name: 'Create Team' });
    await expect(create).toBeInViewport({ ratio: 1 });
    await expect(modal.locator('.modal-head h3')).toBeInViewport({ ratio: 1 });
    const { body, whole } = await modal.evaluate((el) => {
      const b = el.querySelector('.modal-body');
      return {
        body: { scroll: b.scrollHeight, client: b.clientHeight },
        whole: { scroll: el.scrollHeight, client: el.clientHeight },
      };
    });
    expect(body.scroll, 'the body is what scrolls').toBeGreaterThan(body.client);
    expect(whole.scroll, 'the dialog itself does not').toBeLessThanOrEqual(whole.client + 1);
  });
});

test.describe('96 - An assignment that is not there', () => {
  test('says so in words a lecturer has, not a file path or "report"', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/no-such-assignment`);
    const card = page.locator('.center-card', { hasText: 'Could not open this assignment' });
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText('This assignment was not found. It may have been deleted or renamed, or you cannot see this course.');
    await expect(card).not.toContainText(/control repo|\.yml|report/i);
  });
});

test.describe('96 - A username is asked about before the roster stores it', () => {
  test('Add student refuses a username that is no GitHub account', async ({ page }) => {
    const contentWrites = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      roster: [{ student_number: '1', full_name: 'Stu One', github_login: 'stud1' }],
      notAccounts: ['no-such-gh'],
      contentWrites,
    });
    await page.goto(`/dashboard/${ORG}/roster`);
    await page.getByRole('button', { name: /Add student/i }).click();
    await page.getByRole('textbox', { name: /Full Name/i }).fill('Nina Nieuw');
    await page.getByRole('textbox', { name: /GitHub Login/i }).fill('no-such-gh');
    await page.locator('.modal').getByRole('button', { name: 'Add Student' }).click();

    await expect(page.locator('.modal')).toContainText('There is no GitHub account named @no-such-gh.');
    await page.waitForTimeout(300);
    expect(contentWrites.filter((w) => w.path === 'students/roster.yml')).toHaveLength(0);
  });

  test('a CSV import flags a username that is no account before the commit', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, notAccounts: ['bob-typo'] });
    await page.goto(`/dashboard/${ORG}/roster`);
    await page.locator('.roster-tab textarea').fill(
      'student_number,full_name,email,class_group,github_login\n' +
        '0123456,Alice Real,alice@student.pxl.be,2TIN,alice-real\n' +
        '0123457,Bob Typo,bob@student.pxl.be,2TIN,bob-typo',
    );
    const flag = page.locator('[data-note="not-accounts"]');
    await expect(flag).toContainText('No GitHub account with this name: @bob-typo.');
    await expect(flag).not.toContainText('alice-real');
    await expect(page.locator('.diff-pane li', { hasText: 'Bob Typo' })).toContainText('no GitHub account with this name');
    // Flagged, not refused: the lecturer decides.
    await expect(page.getByRole('button', { name: 'Commit roster' })).toBeEnabled();
  });
});
