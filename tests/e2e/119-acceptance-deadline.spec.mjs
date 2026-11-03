// 119 - the acceptance deadline (`accepts_until`): the invitation closes before
// the work is due.
//
// An assignment had one date, `deadline_at`, closing acceptance and the work at
// once, and the only earlier close was Stop accepting by hand. `accepts_until`
// is the second date, optional, absent meaning the deadline. Every surface that
// says whether a student can accept asks ONE judge (lib/acceptance-window.mjs),
// and these tests walk the surfaces a person sees: the student's page, the
// team page, the lecturer's header and its menu, the share panel, the editor.

import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  STUDENT_1,
  injectAuth,
  setupStandardMockRoutes,
  inviteUrl,
  inviteToken,
} from '../fixtures/e2e-fixtures.mjs';
import { INVITED_LABEL, REJECTED_LABEL } from '../../lib/acceptance-labels.mjs';

const ID = 'labo-k8s';
const TITLE = 'Kubernetes lab';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Published, opened a week ago, due in a week; the acceptance deadline is the test's. */
function assignment(over = {}) {
  // One clock for both dates, so they are exactly fourteen days apart.
  const now = Date.now();
  return {
    schema_version: 1,
    id: ID,
    title: TITLE,
    organization: ORG,
    template: { owner: ORG, repository: 'starter-template' },
    repository_name_pattern: `${ID}-{github_login}`,
    opens_at: new Date(now - 7 * DAY).toISOString(),
    deadline_at: new Date(now + 7 * DAY).toISOString(),
    state: 'published',
    assignment_type: 'individual',
    roster_mode: 'open',
    max_acceptances: 50,
    invite_key: inviteToken(ORG, ID),
    invite_nonce: '0badc0de',
    broker_repo: `broker-${ID}`,
    ...over,
  };
}

const closedYesterday = (over = {}) => assignment({ accepts_until: new Date(Date.now() - DAY).toISOString(), ...over });
const closesTomorrow = (over = {}) => assignment({ accepts_until: new Date(Date.now() + DAY).toISOString(), ...over });

