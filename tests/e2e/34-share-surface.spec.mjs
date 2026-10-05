// 34 - WS2: handing the link to students is a place, not a blob (ARCHITECTURE §10.3)
//
// Before this, the invitation link existed as a bare <span> in the publish
// banner, a lone primary button on the detail header, and nowhere at all on
// either list of assignments - so a lecturer who closed the editor had no route
// back to it. Rotation was reachable only from the Actions tab. And the detail
// page replaced ITSELF with "No report yet" until somebody accepted, taking the
// header, the share block, Teams, Export, Sync, Feedback PRs and Freeze with
// it: the one moment the link matters most was the one moment it was hidden.
//
// InvitationShare.vue is one component on four surfaces, so these tests care
// about the seams: what each surface knows about the token before it is
// clicked, and whether the status line tells the same story a student would
// see.

import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'linux-processes-2026';
const TITLE = 'Linux Processes 2026';

const share = (page) => page.locator('.invitation-share');
const copyBtn = (page) => page.locator('.invitation-share button', { hasText: /Copy/ }).first();
const compact = (page) => page.locator('.invitation-compact');

/**
 * The detail view's trigger for the link.
 *
 * On that one surface the block moved behind a labelled primary button: as a
 * always-open block it rendered a large truncated URL between the tab pills and
 * the table, and a lecturer reading it live could not tell what it was
 * (2026-09-02). The guarantee this file exists for is unchanged and still
 * asserted - the route back to the link never disappears - so these tests check
 * the trigger is there FIRST and only then open it.
 */
const inviteTrigger = (page) => page.locator('button:has(span:text-is("Invite link"))');

async function openInvitePopover(page) {
  await inviteTrigger(page).click();
  await expect(share(page).first()).toBeVisible();
}

function assignment(over = {}) {
  return {
    schema_version: 1,
    id: ID,
    title: TITLE,
    organization: ORG,
    template: { owner: ORG, repository: 'starter-template' },
    repository_name_pattern: `${ID}-{github_login}`,
    opens_at: new Date(Date.now() - 86400000).toISOString(),
    deadline_at: new Date(Date.now() + 86400000 * 7).toISOString(),
    state: 'published',
    assignment_type: 'individual',
    max_acceptances: 50,
    invite_key: inviteToken(ORG, ID),
    invite_nonce: '0badc0de',
    ...over,
  };
}

