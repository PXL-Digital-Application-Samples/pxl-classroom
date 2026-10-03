// 38 - The edges of WS5 (ARCHITECTURE §10.1.1)
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
  chooseState,
} from '../fixtures/e2e-fixtures.mjs';

const A = 'linux-processes-2026';
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
    invite_key: inviteToken(ORG, id),
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

// The form's sections, always open since the "Edit settings" fold went
// (2026-10-03). Specs that once checked the fold opened now check this shows.
const details = (page) => page.locator('.settings-fields');

// "What the cohort card will and will not claim" and "The countdown at its
// edges" lived here. The editor's cohort card (accepted / cap / time left)
// went when the editor became the assignment page's Settings tab
// (BETA-UX.md, 2026-10-03): the page's own header and Progress tab say both,
// from the report they read themselves, one tab away.
// ==================================== leaving an assignment's settings

// "Nothing leaks from one assignment to the next" lived here: the editor sat
// beside a list of every assignment and stayed mounted while the lecturer
// clicked from one to another, so a collapsed disclosure, a cohort card or a
// "moved" pointer could outlive the assignment it belonged to. The editor is
// each assignment's Settings tab now (BETA-UX.md, 2026-10-02) and there is no
// list beside it: reaching another assignment's settings leaves this page, so
// nothing on it survives to leak. What still matters on the way out is an
// edit the lecturer has not saved.
test.describe('38 - Unsaved settings: kept across tabs, asked about on the way out', () => {
  test('Looking at another tab keeps the edit, and asks nothing', async ({ page }) => {
    // Settings is a tab of the assignment page (BETA-UX.md, 2026-10-03); the
    // editor stays mounted while the lecturer glances at Progress.
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry({ accepted: 47 }) }) } },
    });
    await expandSettings(page);
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Edited but not saved');

    const asked = []
    page.on('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
    await page.locator('.assignment-tabs .primer-tab', { hasText: /^Progress$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${A}$`));
    // /^Settings/, not /^Settings$/: with an edit waiting the tab also says so
    // ("Settings (unsaved changes)" to a screen reader, a dot on screen).
    await page.locator('.assignment-tabs .primer-tab', { hasText: /^Settings/ }).click();

    expect(asked, 'switching tabs is not leaving').toEqual([]);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Edited but not saved');
    await expect(details(page)).toBeVisible();
  });

  test('Leaving the assignment asks, and a dismissed prompt keeps the edit', async ({ page }) => {
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry({ accepted: 47 }) }) } },
    });
    await expandSettings(page);
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Edited but not saved');

    page.on('dialog', (d) => d.dismiss());
    await page.getByRole('navigation', { name: 'Course views' }).getByRole('link', { name: 'Roster', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/dashboard/${ORG}/${A}\\?tab=settings$`));
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Edited but not saved');
  });
});

// ============================================ transitions change which layout applies

test.describe('38 - A state transition changes the layout under the lecturer', () => {
  test('Stopping acceptance keeps the form, and is not offered again', async ({ page }) => {
    const contentWrites = [];
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { contentWrites, reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    page.on('dialog', (d) => d.accept());
    await chooseState(page, 'Stop accepting');

    await expect(page.locator('[data-state-menu]')).toContainText('Closed', { timeout: 15000 });
    await expect(details(page)).toBeVisible();
    await page.locator('[data-state-menu]').click();
    await expect(page.locator('.state-menu'), 'and it is not offered again').not.toContainText('Stop accepting');
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
    await chooseState(page, 'Archive');

    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-state-menu]').click();
    await expect(page.locator('.state-menu'), 'and it is not offered again').not.toContainText('Archive');
  });

  test('Publishing a draft does not yank the form away', async ({ page }) => {
    // The lecturer was mid-form a second ago.
    const draft = assignment(A, { state: 'draft' });
    delete draft.invite_token;
    delete draft.invite_nonce;
    await open(page, { assignments: { [A]: draft } });
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();

    await page.getByRole('button', { name: /^Save & publish$/ }).click();

    await expect(page.locator('[data-state-menu]')).toContainText('Accepting', { timeout: 15000 });
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026'), 'the form the lecturer was in stays open')
      .toBeVisible();
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
    // Reopening is a transition, so it is on the state button, named for what it does.
    await page.locator('[data-state-menu]').click();
    await expect(page.locator('.state-menu .dropdown-item-title', { hasText: /^Reopen for acceptance$/ })).toBeVisible();
  });

  test('Reopening says what it does, and dismissing dispatches nothing', async ({ page }) => {
    const workflowDispatches = [];
    await open(page, {
      assignments: { [A]: assignment(A, { state: 'closed' }) },
      extra: { workflowDispatches, reports: { dashboard: dashboardDoc({ [A]: entry({ state: 'closed' }) }) } },
    });

    const seen = [];
    page.on('dialog', (d) => { seen.push(d.message()); d.dismiss(); });
    await chooseState(page, 'Reopen for acceptance');

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
    await page.locator('[data-state-menu]').click();
    await expect(page.locator('.state-menu .dropdown-item-title', { hasText: /^Reopen for acceptance$/ })).toBeVisible();
  });

  test('Past the deadline it is not offered, and moving the deadline is', async ({ page }) => {
    // Every acceptance after the deadline is refused as too late, and a
    // publish of an assignment that was locked at its deadline is refused
    // outright - so "Reopen" there would be a control that cannot do what it
    // says (DESIGN.md §1.5).
    const past = new Date(Date.now() - 86400_000).toISOString();
    await open(page, { assignments: { [A]: assignment(A, { state: 'closed', deadline_at: past }) } });
    await page.locator('[data-state-menu]').click();
    await expect(page.locator('.state-menu')).not.toContainText('Reopen for acceptance');
    await page.locator('.state-menu .dropdown-item-title', { hasText: /^Move the deadline/ }).click();
    await expect(page.locator('#settings-schedule')).toBeInViewport();
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
    await expect(details(page)).toBeVisible();
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
    await expect(details(page)).toBeVisible();
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
    await expect(details(page)).toBeVisible();
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

test.describe('38 - Save without touching a field', () => {
  test('One click rebuilds the whole document, losing nothing', async ({ page }) => {
    // buildDoc reconstructs the YAML field by field, so anything it does not
    // carry through is deleted. Everything the assignment had must still be
    // there after a Save nobody edited anything for.
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
    await expect(details(page)).toBeVisible();

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

// The keyboard and marker tests for the "Edit settings" fold went with the fold
// (2026-10-03). What is left of this describe is the width check.
test.describe('38 - The settings pane on a phone', () => {
  test('It fits a phone without scrolling sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page, {
      assignments: { [A]: assignment(A) },
      extra: { reports: { dashboard: dashboardDoc({ [A]: entry() }) } },
    });
    await expect(details(page)).toBeVisible();
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'the cohort card must wrap, not push the page wide').toBeLessThanOrEqual(1);
  });
});