test.describe('119 - the student side', () => {
  test('past the acceptance deadline the page says so, names the deadline the work is due at, and offers no Accept', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: closedYesterday() }, userRepos: [] });
    await page.goto(inviteUrl(ORG, ID));

    const closed = page.locator('[data-acceptance-closed]');
    await expect(closed).toBeVisible({ timeout: 15000 });
    await expect(closed.locator('h2')).toHaveText('Acceptance closed');
    await expect(closed).toContainText('Nobody new can accept since');
    await expect(closed).toContainText('The work is due');
    await expect(page.locator('button', { hasText: /^Accept assignment$/ })).toHaveCount(0);
    // The header's words for it, from the same judge as the page's branch.
    await expect(page.locator('.assignment-meta')).toContainText('Acceptance closed');
    // Both dates are on the card, so a student can see which one passed.
    await expect(page.locator('[data-accepts-until]')).toContainText('Accept until');
  });

  // A student the hub admitted before, whose invitation lapsed: no repository
  // they can see, no invitation, an old attempt of theirs labelled invited.
  // GitHub's invitations expire after seven days, and an acceptance deadline
  // a week in is what the field is for (review 2026-11-03).
  const earlierAttempt = (labels) => ({
    number: 3, title: 'Acceptance (processed)', state: 'closed', created_at: new Date(Date.now() - 9 * DAY).toISOString(),
    user: { login: STUDENT_1.login, id: 1001 }, labels: labels.map((name) => ({ name })),
  });

  test('past it, a student the hub invited before is offered to send the invitation again, and nobody else is', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1, assignments: { [ID]: closedYesterday() }, userRepos: [], brokerIssues: [earlierAttempt([INVITED_LABEL])],
    });
    await page.goto(inviteUrl(ORG, ID));

    await expect(page.locator('[data-send-again]')).toHaveText('Send your invitation again', { timeout: 15000 });
    await expect(page.locator('[data-acceptance-closed]')).toHaveCount(0);
    const send = page.locator('button', { hasText: 'Send my invitation again' });
    await expect(send).toBeEnabled();
    await expect(page.locator('button', { hasText: /^Accept assignment$/ })).toHaveCount(0);
  });

  test('past it, an earlier attempt the hub refused, or none, is no way back in', async ({ page }) => {
    for (const brokerIssues of [[earlierAttempt([REJECTED_LABEL])], [earlierAttempt([])], []]) {
      await injectAuth(page, STUDENT_1);
      await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: closedYesterday() }, userRepos: [], brokerIssues });
      await page.goto(inviteUrl(ORG, ID));
      await expect(page.locator('[data-acceptance-closed]'), JSON.stringify(brokerIssues)).toBeVisible({ timeout: 15000 });
      await expect(page.locator('[data-send-again]')).toHaveCount(0);
    }
  });

  // An expired invitation: the hub said invited, the student cannot see the
  // repository, nothing is pending. The invited state had no way out of that.
  const invisible = async (page, repo) => {
    await page.route(`**/api.github.com/repos/${ORG}/${repo}`, (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
    await page.route('**/api.github.com/user/repository_invitations*', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify([]) }));
  };

  test('an invited student whose invitation went missing can send it again, until the deadline but not after', async ({ page }) => {
    for (const [a, offered] of [[closedYesterday(), true], [assignment(), true], [assignment({ deadline_at: new Date(Date.now() - HOUR).toISOString() }), false]]) {
      await injectAuth(page, STUDENT_1);
      await setupStandardMockRoutes(page, {
        currentUser: STUDENT_1, assignments: { [ID]: a }, userRepos: [],
        brokerIssues: [{ ...earlierAttempt([INVITED_LABEL]), created_at: new Date().toISOString() }],
        brokerIssueLabels: [INVITED_LABEL],
      });
      await invisible(page, `${ID}-${STUDENT_1.login}`);
      await page.goto(inviteUrl(ORG, ID));
      if (!offered) {
        // Past the deadline the hub refuses, so the page does not offer it.
        await expect(page.locator('h2').first()).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(1500);
        await expect(page.locator('[data-send-again-invited]')).toHaveCount(0);
        continue;
      }
      const again = page.locator('[data-send-again-invited]');
      await expect(again, a.accepts_until ?? 'no acceptance deadline').toBeVisible({ timeout: 20000 });
      await expect(again.getByRole('button', { name: 'Send it again' })).toBeEnabled();
    }
  });

  test('a team member whose invitation went missing can send it again, for the same team', async ({ page }) => {
    const TEAM = 'team-alpha';
    const group = closedYesterday({
      assignment_type: 'group',
      repository_name_pattern: `${ID}-{team_slug}`,
      group_config: { max_team_size: 3, formation_mode: 'self-service', allow_team_creation: true },
    });
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1, assignments: { [ID]: group }, userRepos: [],
      teams: { [ID]: [{ team_slug: TEAM, team_name: 'Team Alpha', members: [STUDENT_1.login], member_count: 1, max_members: 3, is_full: false }] },
      brokerIssues: [{
        number: 7, title: 'pxl-accept:sometoken', body: JSON.stringify({ team_slug: TEAM, team_name: 'Team Alpha' }),
        user: { login: STUDENT_1.login }, created_at: new Date().toISOString(),
      }],
      brokerIssueLabels: [INVITED_LABEL],
    });
    await invisible(page, `${ID}-${TEAM}`);
    const posted = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/repos\/[^/]+\/broker-[^/]+\/issues$/.test(req.url())) posted.push(req.postDataJSON());
    });
    await page.goto(inviteUrl(ORG, ID));
    const again = page.locator('[data-send-again-invited]');
    await expect(again).toBeVisible({ timeout: 30000 });
    await again.getByRole('button', { name: 'Send it again' }).click();
    // The same team, joined again: the hub takes it as the same acceptance.
    await expect.poll(() => posted.length, { timeout: 10000 }).toBe(1);
    const body = JSON.parse(posted[0].body);
    expect(body).toMatchObject({ team_slug: TEAM, team_action: 'join' });
  });

  test('an acceptance deadline nothing reaches is never shown: after the deadline, or unreadable', async ({ page }) => {
    // A hand edit; the editor refuses to save either.
    for (const accepts_until of [new Date(Date.now() + 8 * DAY).toISOString(), 'soon']) {
      await injectAuth(page, STUDENT_1);
      await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: assignment({ accepts_until }) }, userRepos: [] });
      await page.goto(inviteUrl(ORG, ID));
      await expect(page.locator('h2', { hasText: 'Accept assignment' }), accepts_until).toBeVisible({ timeout: 15000 });
      await expect(page.locator('[data-accepts-until]')).toHaveCount(0);
    }
  });

  test('before it, the page accepts and shows until when', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: closesTomorrow() }, userRepos: [] });
    await page.goto(inviteUrl(ORG, ID));

    await expect(page.locator('h2', { hasText: 'Accept assignment' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-acceptance-closed]')).toHaveCount(0);
    await expect(page.locator('.assignment-meta')).toContainText('Accepting');
    await expect(page.locator('[data-accepts-until]')).toBeVisible();
  });

  test('an assignment without one keeps its single window: accepting until the deadline, no Accept until shown', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: assignment() }, userRepos: [] });
    await page.goto(inviteUrl(ORG, ID));

    await expect(page.locator('h2', { hasText: 'Accept assignment' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-accepts-until]')).toHaveCount(0);
  });

  test('the team page closes team creation and joining with it', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {
        [ID]: closedYesterday({
          assignment_type: 'group',
          repository_name_pattern: `${ID}-{team_slug}`,
          group_config: { max_team_size: 3, min_team_size: 2, allow_team_creation: true },
        }),
      },
      userRepos: [],
    });
    await page.goto(inviteUrl(ORG, ID));

    const closed = page.locator('[data-acceptance-closed]');
    await expect(closed).toBeVisible({ timeout: 15000 });
    await expect(closed).toContainText('Nobody new can join or create a team since');
    await expect(page.locator('.team-selection-flow')).toHaveCount(0);
  });
});

