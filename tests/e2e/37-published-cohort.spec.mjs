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
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
  expandSettings,
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

test.describe('37 - The published editor leads with the cohort', () => {
  test('Share and cohort come first; the settings are behind a disclosure', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });

    // The link is on screen without opening anything.
    await expect(page.locator('.invitation-share-banner')).toBeVisible();
    const cohort = page.locator('.cohort-card');
    await expect(cohort).toBeVisible();
    await expect(cohort).toContainText('47');
    await expect(cohort).toContainText('/ 150');
    await expect(cohort).toContainText('accepted');
    await expect(cohort.getByRole('link', { name: /Track roster & progress/i })).toBeVisible();

    // And the form is not.
    const details = page.locator('details.settings-disclosure');
    await expect(details).toHaveJSProperty('open', false);
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeHidden();

    // Which is a disclosure, not a wall: it opens.
    await details.locator('> summary').click();
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue(TITLE);
  });

  test('Only one Track link, not the same link twice', async ({ page }) => {
    // The banner carried its own `Track Roster & Progress` before the cohort
    // card existed. Two of them, stacked, is what "one action, one home" is
    // supposed to prevent.
    await openEditor(page, { extra: { reports: { dashboard: dashboard(3) } } });
    await expect(page.locator('.published-info-card.is-success')).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('link', { name: /Track roster (&|and) progress/i }),
    ).toHaveCount(1);
  });

  test('The countdown is the time left, and flips once the deadline passes', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    const cohort = page.locator('.cohort-card');
    await expect(cohort).toContainText('until the deadline');
    await expect(cohort).toContainText('6d 23h');

    const past = new Date(Date.now() - 2 * 86400_000).toISOString();
    await openEditor(page, {
      asgn: assignment({ deadline_at: past, opens_at: new Date(Date.now() - 9 * 86400_000).toISOString() }),
      extra: { reports: { dashboard: { ...dashboard(47), assignments: { [ID]: { ...dashboard(47).assignments[ID], deadline_at: past } } } } },
    });
    await expect(page.locator('.cohort-card')).toContainText('past the deadline');
    await expect(page.locator('.cohort-card')).toContainText('2d 0h');
  });

  test('A draft still opens on the form', async ({ page }) => {
    // Defining it IS the job there. The disclosure exists so there is one
    // markup path, but its summary must not be on screen.
    const draft = assignment({ state: 'draft' });
    delete draft.invite_token;
    delete draft.invite_nonce;
    await openEditor(page, { asgn: draft });

    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
    await expect(page.locator('.cohort-card')).toHaveCount(0);
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
    await page.getByRole('button', { name: /^Revert to draft$/ }).click();

    await expect(page.locator('.cohort-card')).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toBeVisible();
    await expect(page.locator('details.settings-disclosure > summary')).toBeHidden();
  });

  test('A closed assignment leads with the cohort too', async ({ page }) => {
    // The cohort is what a closed assignment still has; nobody opens one to
    // change its repository name pattern.
    await openEditor(page, {
      asgn: assignment({ state: 'closed' }),
      extra: { reports: { dashboard: { ...dashboard(47), assignments: { [ID]: { ...dashboard(47).assignments[ID], state: 'closed' } } } } },
    });
    await expect(page.locator('.cohort-card')).toBeVisible();
    await expect(page.locator('details.settings-disclosure')).toHaveJSProperty('open', false);
  });
});

// ================================================ the cohort card's honesty

