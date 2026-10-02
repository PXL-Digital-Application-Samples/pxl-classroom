// 37 - A published assignment opens on the cohort (ARCHITECTURE §10.1.1, §7)
//
// Three findings, one cause. The editor rendered the same screen whatever the
// assignment's state, so the moment a cohort was running - the moment the
// lecturer's job stopped being "define this" and became "how is it going" -
// they were still looking at `submission_ref` and a template picker. Two
// cohort-running operations lived in that form as accordions that made you
// type a student login from memory, while the tracking view already had
// better copies of both, reached from the student they concern.
//
// The plan numbered this spec 31; that number was taken by WS1's, so it is 37.

import { test, expect } from '@playwright/test';

// The repository name pattern is a line with Edit until somebody asks for the
// box (DESIGN.md §1.8); typing into it starts by asking, as a lecturer would.
async function patternBox(page) {
  const line = page.locator('[data-derived="pattern"]');
  const box = page.getByPlaceholder('linux-processes-{github_login}');
  await expect(line.or(box)).toBeVisible({ timeout: 15000 });
  if (await line.isVisible()) await line.getByRole('button', { name: 'Edit' }).click();
  return box;
}
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
  expandSettings,
  chooseState,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'linux-processes-2026';
const TITLE = 'Linux Processes 2026';
const STUDENT = 'student-personal';

// The countdown truncates, so the half-hour keeps "6d 23h" stable for the
// half hour a run could conceivably take. A flat 23h reads as 6d 22h the
// moment a second has passed between fixture and render.
const DEADLINE = new Date(Date.now() + 6 * 86400_000 + 23.5 * 3600_000).toISOString();

function assignment(overrides = {}) {
  return {
    schema_version: 1,
    id: ID,
    title: TITLE,
    organization: ORG,
    state: 'published',
    assignment_type: 'individual',
    roster_mode: 'enforced',
    max_acceptances: 150,
    opens_at: new Date(Date.now() - 86400_000).toISOString(),
    deadline_at: DEADLINE,
    template: { owner: ORG, repository: 'linux-template' },
    repository_name_pattern: `${ID}-{github_login}`,
    invite_key: inviteToken(ORG, ID),
    invite_nonce: '0badc0de',
    ...overrides,
  };
}

const dashboard = (accepted) => ({
  schema_version: 1,
  generated_at: new Date().toISOString(),
  assignments: {
    [ID]: {
      title: TITLE,
      state: 'published',
      deadline_at: DEADLINE,
      total_students: 200,
      accepted,
    },
  },
});