test.describe('119 - the lecturer side', () => {
  async function openDetail(page, a) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [a.id]: a }, reports: {} });
    await page.goto(`/dashboard/${ORG}/${a.id}`);
    await expect(page.locator('[data-state-menu]')).toBeVisible({ timeout: 15000 });
  }

  test('the header says Acceptance closed, shows the date beside the deadline, and the share panel agrees', async ({ page }) => {
    await openDetail(page, closedYesterday());
    await expect(page.locator('[data-state-menu]')).toContainText('Acceptance closed');
    await expect(page.locator('[data-accepts-until]')).toContainText('Accept until');
    await expect(page.locator('[data-accepts-until] strong')).toHaveClass(/stat-red/);

    await page.locator('button:has(span:text-is("Invite link"))').click();
    const share = page.locator('.invitation-share').first();
    await expect(share).toContainText('Acceptance closed');
    await expect(share).toContainText('Nobody new can accept since');
    await expect(share).toContainText('Move the acceptance deadline');
  });

  test('before it, the share panel is Live until the acceptance deadline, not the deadline', async ({ page }) => {
    const a = closesTomorrow();
    await openDetail(page, a);
    await expect(page.locator('[data-state-menu]')).toContainText('Accepting');
    await page.locator('button:has(span:text-is("Invite link"))').click();
    const share = page.locator('.invitation-share').first();
    await expect(share).toContainText('Live - students can accept now');
    await expect(share).toContainText('Anyone with this link can accept until');
    // The date named is the acceptance deadline, not the deadline a week out:
    // the header shows both, so the share note must match the first.
    const until = (await page.locator('[data-accepts-until]').textContent()).replace(/^.*·\s*/, '').trim();
    expect(until.length).toBeGreaterThan(0);
    await expect(share).toContainText(`accept until ${until}`);
    void a;
  });

  test('a closed assignment past its acceptance deadline offers Reopen, in what it still does, and moving the date beside it', async ({ page }) => {
    // Reopen still lets students who accepted send their invitation again
    // (second review): offering only "Move" blocked exactly that.
    await openDetail(page, closedYesterday({ state: 'closed' }));
    await page.locator('[data-state-menu]').click();
    const menu = page.locator('.state-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Move the acceptance deadline…');
    await expect(menu.locator('.dropdown-item-title', { hasText: 'Reopen for acceptance' })).toHaveCount(1);
    await expect(menu).toContainText('Students who accepted can send their invitation again');
  });

  test('the header shows no Accept until that nothing reaches', async ({ page }) => {
    await openDetail(page, assignment({ accepts_until: new Date(Date.now() + 8 * DAY).toISOString() }));
    await expect(page.locator('[data-state-menu]')).toContainText('Accepting');
    await expect(page.locator('[data-accepts-until]')).toHaveCount(0);
  });

  test('a closed assignment before its acceptance deadline still offers Reopen', async ({ page }) => {
    await openDetail(page, closesTomorrow({ state: 'closed' }));
    await page.locator('[data-state-menu]').click();
    const menu = page.locator('.state-menu');
    await expect(menu.locator('.dropdown-item-title', { hasText: 'Reopen for acceptance' })).toHaveCount(1);
    await expect(menu).not.toContainText('Move the acceptance deadline');
  });
});

