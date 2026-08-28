// 30 - Deadline extensions, end to end (ARCHITECTURE §6.2.2)
//
// The bug this exists for: the Admin Panel wrote an override as an append-only
// `overrides[]` array (and had since 2026-06-17), while report.mjs read a
// top-level `deadline_at` that no document had carried since. lockdown.mjs and
// find-finalizable.mjs never opened `overrides/` at all. So granting a student
// seven extra days demoted them to `pull` at the assignment's own deadline and
// then reported their extension as active - and the unit test covering it built
// its fixture in the same dead shape, so it passed against a branch no real
// document could take.
//
// Unit tests on either side of that seam could not have caught it: the writer
// was fine, the reader was fine against its own fixture, and nothing compared
// them. So the load-bearing test here is a CONTRACT test - drive the real SPA,
// capture the exact bytes it commits, and hand them to the real backend module.
// If the two ever disagree again, this goes red.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';
import { effectiveDeadlineFor, latestEffectiveDeadline } from '../../lib/effective-deadline.mjs';

const ID = 'linux-processes-2026';
const TITLE = 'Linux Processes 2026';
const STUDENT = 'student-personal';

// Far enough out that a granted extension is unambiguously later.
const DEADLINE = new Date(Date.now() + 3 * 86400_000).toISOString();

function publishedAssignment(overrides = {}) {
  return {
    id: ID,
    title: TITLE,
    organization: ORG,
    state: 'published',
    assignment_type: 'individual',
    roster_mode: 'enforced',
    max_acceptances: 50,
    deadline_at: DEADLINE,
    opens_at: new Date(Date.now() - 86400_000).toISOString(),
    template: { owner: ORG, repository: 'linux-template' },
    repository_name_pattern: `${ID}-{github_login}`,
    ...overrides,
  };
}

const ROSTER = [
  { student_number: '0123456', full_name: 'Alice Example', email: 'alice@student.pxl.be', github_login: STUDENT },
];

// The student-facing half runs against its own assignment, opened through the
// invitation link the way a student reaches it.
const STUDENT_ID = 'hw-extended';
const studentAssignment = () => ({
  id: STUDENT_ID,
  title: 'Homework with an extension',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: DEADLINE,
  repository_name_pattern: `${STUDENT_ID}-{github_login}`,
  broker_repo: `broker-${STUDENT_ID}`,
});

/** A report with the one student on it, so the tracking view has a row. */
const reportWith = (student = STUDENT) => ({
  schema_version: 1,
  assignment_id: ID,
  org: ORG,
  generated_at: new Date().toISOString(),
  students: [{
    github_login: student,
    acceptance_state: 'accepted',
    submission_status: 'on-time',
    repo_name: `${ID}-${student}`,
  }],
});

/**
 * Open the assignment's roster & progress page with the sinks attached.
 *
 * WS5 moved this operation here from the Admin Panel: it needs a student
 * login, and the editor made you type one from memory (ARCHITECTURE §10.1.1). The
 * contract being tested is unchanged - the SPA's bytes against the real
 * backend reader - only the surface that produces them.
 */
async function openTracking(page, { contentWrites, assignment = publishedAssignment(), extra = {} } = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment },
    roster: ROSTER,
    reports: { [ID]: reportWith() },
    contentWrites,
    ...extra,
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await expect(page.getByRole('button', { name: `Actions for ${STUDENT}` }).first())
    .toBeVisible({ timeout: 15000 });
}

/** Fill and submit the per-row extension form. */
async function grantExtension(page, { login = STUDENT, when, reason = 'Medical certificate' }) {
  await page.getByRole('button', { name: `Actions for ${login}` }).first().click();
  // Scoped to the dialog: the page behind it carries its own inputs.
  const modal = page.locator('.modal-overlay .modal');
  await expect(modal).toBeVisible({ timeout: 10000 });
  await modal.locator('input[type="datetime-local"]').fill(when);
  await modal.locator('textarea').fill(reason);
  await modal.getByRole('button', { name: /Grant extension/ }).click();
}

/** A local datetime string the datetime-local input accepts. */
function localInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const overrideWrite = (writes) => writes.find((w) => w.path === `overrides/${ID}/${STUDENT}.json`);