const brokerRepo = { name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}` };

async function openEditor(page, a = assignment(), extra = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [a.id]: a },
    userRepos: [brokerRepo],
    ...extra,
  });
  await page.goto(`/dashboard/${ORG}/admin?edit=${a.id}`);
  await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue(a.title, { timeout: 15000 });
}

// ============================================ §4.1 one block, one truth

test.describe('34 - §4.1 The share block says what a student would see', () => {
  test('A live assignment is Live, with the deadline it is live until', async ({ page }) => {
    await openEditor(page);
    await openInvitePopover(page);
    await expect(share(page).first()).toContainText('Live - students can accept now');
    await expect(share(page).first()).toContainText('Anyone with this link can accept until');
    await expect(share(page).first().locator('.status-dot.dot-success')).toBeVisible();
  });

  test('A past deadline is Closed here too, because it is closed to the student', async ({ page }) => {
    await openEditor(page, assignment({ deadline_at: new Date(Date.now() - 3600000).toISOString() }));
    await openInvitePopover(page);
    await expect(share(page).first()).toContainText('Closed');
    await expect(share(page).first()).toContainText('The deadline passed');
  });

  test('An assignment that has not opened yet says when it does', async ({ page }) => {
    await openEditor(page, assignment({
      opens_at: new Date(Date.now() + 86400000 * 2).toISOString(),
      deadline_at: new Date(Date.now() + 86400000 * 9).toISOString(),
    }));
    await openInvitePopover(page);
    await expect(share(page).first()).toContainText('Opens');
    await expect(share(page).first()).toContainText('nobody can accept before then');
  });

  test('A draft has no link and says why, instead of showing an empty box', async ({ page }) => {
    // The banner only renders for a published assignment, so the draft case is
    // the detail view's - where a lecturer lands from the dashboard.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment({ state: 'draft', invite_token: undefined }) },
      reports: {},
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);

    await openInvitePopover(page);
    await expect(share(page).first()).toContainText('Not shared yet', { timeout: 15000 });
    await expect(share(page).first()).toContainText('Publish the assignment to mint a link');
    await expect(share(page).first().locator('.status-dot.dot-neutral')).toBeVisible();
  });

  test('Open sends the lecturer to the page a student sees', async ({ page }) => {
    await openEditor(page);
    await openInvitePopover(page);
    const open = share(page).first().getByRole('link', { name: /Open/ });
    await expect(open).toHaveAttribute('href', new RegExp(`/${ORG}/i/`));
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', /noopener/);
  });

  test('The cap being full is the student-facing truth, not "Live"', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment({ max_acceptances: 2 }) },
      reports: {
        [ID]: {
          schema_version: 1, assignment_id: ID, org: ORG, generated_at: new Date().toISOString(),
          students: [
            { github_login: 'a', acceptance_state: 'accepted', submission_status: 'on-time' },
            { github_login: 'b', acceptance_state: 'accepted', submission_status: 'on-time' },
          ],
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);

    await openInvitePopover(page);
    await expect(share(page).first()).toContainText('Cap reached', { timeout: 15000 });
    await expect(share(page).first()).toContainText('2 of 2 places taken');
  });
});

// ============================================ §4.2 four surfaces

test.describe('34 - §4.2 The link is reachable without opening the editor', () => {
  // The Admin page's list carried it on every published row, and two tests
  // here held that. The list is gone (BETA-UX.md, 2026-10-02): assignments are
  // listed once, as the dashboard's cards, which carry it below, and every tab
  // of an assignment carries it in its header.

  test('The dashboard card carries it, reading the token only when clicked', async ({ page, context }) => {
    // dashboard.json must not hold the token, so the card has an id and nothing
    // else. Twenty cards therefore cost zero extra requests until one is used.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    let yamlReads = 0;
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: {
        dashboard: {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          assignments: {
            [ID]: { title: TITLE, state: 'published', deadline_at: assignment().deadline_at, accepted: 3 },
          },
        },
      },
    });
    await page.route(`**/contents/assignments/${ID}.yml*`, async (route) => {
      if (route.request().method() === 'GET') yamlReads++;
      await route.fallback();
    });

    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('.assignment-card')).toHaveCount(1, { timeout: 15000 });
    const before = yamlReads;

    await compact(page).click();
    await expect(page.locator('.toast', { hasText: /Invitation link copied/i })).toBeVisible({ timeout: 10000 });
    expect(yamlReads, 'the token is read on click, not on render').toBeGreaterThan(before);

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(inviteToken(ORG, ID));
  });

  test('Lifecycle no longer offers Copy - it is not a lifecycle transition', async ({ page }) => {
    await openEditor(page);
    const lifecycle = page.locator('.lifecycle');
    await expect(lifecycle).toBeVisible();
    await expect(lifecycle.locator('button', { hasText: /Copy invitation link/i })).toHaveCount(0);
  });

  test('Regenerate is offered beside the link, and arrives ticked', async ({ page }) => {
    // It was reachable only from the Actions tab. The one place it belongs is
    // next to the link it retires.
    await openEditor(page);
    await openInvitePopover(page);
    await share(page).first().getByRole('button', { name: /Regenerate link/ }).click();

    const modal = page.locator('.republish-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('input[type="checkbox"]')).toBeChecked();
    await expect(modal).toContainText('Every link already handed out stops working');
  });

  test('A repair republish still arrives unticked', async ({ page }) => {
    // The other entry point must keep its default: a repair must not break
    // links already handed out.
    await openEditor(page);
    await page.locator('button', { hasText: 'Republish broker' }).first().click();
    await expect(page.locator('.republish-modal input[type="checkbox"]')).not.toBeChecked();
  });
});

// ============================================ §4.3 the page stops collapsing

test.describe('34 - §4.3 A cohort of nobody is a row of the page, not the page', () => {
  async function detailWithNoReport(page, over = {}) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment(over) },
      reports: {}, // nobody has accepted, so no report file exists
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(page.locator('.report-content')).toBeVisible({ timeout: 15000 });
  }

  test('With nobody accepted, the share block and the actions bar survive', async ({ page }) => {
    await detailWithNoReport(page);

    // THE POINT OF THIS TEST: with nobody accepted the route to the link is
    // still on the page. It is a labelled button now rather than an open block,
    // so the trigger is what must survive - and the link must be one click
    // behind it, which is what the rest of this asserts.
    await expect(inviteTrigger(page)).toBeVisible();
    await openInvitePopover(page);
    await expect(copyBtn(page)).toBeVisible();
    await expect(page.getByRole('button', { name: /Export/i })).toBeVisible();
    await expect(page.locator('button:has(span:text-is("More"))')).toBeVisible();
    await expect(page.getByRole('button', { name: /Refresh/i }).first()).toBeVisible();
  });

  test('Only the table says nobody has accepted, and it says what to do', async ({ page }) => {
    await detailWithNoReport(page);

    const empty = page.locator('.cohort-empty');
    await expect(empty).toContainText('No one has accepted yet');
    await expect(empty).toContainText('Students appear here as they accept');
    // To the assignment's settings - who may accept, the dates, the cap. The
    // link itself is the Invite link button at the top of the page.
    await expect(empty.getByRole('link', { name: /check the settings/ })).toHaveAttribute(
      'href',
      new RegExp(`/dashboard/${ORG}/${ID}\\?tab=settings$`),
    );
  });

  test('"Run daily activity now" is gone; refreshing is small print', async ({ page }) => {
    // Workflow file names do not belong in an empty state.
    await detailWithNoReport(page);

    const empty = page.locator('.cohort-empty');
    await expect(empty).toContainText('Reports refresh automatically after each acceptance and nightly');
    await expect(empty.getByRole('button', { name: /Refresh now/ })).toBeVisible();
    await expect(page.locator('text=Run daily activity now')).toHaveCount(0);
    await expect(page.locator('text=daily-activity.yml')).toHaveCount(0);
  });

  test('The old full-page takeover is gone', async ({ page }) => {
    await detailWithNoReport(page);
    await expect(page.locator('h2', { hasText: 'No report yet' })).toHaveCount(0);
  });

  test('A past-deadline assignment nobody accepted shows no preservation status', async ({ page }) => {
    // "Preservation Pending 0/0" is a status about nothing.
    await detailWithNoReport(page, {
      opens_at: new Date(Date.now() - 86400000 * 9).toISOString(),
      deadline_at: new Date(Date.now() - 86400000).toISOString(),
    });
    // Positive first, for the same reason as above.
    await expect(page.locator('.cohort-empty')).toBeVisible();
    await expect(page.locator('.preservation-strip')).toHaveCount(0);
  });

  test('Once someone accepts, the table replaces the empty state', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: {
        [ID]: {
          schema_version: 1, assignment_id: ID, org: ORG, generated_at: new Date().toISOString(),
          students: [{ github_login: 'alice', acceptance_state: 'accepted', submission_status: 'on-time' }],
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);

    // The POSITIVE first. `toHaveCount(0)` is satisfied the instant the page is
    // still loading, so asserting absence before the content could have
    // appeared passes whatever the component does - it did, until a mutation
    // said otherwise.
    await expect(page.locator('table')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('td', { hasText: 'alice' }).first()).toBeVisible();
    await expect(page.locator('.cohort-empty')).toHaveCount(0);
    await expect(inviteTrigger(page)).toBeVisible();
  });
});

// ============================================ §4.4 one toolbar, one kind of menu

test.describe('34 - §4.4 The Invite link menu is built like Export and More', () => {
  // Reported 2026-09-30: Export and More beside it were rows with an icon, a
  // title and a line saying what each does, and the Invite link menu was a
  // small form - a heading, a paragraph, two buttons and a text link. Asked for
  // "in the same style". The rows are now the SAME rules (style.css), so this
  // compares what the browser computed rather than which classes are present:
  // a class can be on an element and styled by nothing (DESIGN.md §7).
  const ROW_LOOK = ['font-size', 'font-weight', 'padding-left', 'padding-top', 'gap', 'color'];

  async function detail(page) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [ID]: assignment() }, reports: {} });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(inviteTrigger(page)).toBeVisible({ timeout: 15000 });
  }

  /** The computed look of a menu's first row: the row, its title, its icon. */
  const lookOf = (menu) => menu.locator('.export-dropdown-item').first().evaluate((row, props) => {
    const pick = (el) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el).getPropertyValue(p)]));
    return {
      row: pick(row),
      title: pick(row.querySelector('.dropdown-item-title')),
      icon: getComputedStyle(row.querySelector('.dropdown-icon')).color,
    };
  }, ROW_LOOK);

  test('its rows look exactly like the Export menu\'s', async ({ page }) => {
    await detail(page);
    await openInvitePopover(page);
    const invite = page.locator('.invite-menu');
    // Four rows, each with its icon: copy, open, copy the confirm-email link,
    // and - on a published assignment - regenerate.
    await expect(invite.locator('.export-dropdown-item')).toHaveCount(4);
    await expect(invite.locator('.export-dropdown-item .dropdown-icon')).toHaveCount(4);
    await expect(invite.locator('.dropdown-item-title').last()).toHaveText(/^Regenerate link/);
    const inviteLook = await lookOf(invite);

    // The Invite link sits in the header above the toolbar, so its open menu
    // covers Export; close it the way a person would.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Export/i }).click();
    const exportLook = await lookOf(page.locator('.export-dropdown-menu[role="menu"]'));
    expect(inviteLook).toEqual(exportLook);
  });

  test('it keeps the link box and the status, and none of it is a button face', async ({ page }) => {
    await detail(page);
    await openInvitePopover(page);
    const invite = page.locator('.invite-menu');
    await expect(invite.locator('.invitation-link')).toContainText(`/${ORG}/i/`);
    await expect(invite).toContainText('Live - students can accept now');
    // The trigger is the view's one primary (DESIGN.md §1.2), and the rows are
    // rows: no .btn of any kind inside, the help button aside.
    await expect(invite.locator('.btn')).toHaveCount(0);
    // A row that is a link must not turn into running text on hover.
    const open = invite.getByRole('link', { name: /Open invite link/ });
    await expect(open).toHaveAttribute('href', new RegExp(`/${ORG}/i/`));
    await open.hover();
    await expect(open).toHaveCSS('text-decoration-line', 'none');
  });

  test('hovering a row shows, in light too - in every menu', async ({ page }) => {
    // The hover was --bg-tertiary, an alias of --bg-surface-elevated, which is
    // #ffffff in light exactly like the menu under it: hovering a row in Export
    // or More changed nothing, for as long as those menus had existed.
    await page.emulateMedia({ colorScheme: 'light' });
    await detail(page);
    const hovered = async (menu) => {
      const row = menu.locator('.export-dropdown-item').first();
      await row.hover();
      // The row's background TRANSITIONS, and a colour read mid-fade differs
      // from the menu's whatever the rule says - which is how this passed over
      // the defect it names, the first time it was run against the old code.
      await row.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      return Promise.all([
        row.evaluate((el) => getComputedStyle(el).backgroundColor),
        menu.evaluate((el) => getComputedStyle(el).backgroundColor),
      ]);
    };

    await page.getByRole('button', { name: /Export/i }).click();
    const [exportRow, exportMenu] = await hovered(page.locator('.export-dropdown-menu[role="menu"]'));
    expect(exportRow, 'Export: the hovered row must differ from the menu').not.toBe(exportMenu);
    await page.getByRole('button', { name: /Export/i }).click();

    await openInvitePopover(page);
    const [inviteRow, inviteMenu] = await hovered(page.locator('.invite-menu'));
    expect(inviteRow, 'Invite link: the hovered row must differ from the menu').not.toBe(inviteMenu);
  });

  test('the link box is cut, not the menu stretched: the real address is far longer', async ({ page }) => {
    // The box is one unbreakable line. As a min-width the menu grew to fit it -
    // 430px on localhost, about 650 on the real site, whose address carries the
    // Pages path and the organization.
    await detail(page);
    await openInvitePopover(page);
    const invite = page.locator('.invite-menu');
    const box = invite.locator('.invitation-link');
    // As long as the real one, and not the real one: the deployed origin is not
    // a test input (tests/e2e-hermetic.test.mjs).
    await box.evaluate((el, org) => { el.textContent = `https://an-institution.example/a-pages-project-path/pxl-classroom/${org}/i/…`; }, ORG);
    expect((await invite.boundingBox()).width).toBeLessThanOrEqual(342);
    expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth), 'the box ellipsises').toBe(true);
  });
});