test.describe('119 - the editor', () => {
  async function openEditor(page, a) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [a.id]: a },
      userRepos: [{ name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}` }],
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${a.id}`);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue(a.title, { timeout: 15000 });
  }
  const box = (page) => page.locator('input[data-accepts-until]');
  const local = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  test('the box is empty for an assignment without one, and says what empty means', async ({ page }) => {
    await openEditor(page, assignment());
    await expect(box(page)).toHaveValue('');
    await expect(page.locator('text=Optional. Empty: students can accept until the deadline.')).toBeVisible();
  });

  test('one after the deadline, or before the open date, is refused with a reason on the field', async ({ page }) => {
    const a = assignment();
    await openEditor(page, a);
    await box(page).fill(local(Date.parse(a.deadline_at) + DAY));
    await expect(page.locator('.field-error-msg', { hasText: 'cannot be after the deadline' })).toBeVisible();
    await box(page).fill(local(Date.parse(a.opens_at) - DAY));
    await expect(page.locator('.field-error-msg', { hasText: 'must be after the open date' })).toBeVisible();
    await box(page).fill(local(Date.now() + DAY));
    await expect(page.locator('.field-error-msg', { hasText: /acceptance deadline/ })).toHaveCount(0);
  });

  test('each deadline says how many days after the open date it is', async ({ page }) => {
    await openEditor(page, assignment());
    const spans = page.locator('[data-date-span]');
    // Typed as wall-clock times, the way a lecturer does, a month ahead: the
    // spans are the dates on the boxes, so a summer-time change between the
    // fixture's instants cannot make "14 days" "13 days 23 hours".
    const day = (n) => {
      const d = new Date();
      d.setDate(d.getDate() + 30 + n);
      d.setHours(9, 0, 0, 0);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
    };
    const field = (label) => page.locator('.field', { has: page.locator('label', { hasText: label }) }).locator('input[type="datetime-local"]');
    await field(/^Opens at/).fill(day(0));
    await field(/^Deadline/).fill(day(14));
    await expect(spans).toHaveCount(1);
    await expect(spans.first()).toHaveText('14 days after it opens');
    await box(page).fill(day(8));
    await expect(spans).toHaveCount(2);
    await expect(spans.first()).toHaveText('8 days after it opens');
    await expect(spans.last()).toHaveText('14 days after it opens, 6 days after acceptance closes');
    // A schedule that is wrong shows no span under the box that is wrong.
    await box(page).fill(day(-1));
    await expect(spans).toHaveCount(1);
  });

  test('one in the past warns that nobody new can accept, without blocking the save', async ({ page }) => {
    await openEditor(page, closedYesterday());
    await expect(page.locator('[data-accepts-until-past]')).toContainText('nobody new can accept until you move it later');
    await expect(page.locator('.field-error-msg', { hasText: /acceptance deadline/ })).toHaveCount(0);
  });
});