test.describe('37 - The cohort card never invents a number', () => {
  test('No report yet is said, not rendered as zero accepted', async ({ page }) => {
    // Same rule as WS3's roster count: "the report has not run" and "nobody
    // has accepted" are different facts, and only one of them is a number.
    await openEditor(page);
    const cohort = page.locator('.cohort-card');
    await expect(cohort).toContainText('no cohort report yet');
    await expect(cohort).toContainText('—');
    await expect(cohort, 'a zero here would be a claim nobody made').not.toContainText('0 / 150');
  });

  test('An unreadable report is distinguished from an absent one', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      userRepos: [{ name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}` }],
    });
    await page.route('**/pxl-classroom-control/contents/reports/dashboard.json*', async (route) => {
      await route.fulfill({ status: 500, body: JSON.stringify({ message: 'boom' }) });
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);

    await expect(page.locator('.cohort-card')).toContainText("couldn't read the cohort report", {
      timeout: 15000,
    });
  });

  test('An assignment with no cap shows no cap', async ({ page }) => {
    // `?? 150` published a cap the assignment did not have and told students
    // registration was full. The card must not reintroduce it.
    const uncapped = assignment();
    delete uncapped.max_acceptances;
    await openEditor(page, { asgn: uncapped, extra: { reports: { dashboard: dashboard(212) } } });

    const cohort = page.locator('.cohort-card');
    await expect(cohort).toContainText('212');
    await expect(cohort).toContainText('accepted');
    await expect(cohort, 'no cap means no denominator').not.toContainText('/');
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
    await page.getByPlaceholder('linux-processes-{github_login}').fill('no-placeholder-here');
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

  test('And the lecturer who knew the accordions is told where they went', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });
    const moved = page.locator('.lifecycle-moved');
    await expect(moved).toContainText('Per-student extensions and retries');
    await expect(moved.getByRole('link', { name: /roster & progress/i })).toHaveAttribute(
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
          schema_version: 1, assignment_id: ID, org: ORG, generated_at: new Date().toISOString(),
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
});

// ======================================================== the lifecycle

test.describe('37 - Lifecycle groups repair above state', () => {
  test('Repair is its own group, above the transitions', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });

    const repair = page.locator('.lifecycle-repair');
    await expect(repair).toContainText('Repair');
    await expect(repair.getByRole('button', { name: /Republish broker/i })).toBeVisible();
    await expect(repair, 'a repair must promise not to break live links')
      .toContainText('links already handed out keep working');

    const transitions = page.locator('.lifecycle-transitions');
    await expect(transitions.getByRole('button', { name: /^Stop accepting$/ })).toBeVisible();
    await expect(transitions.getByRole('button', { name: /^Revert to draft$/ })).toBeVisible();
    await expect(transitions.getByRole('button', { name: /^Archive$/ })).toBeVisible();
    // Republish is NOT a transition.
    await expect(transitions.getByRole('button', { name: /Republish/i })).toHaveCount(0);

    const repairBox = await repair.boundingBox();
    const transBox = await transitions.boundingBox();
    expect(repairBox.y).toBeLessThan(transBox.y);
  });

  test('A draft has nothing to repair, and Publish sits with the transitions', async ({ page }) => {
    const draft = assignment({ state: 'draft' });
    delete draft.invite_token;
    await openEditor(page, { asgn: draft });

    await expect(page.locator('.lifecycle-repair')).toHaveCount(0);
    await expect(
      page.locator('.lifecycle-transitions').getByRole('button', { name: /Publish \(create broker/i }),
    ).toBeVisible();
  });

  test('Stopping the cohort names the consequence before it happens', async ({ page }) => {
    await openEditor(page, { extra: { reports: { dashboard: dashboard(47) } } });

    const seen = [];
    page.on('dialog', (d) => { seen.push(d.message()); d.dismiss(); });
    await page.getByRole('button', { name: /^Stop accepting$/ }).click();
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
    await page.getByRole('button', { name: /^Revert to draft$/ }).click();
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

  test('With nothing open, New assignment is the one', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await expect(page.locator('.assignment-list li').first()).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate(VISIBLE_PRIMARIES)).toEqual(['New assignment']);
  });

  test('A draft editor is one too, and it is Save & publish', async ({ page }) => {
    const draft = assignment({ state: 'draft' });
    delete draft.invite_token;
    await openEditor(page, { asgn: draft });
    expect(await page.evaluate(VISIBLE_PRIMARIES)).toEqual(['Save & publish']);
  });
});
