// 38 - The edges of WS5 (UX_PLAN §7)
//
// 37 covers the shape. This covers what the shape does when the data is wrong,
// when the lecturer moves between assignments, and when a state transition
// changes which layout applies underneath them.
//
// Three of these exist because writing them found the bug:
//
//   * `Republish broker` on a CLOSED assignment reopened it for acceptance.
//     publish-assignment.yml runs `sed -i "s/^state:.*/state: published/"`
//     with no regard for the prior state, and WS5 had just relabelled that
//     dispatch as a repair, under copy promising nothing changes. C4 exactly.
//   * A hand-edited `deadline_at: soon` took the whole editor pane down.
//     `localToUtc` called `toISOString()` on an unparseable date inside the
//     `shareAssignment` computed, so the crash happened during render - and
//     the field that would fix it was on the far side of it.
//   * The cohort card and the settings disclosure are per-assignment state
//     living on a view that never unmounts between assignments.

import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
  expandSettings,
} from '../fixtures/e2e-fixtures.mjs';

const A = 'linux-processes-2026';
const B = 'linux-networking-2026';
const TITLE_A = 'Linux Processes 2026';
const TITLE_B = 'Linux Networking 2026';

const DEADLINE = new Date(Date.now() + 6 * 86400_000 + 23.5 * 3600_000).toISOString();

function assignment(id, overrides = {}) {
  return {
    schema_version: 1,
    id,
    title: id === A ? TITLE_A : TITLE_B,
    organization: ORG,
    state: 'published',
    assignment_type: 'individual',
    roster_mode: 'enforced',
    max_acceptances: 150,
    opens_at: new Date(Date.now() - 86400_000).toISOString(),
    deadline_at: DEADLINE,
    template: { owner: ORG, repository: 'linux-template' },
    repository_name_pattern: `${id}-{github_login}`,
    invite_token: inviteToken(ORG, id),
    invite_nonce: '0badc0de',
    ...overrides,
  };
}

const entry = (over = {}) => ({
  title: TITLE_A,
  state: 'published',
  deadline_at: DEADLINE,
  total_students: 200,
  accepted: 47,
  ...over,
});

const dashboardDoc = (assignments) => ({
  schema_version: 1,
  generated_at: new Date().toISOString(),
  assignments,
});

/** Serve reports/dashboard.json with a body and status of our choosing. */
async function routeDashboard(page, handler) {
  await page.route('**/pxl-classroom-control/contents/reports/dashboard.json*', handler);
}

/** A base64 Contents API envelope, as GitHub returns one. */
const contents = (text) => ({
  status: 200,
  body: JSON.stringify({
    content: Buffer.from(text).toString('base64'),
    encoding: 'base64',
  }),
});

async function open(page, { assignments, edit = A, extra = {} } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments,
    userRepos: Object.keys(assignments).map((id) => ({
      name: `broker-${id}`, full_name: `${ORG}/broker-${id}`,
    })),
    ...extra,
  });
  await page.goto(`/dashboard/${ORG}/admin${edit ? `?edit=${edit}` : ''}`);
  if (edit) await expect(page.locator('.editor-form')).toBeVisible({ timeout: 15000 });
}

const cohort = (page) => page.locator('.cohort-card');
const details = (page) => page.locator('details.settings-disclosure');

// ============================================ the card's arithmetic and refusals