async function openEditor(page, { asgn = assignment(), extra = {} } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: asgn },
    userRepos: [{ name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}` }],
    ...extra,
  });
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(page.locator('.editor-form')).toBeVisible({ timeout: 15000 });
}

// ============================================================ the layout

// The editor is the assignment page's Settings tab (BETA-UX.md, 2026-10-03).
// It led with a share banner, a cohort card (accepted / cap / time left) and a
// "Track roster & progress" link; all three repeated what the page's own
// header and Progress tab say, one tab away, and were removed on request. What
// a published assignment's Settings still leads with is the folded form.
test.describe('37 - Settings is the form, under the assignment\'s own header', () => {
  test('No banner, no cohort card, no roster line - the header carries the assignment', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });

    await expect(page.locator('.assignment-tabs [aria-current="page"]')).toHaveText('Settings');
    await expect(page.locator('[data-state-menu]')).toContainText('Accepting');
    await expect(page.locator('.invitation-share-banner')).toHaveCount(0);
    await expect(page.locator('.cohort-card')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Track roster (&|and) progress/i })).toHaveCount(0);
    await expect(page.getByText('Course roster')).toHaveCount(0);

    // The form is folded on a published assignment, and the fold opens.
    const details = page.locator('details.settings-disclosure');
    await expect(details).toHaveJSProperty('open', false);
    await details.locator('> summary').click();
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue(TITLE);
  });

  test('Regenerate link is in the Invite link menu, and asks with the box ticked', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    await page.getByRole('button', { name: /Invite link/ }).click();
    await page.locator('.invite-menu .dropdown-item-title', { hasText: /^Regenerate link/ }).click();
    const modal = page.locator('.republish-modal');
    await expect(modal).toBeVisible({ timeout: 15000 });
    await expect(modal.locator('input[type="checkbox"]'), 'arriving to regenerate, it is ticked').toBeChecked();
  });

  test('Save, Cancel and Troubleshoot are one bar, stuck to the bottom', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    const bar = page.locator('.editor-action-bar');
    await expect(bar.getByRole('button', { name: /^Save$/ })).toBeVisible();
    await expect(bar.getByRole('button', { name: /^Cancel$/ })).toBeVisible();
    await expect(bar.getByRole('button', { name: /Troubleshoot/ })).toBeVisible();
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
    // Once: no second Save anywhere on the page.
    await expect(page.getByRole('button', { name: /^Save$/ })).toHaveCount(1);
  });

  test('A draft still opens on the form', async ({ page }) => {
    // Defining it IS the job there. The disclosure exists so there is one
    // markup path, but its summary must not be on screen.
    const draft = assignment({ state: 'draft' });
    delete draft.invite_token;
    delete draft.invite_nonce;
    await openEditor(page, { asgn: draft });

    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
    await expect(page.locator('details.settings-disclosure > summary')).toBeHidden();
  });

  test('Reverting to draft gives the form back', async ({ page }) => {
    // `settingsOpen` is per-assignment state a lecturer owns, so a published
    // assignment they left collapsed and then reverted would otherwise render
    // a shut <details> whose summary is display:none - a form with no control
    // to open it.
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    await expect(page.locator('details.settings-disclosure')).toHaveJSProperty('open', false);

    page.on('dialog', (d) => d.accept());
    await chooseState(page, 'Back to draft');

    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('details.settings-disclosure > summary')).toBeHidden();
  });

  test('A closed assignment keeps the form folded too', async ({ page }) => {
    // Nobody opens a closed assignment to change its repository name pattern.
    await openEditor(page, {
      asgn: assignment({ state: 'closed' }),
      extra: { reports: { dashboard: { ...dashboard(47), assignments: { [ID]: { ...dashboard(47).assignments[ID], state: 'closed' } } } } },
    });
    await expect(page.locator('details.settings-disclosure')).toHaveJSProperty('open', false);
  });
});

// ======================================================= the disclosure

test.describe('37 - A validation problem cannot hide behind the disclosure', () => {
  test('An assignment that loads broken opens expanded, and says how many', async ({ page }) => {
    // A hand-edited YAML with no template is the realistic case: the panel
    // cannot save it, and collapsing the only field that would fix it leaves
    // a disabled Save with no explanation.
    const broken = assignment();
    delete broken.template;
    await openEditor(page, { asgn: broken });

    await expect(page.locator('details.settings-disclosure')).toHaveJSProperty('open', true);
    await expect(page.locator('.settings-problems')).toContainText('1 field needs fixing');
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
  });

  test('The count stays on screen after the disclosure is closed again', async ({ page }) => {
    // The guarantee is not that the disclosure refuses to close - that would
    // be a dead control - but that shutting it does not take the problem with
    // it. Save is disabled and the summary says how many, from outside.
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    const details = page.locator('details.settings-disclosure');
    await expect(details).toHaveJSProperty('open', false);
    await expect(page.locator('.settings-problems')).toHaveCount(0);

    await details.locator('> summary').click();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('');
    await expect(page.locator('.settings-problems')).toContainText('1 field needs fixing');
    await (await patternBox(page)).fill('no-placeholder-here');
    await expect(page.locator('.settings-problems')).toContainText('2 fields need fixing');

    await details.locator('> summary').click();
    await expect(details, 'a lecturer who has seen the count may still close it').toHaveJSProperty('open', false);
    await expect(page.locator('.settings-problems')).toBeVisible();
    await expect(page.locator('.settings-problems')).toContainText('2 fields need fixing');
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeDisabled();
  });

  test('Fixing the fields clears the count', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    const details = page.locator('details.settings-disclosure');
    await details.locator('> summary').click();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('');
    await expect(page.locator('.settings-problems')).toBeVisible();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill(TITLE);
    await expect(page.locator('.settings-problems')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeEnabled();
  });
});

// ============================================= operations leave the form

test.describe('37 - Per-student operations live on the student', () => {
  test('The editor no longer asks for a login it cannot check', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    await expandSettings(page);

    for (const gone of [/Grant deadline extension/i, /Retry a failed acceptance/i]) {
      await expect(page.locator('.editor-form').getByText(gone)).toHaveCount(0);
    }
    await expect(page.getByPlaceholder('octocat')).toHaveCount(0);
  });

  test('And the student rows are one tab away from the settings', async ({ page }) => {
    // The settings are the assignment's Settings tab now, under the same
    // header as its Progress tab, where each student's row is.
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    await expect(page.locator('.assignment-tabs .primer-tab', { hasText: /^Progress$/ })).toHaveAttribute(
      'href',
      new RegExp(`/dashboard/${ORG}/${ID}$`),
    );
  });

  test('They are on the student row, where the login comes from the row', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: {
        [ID]: {
          // No `org` field: report.schema.json is additionalProperties: false
          // and declares no such root property. This spec asserts on writes to
          // reports/, so a fixture the app could not have written is one the
          // save it guards would be refused for.
          schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(),
          students: [{ github_login: STUDENT, acceptance_state: 'accepted', submission_status: 'on-time' }],
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await page.getByRole('button', { name: `Actions for ${STUDENT}` }).first().click();

    const modal = page.locator('.modal-overlay .modal');
    await expect(modal).toContainText('Grant deadline extension');
    await expect(modal).toContainText('Retry acceptance');
    await expect(modal).toContainText(STUDENT);
  });

  test('a roster GitHub cannot serve does not take the cohort down with it', async ({ page }) => {
    // Reported 2026-09-04 on pxl-classroom-testbed/live-smoke-group: "Failed to
    // load report - Internal Server Error" over a report and an assignment that
    // had both answered 200. The three reads share one Promise.all and
    // getRepoContent throws on anything but a 404, so the page had the failure
    // tolerance of its least important read. The roster only maps a login to a
    // name; nothing here depends on it.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: {
        [ID]: {
          // No `org` field: report.schema.json is additionalProperties: false
          // and declares no such root property. This spec asserts on writes to
          // reports/, so a fixture the app could not have written is one the
          // save it guards would be refused for.
          schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(),
          students: [{ github_login: STUDENT, acceptance_state: 'accepted', submission_status: 'on-time' }],
        },
      },
    });
    // Registered after the standard routes so it wins.
    await page.route('**/pxl-classroom-control/contents/students/roster.y*ml*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Internal Server Error' }),
      }),
    );

    await page.goto(`/dashboard/${ORG}/${ID}`);

    await expect(page.locator('text=Failed to load report')).toHaveCount(0);
    await expect(page.locator(`text=${STUDENT}`).first()).toBeVisible({ timeout: 15000 });
  });
});

// ======================================================== the lifecycle

test.describe('37 - Repair in the settings, state in the header', () => {
  test('Repair stays in the settings; the transitions are the state button', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });

    const repair = page.locator('.lifecycle-repair');
    await expect(repair).toContainText('Repair');
    await expect(repair.getByRole('button', { name: /Republish broker/i })).toBeVisible();
    await expect(repair, 'a repair must promise not to break live links')
      .toContainText('links already handed out keep working');

    // One place for the state, on every tab: no second row of buttons here.
    await expect(page.locator('.lifecycle-transitions')).toHaveCount(0);
    await page.locator('[data-state-menu]').click();
    const items = page.locator('.state-menu .dropdown-item-title');
    await expect(items).toHaveText(['Stop accepting', 'Back to draft', 'Archive']);
    // Republish is NOT a transition.
    await expect(page.locator('.state-menu')).not.toContainText('Republish');
  });

  test('A draft has nothing to repair, and Publish is on the state button', async ({ page }) => {
    const draft = assignment({ state: 'draft' });
    delete draft.invite_token;
    await openEditor(page, { asgn: draft });

    await expect(page.locator('.lifecycle-repair')).toHaveCount(0);
    await page.locator('[data-state-menu]').click();
    await expect(page.locator('.state-menu .dropdown-item-title').first()).toHaveText('Publish');
  });

  test('Stopping the cohort names the consequence before it happens', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });

    const seen = [];
    page.on('dialog', (d) => { seen.push(d.message()); d.dismiss(); });
    await chooseState(page, 'Stop accepting');
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toMatch(/no longer accept/i);
    expect(seen[0], 'and what is NOT affected, which is the anxious question')
      .toMatch(/existing repos are unaffected/i);
  });

  test('Reverting to draft names its consequence too, and dismissing changes nothing', async ({ page }) => {
    const contentWrites = [];
    await openEditor(page, { extra: { contentWrites, reports: { dashboard: dashboard(47) } } });

    const seen = [];
    page.on('dialog', (d) => { seen.push(d.message()); d.dismiss(); });
    await chooseState(page, 'Back to draft');
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toMatch(/students can no longer open the accept link/i);
    expect(
      contentWrites.filter((w) => w.path.startsWith('assignments/')),
      'a dismissed confirmation writes nothing',
    ).toEqual([]);
  });
});

// ============================================================ DESIGN.md §1.2

test.describe('37 - The editor has one solid button', () => {
  const VISIBLE_PRIMARIES = () => {
    const vis = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
    return [...document.querySelectorAll('.btn-primary')]
      .filter(vis)
      .map((b) => b.textContent.trim().replace(/\s+/g, ' ').slice(0, 40));
  };

  test('Opening an assignment leaves exactly one, and it is Save', async ({ page }) => {
    // Five before this workstream: `New assignment`, `Save & publish` twice
    // (the form repeated its actions top and bottom), `Grant extension` and
    // `Retry acceptance`. tests/e2e/22 scoped its admin check to the published
    // banner until WS5 decided which survives.
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    expect(await page.evaluate(VISIBLE_PRIMARIES)).toEqual(['Save']);

    // Still one with the settings open - that is where the duplicate row was.
    await expandSettings(page);
    expect(await page.evaluate(VISIBLE_PRIMARIES)).toEqual(['Save']);
  });

  test('On the list of assignments, New assignment is the one', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: { dashboard: dashboard(47) },
    });
    await page.goto(`/dashboard/${ORG}`);
    await expect(page.locator('.assignment-card').first()).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate(VISIBLE_PRIMARIES)).toEqual(['New assignment']);
  });

  test('A draft editor is one too, and it is Save & publish', async ({ page }) => {
    const draft = assignment({ state: 'draft' });
    delete draft.invite_token;
    await openEditor(page, { asgn: draft });
    expect(await page.evaluate(VISIBLE_PRIMARIES)).toEqual(['Save & publish']);
  });
});