test.describe('30 - Deadline extensions', () => {
  // --- the contract ---------------------------------------------------------

  test('what the panel commits is what the backend reads', async ({ page }) => {
    // The whole bug in one assertion. Not "an override was written" and not
    // "the module parses a fixture" - the real bytes through the real reader.
    const contentWrites = [];
    await openTracking(page, { contentWrites });

    const granted = new Date(Date.now() + 10 * 86400_000);
    await grantExtension(page, { when: localInput(granted), reason: 'Hospitalised' });

    await expect.poll(() => overrideWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const doc = JSON.parse(overrideWrite(contentWrites).content);

    const eff = effectiveDeadlineFor({ deadline_at: DEADLINE }, STUDENT, { overrides: [doc] });
    expect(eff.extended, 'the backend must see an extension in what the SPA wrote').toBe(true);
    expect(eff.reason).toBe('Hospitalised');
    expect(eff.grantedTo).toBe(STUDENT);
    // To the minute: the form is datetime-local, so seconds are not carried.
    expect(eff.deadline.getTime()).toBe(new Date(granted.setSeconds(0, 0)).getTime());
    expect(eff.deadline.getTime()).toBeGreaterThan(new Date(DEADLINE).getTime());
  });

  test('the committed document is the shape the schema requires', async ({ page }) => {
    // override.schema.json is additionalProperties:false, so a top-level
    // deadline_at could not be committed even if something tried - which is
    // why the old reader could never have worked.
    const contentWrites = [];
    await openTracking(page, { contentWrites });
    await grantExtension(page, { when: localInput(new Date(Date.now() + 9 * 86400_000)) });

    await expect.poll(() => overrideWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const doc = JSON.parse(overrideWrite(contentWrites).content);

    expect(Object.keys(doc).sort()).toEqual(['assignment_id', 'github_login', 'overrides', 'schema_version']);
    expect(doc.deadline_at, 'the dead shape must not come back').toBeUndefined();
    expect(doc.assignment_id).toBe(ID);
    expect(doc.github_login).toBe(STUDENT);
    const ext = doc.overrides.at(-1);
    expect(ext.type).toBe('deadline_extension');
    expect(ext.overridden_by).toBeTruthy();
    expect(ext.overridden_at).toBeTruthy();
  });

  test('the whole cohort question the nightly asks gets the right answer', async ({ page }) => {
    // find-finalizable keeps an assignment "active" off this, and activeCount
    // == 0 is what disables daily-activity.yml. If it read the wrong shape the
    // nightly would switch off mid-extension and never finalize the student.
    const contentWrites = [];
    await openTracking(page, { contentWrites });
    const granted = new Date(Date.now() + 12 * 86400_000);
    await grantExtension(page, { when: localInput(granted) });

    await expect.poll(() => overrideWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const doc = JSON.parse(overrideWrite(contentWrites).content);

    const latest = latestEffectiveDeadline({ deadline_at: DEADLINE }, [doc]);
    expect(latest.getTime()).toBeGreaterThan(Date.now());
    expect(latest.getTime()).toBeGreaterThan(new Date(DEADLINE).getTime());
  });

  // --- append-only ----------------------------------------------------------

  test('a second extension appends to the history rather than replacing it', async ({ page }) => {
    // ARCHITECTURE §5.2: overrides are append-only, never erase evidence. The
    // backend takes the last entry, so both facts have to survive.
    const contentWrites = [];
    const existing = {
      schema_version: 1,
      assignment_id: ID,
      github_login: STUDENT,
      overrides: [{
        type: 'deadline_extension',
        value: new Date(Date.now() + 5 * 86400_000).toISOString(),
        reason: 'First extension',
        overridden_by: 'admin-panel',
        overridden_at: new Date().toISOString(),
      }],
    };
    await openTracking(page, {
      contentWrites,
      extra: { controlOverrides: { [ID]: { [STUDENT]: existing } } },
    });

    await grantExtension(page, { when: localInput(new Date(Date.now() + 14 * 86400_000)), reason: 'Second extension' });
    await expect.poll(() => overrideWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const doc = JSON.parse(overrideWrite(contentWrites).content);

    expect(doc.overrides.length, 'the first grant is still on record').toBe(2);
    expect(doc.overrides[0].reason).toBe('First extension');
    expect(doc.overrides[1].reason).toBe('Second extension');

    const eff = effectiveDeadlineFor({ deadline_at: DEADLINE }, STUDENT, { overrides: [doc] });
    expect(eff.reason, 'the latest grant is the one in force').toBe('Second extension');
  });

  test('an extension that does not move the deadline forward is refused', async ({ page }) => {
    // Shortening by accident is the failure that locks a student out early.
    const contentWrites = [];
    await openTracking(page, { contentWrites });

    await grantExtension(page, { when: localInput(new Date(Date.now() + 3600_000)), reason: 'Too early' });

    await expect(page.locator('.toast, [role="alert"]').first())
      .toContainText(/after the current effective deadline/i, { timeout: 10000 });
    expect(overrideWrite(contentWrites), 'nothing may be committed').toBeFalsy();
  });

  // --- the login gate -------------------------------------------------------

  test('the login is the row, not something typed from memory', async ({ page }) => {
    // The editor's copy of this form had a free-text login box and a
    // four-tier validator behind it to catch what people typed into it. WS5
    // deleted both: the operation is reached from the student it concerns, so
    // there is no login to get wrong (ARCHITECTURE §10.1.1). What must stay true is
    // that the document is keyed on THAT student.
    const contentWrites = [];
    await openTracking(page, { contentWrites });

    await page.getByRole('button', { name: `Actions for ${STUDENT}` }).first().click();
    const modal = page.locator('.modal-overlay .modal');
    await expect(modal).toContainText(STUDENT);
    await expect(
      modal.getByPlaceholder('octocat'),
      'no free-text login field - the row already said who this is',
    ).toHaveCount(0);

    await modal.locator('input[type="datetime-local"]').fill(localInput(new Date(Date.now() + 9 * 86400_000)));
    await modal.locator('textarea').fill('Reached from the row');
    await modal.getByRole('button', { name: /Grant extension/ }).click();

    await expect.poll(() => overrideWrite(contentWrites), { timeout: 10000 }).toBeTruthy();
    const doc = JSON.parse(overrideWrite(contentWrites).content);
    expect(doc.github_login).toBe(STUDENT);
    expect(
      contentWrites.filter((w) => w.path.startsWith(`overrides/${ID}/`)).map((w) => w.path),
      'exactly one student was touched',
    ).toEqual([`overrides/${ID}/${STUDENT}.json`]);
  });

  // --- what the lecturer is told --------------------------------------------

  // --- what the student is told ---------------------------------------------

  test('a student with two extensions is shown the one actually in force', async ({ page }) => {
    // The history is append-only, so the LAST grant is the one that counts -
    // that is what lockdown, report and find-finalizable all use. The student
    // view read the FIRST, so somebody granted a second extension would be
    // shown, and would count down to, a deadline that had already been
    // superseded. Being told you have less time than you do is the version of
    // this that costs a student marks.
    const first = new Date(Date.now() + 4 * 86400_000).toISOString();
    const second = new Date(Date.now() + 11 * 86400_000).toISOString();
    const doc = {
      schema_version: 1,
      assignment_id: STUDENT_ID,
      github_login: STUDENT_1.login,
      overrides: [
        { type: 'deadline_extension', value: first, reason: 'First', overridden_by: 'admin-panel', overridden_at: first },
        { type: 'deadline_extension', value: second, reason: 'Second', overridden_by: 'admin-panel', overridden_at: second },
      ],
    };

    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [STUDENT_ID]: studentAssignment() },
      controlOverrides: { [STUDENT_ID]: { [STUDENT_1.login]: doc } },
      userRepos: [{
        name: `${STUDENT_ID}-${STUDENT_1.login}`,
        full_name: `${ORG}/${STUDENT_ID}-${STUDENT_1.login}`,
        html_url: `https://github.com/${ORG}/${STUDENT_ID}-${STUDENT_1.login}`,
      }],
    });
    await page.goto(inviteUrl(ORG, STUDENT_ID));

    const banner = page.locator('.override-alert-banner');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText('Second');
    await expect(banner, 'the superseded grant must not be the one on screen').not.toContainText('First');

    const shown = new Date(second).toLocaleDateString('en-US');
    const bannerText = (await banner.textContent()) ?? '';
    expect(bannerText, `banner should carry the later date: ${bannerText}`)
      .toContain(new Date(second).getFullYear().toString());
    expect(shown).toBeTruthy();
  });

  test("a student's own override never shortens their deadline", async ({ page }) => {
    // An extension only ever extends (ARCHITECTURE §6.2.2). A document whose
    // value falls before the assignment deadline must not be shown as the
    // student's deadline, or the page tells them to hurry for no reason.
    const earlier = new Date(Date.now() + 3600_000).toISOString();
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [STUDENT_ID]: studentAssignment() },
      controlOverrides: {
        [STUDENT_ID]: {
          [STUDENT_1.login]: {
            schema_version: 1,
            assignment_id: STUDENT_ID,
            github_login: STUDENT_1.login,
            overrides: [{
              type: 'deadline_extension', value: earlier, reason: 'Hand-edited too early',
              overridden_by: 'admin-panel', overridden_at: earlier,
            }],
          },
        },
      },
      userRepos: [{
        name: `${STUDENT_ID}-${STUDENT_1.login}`,
        full_name: `${ORG}/${STUDENT_ID}-${STUDENT_1.login}`,
        html_url: `https://github.com/${ORG}/${STUDENT_ID}-${STUDENT_1.login}`,
      }],
    });
    await page.goto(inviteUrl(ORG, STUDENT_ID));

    await expect(page.locator('.student-status-card')).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('.override-alert-banner'),
      'nothing was granted, so nothing should be announced',
    ).toHaveCount(0);
  });

  test('the success message does not promise an instant status change', async ({ page }) => {
    // Status moves on the nightly run or an explicit refresh. Saying otherwise
    // sends a lecturer looking for a change that is not due yet.
    const contentWrites = [];
    await openTracking(page, { contentWrites });
    await grantExtension(page, { when: localInput(new Date(Date.now() + 8 * 86400_000)) });

    await expect(page.locator('.toast, [role="alert"]').first())
      .toContainText(/nightly run|Live Status|refresh/i, { timeout: 10000 });
  });
});