test.describe('38 - What the cohort card will and will not claim', () => {
  test('Zero accepted is a number and is shown as one', async ({ page }) => {
    // The mirror of 37's "no report yet". A report that HAS run and found
    // nobody is a real answer - collapsing it into the same "—" as a missing
    // report would throw away the only fact that distinguishes "nobody has
    // accepted" from "nobody has looked".
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry({ accepted: 0 }) }) } },
    });
    await expect(cohort(page)).toContainText('0');
    await expect(cohort(page)).toContainText('/ 150');
    await expect(cohort(page)).not.toContainText('no cohort report yet');
  });

  test('A report for other assignments is not a report for this one', async ({ page }) => {
    // dashboard.json is org-wide. Reading it as "we have data" rather than
    // "we have data about THIS id" is how a lecturer gets shown a sibling
    // assignment's numbers.
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ 'some-other-lab': entry({ accepted: 99 }) }) } },
    });
    await expect(cohort(page)).toContainText('no cohort report yet');
    await expect(cohort(page)).not.toContainText('99');
  });

  test('A non-numeric accepted count is refused rather than rendered', async ({ page }) => {
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry({ accepted: null }) }) } },
    });
    await expect(cohort(page)).toContainText('no cohort report yet');
    await expect(cohort(page)).not.toContainText('null');
    await expect(cohort(page)).not.toContainText('NaN');
  });

  test('More accepted than the cap is reported, not clamped', async ({ page }) => {
    // Lowering max_acceptances after the fact does not un-accept anybody. The
    // card is a report; 151/150 is the thing the lecturer needs to see.
    await open(page, {
      assignments: { [A]: assignment(A, { max_acceptances: 150 }) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry({ accepted: 151 }) }) } },
    });
    await expect(cohort(page)).toContainText('151');
    await expect(cohort(page)).toContainText('/ 150');
  });

  test('A dashboard.json too big for the Contents API is not read as absent', async ({ page }) => {
    // Above 1 MB GitHub answers 200 with `encoding: "none"` and an empty
    // body. That read as "file not found" for every caller once (F19), and
    // the cohort card is a new caller on the same path - a big cohort is
    // exactly when this file gets large.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [A]: assignment(A) },
    });
    const body = JSON.stringify(dashboardDoc({ [A]: entry({ accepted: 1234 }) }));
    await routeDashboard(page, async (route) => {
      if (route.request().headers()['accept'] === 'application/vnd.github.raw') {
        await route.fulfill({ status: 200, contentType: 'application/json', body });
        return;
      }
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ content: '', encoding: 'none', size: 2_000_000 }),
      });
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${A}`);

    await expect(cohort(page)).toContainText('1234', { timeout: 15000 });
    await expect(cohort(page)).not.toContainText('no cohort report yet');
  });

  test('A dashboard.json that is not JSON reads as unreadable, not as empty', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [A]: assignment(A) } });
    await routeDashboard(page, (route) => route.fulfill(contents('<!doctype html><h1>502</h1>')));
    await page.goto(`/dashboard/${ORG}/admin?edit=${A}`);

    await expect(cohort(page)).toContainText("couldn't read the cohort report", { timeout: 15000 });
  });

  test('A 404 is an answer; a 500 is not', async ({ page }) => {
    // The distinction the whole card rests on. Same rule as WS3's roster
    // count one module over: "there is no report" and "the report could not
    // be read" are different facts and only one of them means zero.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [A]: assignment(A) } });
    await routeDashboard(page, (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
    await page.goto(`/dashboard/${ORG}/admin?edit=${A}`);
    await expect(cohort(page)).toContainText('no cohort report yet', { timeout: 15000 });
  });

  test('The card waits rather than guessing while the report is in flight', async ({ page }) => {
    // Held open explicitly, not delayed by a timer - a timer the assertion
    // outlives proves nothing.
    let release;
    const held = new Promise((r) => { release = r; });
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [A]: assignment(A) } });
    await routeDashboard(page, async (route) => {
      await held;
      await route.fulfill(contents(JSON.stringify(dashboardDoc({ [A]: entry({ accepted: 12 }) }))));
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${A}`);

    await expect(cohort(page)).toContainText('reading the report…', { timeout: 15000 });
    await expect(cohort(page), 'never a zero it has not been told').not.toContainText('0 / 150');

    release();
    await expect(cohort(page)).toContainText('12');
    await expect(cohort(page)).not.toContainText('reading the report…');
  });

  test('An assignment named after an Object prototype key gets the honest answer', async ({ page }) => {
    // `dashboardEntries[form.id]` on a JSON.parse'd object walks the
    // prototype, and the slug rule allows `constructor`. The lookup must
    // produce "no report", not a stray function or a crash.
    const id = 'constructor';
    await open(page, {
      assignments: { [id]: assignment(id, { title: 'Constructor Lab' }) },
      edit: id,
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(cohort(page)).toContainText('no cohort report yet');
    await expect(page.locator('.editor-form')).toBeVisible();
  });
});

// ================================================ the deadline half of the card

test.describe('38 - The countdown at its edges', () => {
  test('An assignment with no deadline says so instead of counting nothing', async ({ page }) => {
    const noDeadline = assignment(A);
    delete noDeadline.deadline_at;
    await open(page, {
      assignments: { [A]: noDeadline },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(cohort(page)).toContainText('no deadline set');
    await expect(cohort(page)).not.toContainText('until the deadline');
  });

  test('A deadline the browser cannot parse does not take the editor down', async ({ page }) => {
    // `toISOString()` throws RangeError on an invalid Date, and it ran inside
    // a computed - so the pane failed to render at all, with the field that
    // would fix it inside the pane. The cohort card now says there is no
    // deadline, the settings open because there is a problem, and the field
    // itself says which.
    await open(page, {
      assignments: { [A]: assignment(A, { deadline_at: 'soon' }) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });

    await expect(page.locator('.editor-form')).toBeVisible();
    await expect(cohort(page)).toContainText('no deadline set');
    await expect(details(page)).toHaveJSProperty('open', true);
    await expect(page.locator('.field-error-msg', { hasText: /not a date the panel can read/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeDisabled();
  });

  test('A deadline under an hour counts in minutes, with no hours component', async ({ page }) => {
    // The number itself is a moving target between fixture and render, so the
    // assertion is the UNIT: under an hour there must be no `Xh` at all, or
    // the lecturer reads "0h 42m" for something due before lunch.
    await open(page, {
      assignments: { [A]: assignment(A, { deadline_at: new Date(Date.now() + 42.5 * 60_000).toISOString() }) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(cohort(page)).toContainText('until the deadline');
    const text = await cohort(page).innerText();
    expect(text).toMatch(/\b4[12]m\b/);
    expect(text, 'no hours and no days below the hour').not.toMatch(/\d+\s*[hd]\b/);
  });

  test('The countdown moves on its own, without a reload', async ({ page }) => {
    // A minute ref that never ticks is a countdown frozen at page-load time,
    // which is worse than no countdown - it is confidently wrong by however
    // long the tab has been open.
    await page.clock.install();
    await open(page, {
      assignments: { [A]: assignment(A, { deadline_at: new Date(Date.now() + 3 * 3600_000).toISOString() }) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(cohort(page)).toContainText('2h 59m');

    await page.clock.runFor('30:00');
    await expect(cohort(page)).toContainText('2h 29m');
  });
});

// ==================================== moving between assignments on a live view

test.describe('38 - Nothing leaks from one assignment to the next', () => {
  const two = { [A]: assignment(A), [B]: assignment(B) };
  // Dashboard ENTRIES, not the assignment documents - `accepted` is what the
  // card reads, and an assignment object has no such field. Passing the wrong
  // shape here made an earlier draft of these tests pass against a card
  // permanently stuck on "no cohort report yet".
  const dashTwo = dashboardDoc({
    [A]: entry({ accepted: 47 }),
    [B]: entry({ title: TITLE_B, accepted: 3 }),
  });

  const row = (page, title) => page.locator('.assignment-list li', { hasText: title }).first();

  test('Opening a second published assignment collapses its settings again', async ({ page }) => {
    // `settingsOpen` is a single ref on a view that never unmounts. Left
    // alone, the lecturer expands A once and every assignment after it opens
    // on the form - the exact behaviour WS5 removed.
    await open(page, { assignments: two, extra: { reports: { dashboard: dashTwo } } });
    await expandSettings(page);
    await expect(details(page)).toHaveJSProperty('open', true);

    await row(page, TITLE_B).click();
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue(TITLE_B, { timeout: 10000 })
      .catch(() => {});
    await expect(details(page)).toHaveJSProperty('open', false);
  });

  test('Switching from a published assignment to a draft gives the form back', async ({ page }) => {
    const mixed = { [A]: assignment(A), [B]: assignment(B, { state: 'draft', invite_token: undefined }) };
    await open(page, { assignments: mixed, extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } } });
    await expect(details(page)).toHaveJSProperty('open', false);

    await row(page, TITLE_B).click();
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue(TITLE_B, { timeout: 10000 });
    await expect(cohort(page)).toHaveCount(0);
    await expect(page.locator('details.settings-disclosure > summary')).toBeHidden();
  });

  test('The cohort card reads the assignment on screen, not the one before it', async ({ page }) => {
    await open(page, {
      assignments: two,
      extra: {
        reports: {
          dashboard: dashboardDoc({
            [A]: entry({ accepted: 47 }),
            [B]: entry({ title: TITLE_B, accepted: 3 }),
          }),
        },
      },
    });
    await expect(cohort(page)).toContainText('47');

    await row(page, TITLE_B).click();
    await expect(cohort(page)).toContainText('3', { timeout: 10000 });
    await expect(cohort(page)).not.toContainText('47');
  });

  test('The "moved" pointer follows the assignment', async ({ page }) => {
    await open(page, { assignments: two, extra: { reports: { dashboard: dashTwo } } });
    const link = () => page.locator('.lifecycle-moved a');
    await expect(link()).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}/${A}$`));

    await row(page, TITLE_B).click();
    await expect(link()).toHaveAttribute('href', new RegExp(`/dashboard/${ORG}/${B}$`), { timeout: 10000 });
  });

  test('New assignment after a published one opens on the form', async ({ page }) => {
    await open(page, { assignments: two, extra: { reports: { dashboard: dashTwo } } });
    await expect(details(page)).toHaveJSProperty('open', false);

    await page.getByRole('button', { name: /New assignment/ }).click();
    await expect(page.locator('.editor-title h3', { hasText: 'New assignment' })).toBeVisible();
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
    await expect(cohort(page)).toHaveCount(0);
    await expect(page.locator('details.settings-disclosure > summary')).toBeHidden();
  });

  test('A dismissed unsaved-changes prompt leaves the edit and the disclosure alone', async ({ page }) => {
    await open(page, { assignments: two, extra: { reports: { dashboard: dashTwo } } });
    await expandSettings(page);
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Edited but not saved');

    page.on('dialog', (d) => d.dismiss());
    await row(page, TITLE_B).click();

    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Edited but not saved');
    await expect(details(page), 'the disclosure the edit is inside must not shut').toHaveJSProperty('open', true);
  });

  test('Flipping to the Roster tab and back keeps the pane where it was', async ({ page }) => {
    // The tabs are v-show, so nothing unmounts - which is the point, and also
    // means any state that got out of step would survive the round trip.
    await open(page, { assignments: two, extra: { reports: { dashboard: dashTwo } } });
    await expandSettings(page);

    await page.getByRole('tab', { name: 'Roster' }).click();
    await expect(page.getByRole('tab', { name: 'Roster' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Assignments' }).click();

    await expect(details(page)).toHaveJSProperty('open', true);
    await expect(cohort(page)).toContainText('47');
  });
});

// ============================================ transitions change which layout applies

test.describe('38 - A state transition changes the layout under the lecturer', () => {
  test('Stopping acceptance keeps the cohort card - closed is still a cohort', async ({ page }) => {
    const contentWrites = [];
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { contentWrites, reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /^Stop accepting$/ }).click();

    await expect(page.locator('.badge', { hasText: 'closed' }).first()).toBeVisible({ timeout: 15000 });
    await expect(cohort(page), 'a closed assignment still has a cohort to look at').toBeVisible();
    await expect(details(page)).toHaveJSProperty('open', false);
    await expect(page.getByRole('button', { name: /^Stop accepting$/ })).toBeDisabled();
  });

  test('Archiving hands the form back', async ({ page }) => {
    // `cohortFirst` is published-or-closed. An archived assignment is out of
    // day-to-day tracking, so what is left to look at is its configuration -
    // and the disclosure must not strand it behind a hidden summary.
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /^Archive$/ }).click();

    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible({ timeout: 15000 });
    await expect(cohort(page)).toHaveCount(0);
    await expect(page.locator('details.settings-disclosure > summary')).toBeHidden();
    await expect(page.getByRole('button', { name: /^Archive$/ })).toBeDisabled();
  });

  test('Publishing a draft flips to the cohort layout without yanking the form away', async ({ page }) => {
    // The lecturer was mid-form a second ago. Collapsing the settings out
    // from under the click that published would be the opposite of helpful,
    // so `settingsOpen` is the lecturer's and survives the transition.
    const draft = assignment(A, { state: 'draft' });
    delete draft.invite_token;
    delete draft.invite_nonce;
    await open(page, { assignments: { [A]: draft } });
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();

    await page.getByRole('button', { name: /^Save & publish$/ }).click();

    await expect(cohort(page)).toBeVisible({ timeout: 15000 });
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026'), 'the form the lecturer was in stays open')
      .toBeVisible();
    await expect(details(page)).toHaveJSProperty('open', true);
  });
});

// ========================================== "Repair" must not change what it is

test.describe('38 - Republish is a repair only where it repairs', () => {
  test('A closed assignment is not offered a repair, because there is not one', async ({ page }) => {
    // publish-assignment.yml writes `state: published` unconditionally, so
    // the only republish mechanism available REOPENS a closed assignment.
    // Offering it under a Repair heading whose own copy says "existing
    // student repositories are untouched" is the UI describing behaviour the
    // system does not have.
    await open(page, {
      assignments: { [A]: assignment(A, { state: 'closed' }) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry({ state: 'closed' }) }) } },
    });

    await expect(page.locator('.lifecycle-repair')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Republish broker/i })).toHaveCount(0);
    await expect(
      page.locator('.lifecycle-transitions').getByRole('button', { name: /^Reopen for acceptance$/ }),
    ).toBeVisible();
  });

  test('Reopening says what it does, and dismissing dispatches nothing', async ({ page }) => {
    const workflowDispatches = [];
    await open(page, {
      assignments: { [A]: assignment(A, { state: 'closed' }) },
      extra: { workflowDispatches, reports: { dashboard: dashboardDoc({ [A]: entry({ state: 'closed' }) }) } },
    });

    const seen = [];
    page.on('dialog', (d) => { seen.push(d.message()); d.dismiss(); });
    await page.getByRole('button', { name: /^Reopen for acceptance$/ }).click();

    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toMatch(/reopen/i);
    expect(seen[0], 'the consequence, in the words that matter to a cohort')
      .toMatch(/students can accept it again/i);
    expect(
      workflowDispatches.filter((d) => d.workflow === 'publish-assignment.yml'),
      'a dismissed confirmation dispatches nothing',
    ).toEqual([]);
  });

  test('An archived assignment reopens too, and is equally explicit', async ({ page }) => {
    await open(page, { assignments: { [A]: assignment(A, { state: 'archived' }) } });
    await expect(page.locator('.lifecycle-repair')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Reopen for acceptance$/ })).toBeVisible();
  });

  test('A published assignment still repairs, and that path is unchanged', async ({ page }) => {
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await page.getByRole('button', { name: /Republish broker/i }).click();

    const modal = page.locator('.republish-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('input[type="checkbox"]'), 'a repair must not arrive ticked').not.toBeChecked();
  });
});

// ============================ the validations the disclosure must not swallow

test.describe('38 - Every validation still reaches the lecturer', () => {
  const opensCollapsedWith = async (page, overrides, message) => {
    await open(page, {
      assignments: { [A]: assignment(A, overrides) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(details(page), 'a problem on load opens the settings').toHaveJSProperty('open', true);
    await expect(page.locator('.settings-problems')).toBeVisible();
    await expect(page.locator('.field-error-msg', { hasText: message })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeDisabled();
  };

  test('WS1: open enrolment with no cap', async ({ page }) => {
    const uncapped = { roster_mode: 'open' };
    const a = assignment(A, uncapped);
    delete a.max_acceptances;
    await open(page, {
      assignments: { [A]: a },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(details(page)).toHaveJSProperty('open', true);
    await expect(page.locator('.field-error-msg', { hasText: /Open enrollment requires a cap/i })).toBeVisible();
  });

  test('A published field that cannot be published', async ({ page }) => {
    await opensCollapsedWith(page, { description: 'Questions? Mail me at tom.cool@pxl.be' }, /email|contact/i);
  });

  test('WS4: a python check with no script', async ({ page }) => {
    await open(page, {
      assignments: {
        [A]: assignment(A, {
          autograde: {
            enabled: true,
            execution_environment: 'lecturer_local',
            visibility: 'private',
            tests: [{ id: 'no-script', type: 'python', points: 1 }],
          },
        }),
      },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(details(page)).toHaveJSProperty('open', true);
    await expect(page.locator('.settings-problems')).toContainText('1 field needs fixing');
    await expect(page.locator('.field-error-msg', { hasText: /needs a script/i })).toBeVisible();
  });

  test('A deadline before the open date', async ({ page }) => {
    await opensCollapsedWith(
      page,
      { deadline_at: new Date(Date.now() - 5 * 86400_000).toISOString() },
      /after the open date/i,
    );
  });
});

// ================================== saving from a pane whose form was never opened

test.describe('38 - Save without ever opening the settings', () => {
  test('One click from a collapsed pane rebuilds the whole document, losing nothing', async ({ page }) => {
    // buildDoc reconstructs the YAML field by field, so anything it does not
    // carry through is deleted - and WS5 made that reachable without the
    // lecturer ever seeing the fields. Everything the assignment had must
    // still be there.
    const contentWrites = [];
    const rich = assignment(A, {
      description: 'Processes, signals and job control.',
      feedback_pr: true,
      feedback_pr_baseline_branch: 'pxl-baseline',
      lock_down_enabled: false,
      late_policy: 'block',
      submission_ref: 'refs/heads/hand-in',
      timezone: 'Europe/Brussels',
      student_permission: 'admin',
      autograde: {
        enabled: true,
        execution_environment: 'github_actions',
        visibility: 'private',
        tests: [{ id: 'unit', type: 'run', command: 'npm test', points: 10, timeout_s: 120 }],
      },
    });
    await open(page, {
      assignments: { [A]: rich },
      extra: { contentWrites, reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(details(page)).toHaveJSProperty('open', false);

    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect.poll(
      () => contentWrites.find((w) => w.path === `assignments/${A}.yml`),
      { timeout: 15000 },
    ).toBeTruthy();

    const yaml = contentWrites.find((w) => w.path === `assignments/${A}.yml`).content;
    const { parse } = await import('yaml');
    const doc = parse(yaml);

    expect(doc.state, 'saving a published assignment must not unpublish it').toBe('published');
    expect(doc.invite_token, 'the link in students hands').toBe(rich.invite_token);
    expect(doc.invite_nonce).toBe('0badc0de');
    expect(doc.description).toBe('Processes, signals and job control.');
    expect(doc.late_policy).toBe('block');
    expect(doc.lock_down_enabled).toBe(false);
    expect(doc.submission_ref).toBe('refs/heads/hand-in');
    expect(doc.feedback_pr).toBe(true);
    expect(doc.max_acceptances).toBe(150);
    expect(doc.autograde.tests).toHaveLength(1);
    expect(doc.autograde.tests[0].timeout_s, 'a field no control shows is still a field').toBe(120);
    expect(doc.autograde.execution_environment).toBe('github_actions');
  });

  test('An uncapped assignment stays uncapped through a blind save', async ({ page }) => {
    // The `?? 50` that capped an uncapped assignment the first time anyone
    // opened it. WS5 removed the need to open anything at all.
    const contentWrites = [];
    const uncapped = assignment(A);
    delete uncapped.max_acceptances;
    await open(page, {
      assignments: { [A]: uncapped },
      extra: { contentWrites, reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(cohort(page)).not.toContainText('/');

    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect.poll(
      () => contentWrites.find((w) => w.path === `assignments/${A}.yml`),
      { timeout: 15000 },
    ).toBeTruthy();

    const { parse } = await import('yaml');
    const doc = parse(contentWrites.find((w) => w.path === `assignments/${A}.yml`).content);
    expect(doc.max_acceptances, 'no cap means no cap, still').toBeUndefined();
  });
});

// ================================================================ the control itself

test.describe('38 - The disclosure is a control, and behaves like one', () => {
  test('It is reachable and operable from the keyboard', async ({ page }) => {
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    const summary = page.locator('details.settings-disclosure > summary');
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(details(page)).toHaveJSProperty('open', true);
    await page.keyboard.press('Enter');
    await expect(details(page)).toHaveJSProperty('open', false);
  });

  test('It carries a marker, because flex removes the native one', async ({ page }) => {
    // Setting any display other than list-item on a <summary> silently drops
    // the disclosure triangle. The control still toggles; it just stops
    // looking like a control.
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    const caret = page.locator('.settings-disclosure .settings-caret');
    await expect(caret).toBeVisible();
    const closed = await caret.evaluate((el) => getComputedStyle(el).transform);
    expect(closed, 'rotated while shut').not.toBe('none');

    await page.locator('details.settings-disclosure > summary').click();
    await expect.poll(() => caret.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  });

  test('The collapsed pane fits a phone without scrolling sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(cohort(page)).toBeVisible();
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'the cohort card must wrap, not push the page wide').toBeLessThanOrEqual(1);
  });
});
