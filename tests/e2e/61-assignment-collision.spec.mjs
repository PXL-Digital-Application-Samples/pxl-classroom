// 61 - Creating an assignment that would land on top of an existing one.
//
// Deleting an assignment keeps three things on purpose: the evidence under
// `retired/<id>/`, the archive repository, and every student repository. That
// is the feature - nobody's work is destroyed. It also means a name can be
// occupied afterwards, and the case where a lecturer reaches for the same one
// is exactly the case where the students are the same people: a resit, a
// retake, a lab run again.
//
// But the id is NOT the collision key. `repository_name_pattern` is, and it is
// a separate field pointing anywhere - so `lab-3-v2` with the pattern
// `lab-3-{github_login}` collides while looking like a new assignment, and
// `lab-3` recreated with a fresh pattern does not collide at all.
// lib/seed-teams.mjs has said so since it was written; nothing enforced it.
//
// TWO things block, and one NOTES - which is the distinction this spec has to
// hold, because it changed on 2026-09-09 and the reason is not obvious:
//
//   - provision.mjs hands a returning student their OLD repository back
//     (`alreadyExists ? existing.data`) - last year's work, and none of this
//     year's starter code. This is the one that stopped blocking. The screen
//     knows the pattern and the organization's repository listing and cannot
//     know WHO WILL ACCEPT, so "300 repositories exist" and "a student in this
//     cohort would be handed one" are different statements - and a real course
//     was refused over 300 portfolios from previous years of which perhaps two
//     mattered, with "delete 300 students' repositories" offered as one of two
//     ways forward. The judgement is `acceptance/accept.mjs` step 7 now, where
//     both halves are known, and this screen asks what to do about it instead.
//   - two assignments sharing a pattern do that to each other, from the first
//     acceptance. Still blocks: it is fully answerable here (both assignments
//     are on screen) and acceptance cannot see it at all, because the
//     repository does not exist yet for step 7 to find.
//   - preserve.mjs pushes `refs/heads/preserved/<id>/<login>` WITHOUT --force
//     on purpose. A kept archive still holds that ref, so the new snapshot is a
//     non-fast-forward and is rejected - for every returning student, at the
//     moment the whole deadline flow exists to protect.
//
// And one thing that must NOT block, which is half of what this spec is for: an
// assignment opened by mistake and deleted before anybody joined leaves a
// `retired/<id>/` record of nothing. "I changed my mind, nobody joined, let me
// start over with the same name" is an ordinary Tuesday.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const ID = 'lab-3';
const ARCHIVE = `pxl-classroom-archive-${ID}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

const manifest = (over = {}) => ({
  schema_version: 1,
  assignment_id: ID,
  deleted_at: '2026-09-04T10:00:00Z',
  deleted_by: LECTURER.login,
  organization: ORG,
  preserved_submissions: 6,
  ...over,
});

const liveAssignment = (id, pattern, over = {}) => ({
  schema_version: 1,
  id,
  title: id,
  organization: ORG,
  template: { owner: ORG, repository: 'starter-template' },
  repository_name_pattern: pattern,
  opens_at: '2026-09-01T08:00:00Z',
  deadline_at: '2026-09-20T20:00:00Z',
  state: 'draft',
  assignment_type: 'individual',
  max_acceptances: 50,
  ...over,
});

/**
 * Stage the organization and open the Admin Panel.
 *
 * Routes are registered AFTER setupStandardMockRoutes so they win: Playwright
 * matches most-recently-added first.
 *
 * @param {object} o
 * @param {string[]} [o.orgRepos]   names GET /orgs/<org>/repos answers with
 * @param {object|null} [o.retired] `retired/<id>/manifest.json`, or null
 * @param {boolean} [o.archive]     does the archive repository exist
 * @param {object} [o.assignments]  live assignments in the control repo
 * @param {number} [o.retiredStatus] non-200 to make the record unreadable
 * @param {number|null} [o.archiveStatus] non-null to make the archive probe fail
 * @param {number|null} [o.orgReposStatus] non-null to make the org listing fail
 */
async function openAdmin(page, {
  orgRepos = [],
  retired = null,
  retiredRaw = null,
  archive = false,
  assignments = {},
  retiredStatus = 200,
  archiveStatus = null,
  orgReposStatus = null,
} = {}) {
  const writes = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments, contentWrites: writes });

  await page.route('**/orgs/*/repos*', (route) =>
    orgReposStatus !== null
      ? route.fulfill({ status: orgReposStatus, contentType: 'application/json', body: JSON.stringify({ message: 'Server Error' }) })
      : route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(orgRepos.map((name) => ({ name, full_name: `${ORG}/${name}` }))),
      }));

  await page.route(`**/contents/retired/${ID}/manifest.json*`, (route) => {
    if (retiredStatus !== 200) {
      return route.fulfill({ status: retiredStatus, contentType: 'application/json', body: JSON.stringify({ message: 'Server Error' }) });
    }
    if (retiredRaw !== null) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: Buffer.from(retiredRaw).toString('base64'), encoding: 'base64' }) });
    }
    if (!retired) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: b64(retired), encoding: 'base64' }) });
  });

  await page.route(`**/repos/${ORG}/${ARCHIVE}`, (route) => {
    if (archiveStatus !== null) {
      return route.fulfill({ status: archiveStatus, contentType: 'application/json', body: JSON.stringify({ message: 'Bad gateway' }) });
    }
    return archive
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ full_name: `${ORG}/${ARCHIVE}`, name: ARCHIVE }) })
      : route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) });
  });

  await page.goto(`/dashboard/${ORG}/admin`);
  return writes;
}

/** Start a new assignment and fill it to where Save as draft is enabled. */
async function fillNew(page, { title = 'Lab 3', slug = ID, pattern = null, opensAt = null } = {}) {
  await page.locator('.new-btn').click();
  await page.getByPlaceholder('e.g. Linux Processes 2026').fill(title);
  await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
  if (opensAt) {
    // The suggested name is derived from the OPENING date, so a test that
    // asserts one must fix it rather than inherit the wall clock.
    await page.locator('input[type="datetime-local"]').first().fill(opensAt);
  }
  // The slug is a DERIVED LINE now, not a box: it is filled in from the title,
  // it is locked after creation and it is not in the student's invitation link,
  // so the form states it rather than asking for it. Overriding one is still
  // possible and is what these tests do, so they take the same route a lecturer
  // would - press Edit first.
  const slugInput = await openSlug(page);
  await slugInput.fill(slug);
  if (pattern !== null) {
    await page.getByPlaceholder('linux-processes-{github_login}').fill(pattern);
  }
  await slugInput.focus();
  await slugInput.blur();
  return slugInput;
}

/** Reveal the slug input, whether or not it is already open. */
async function openSlug(page) {
  const input = page.getByPlaceholder('linux-processes-2026');
  if (await input.count() === 0) await slugField(page).getByRole('button', { name: 'Edit' }).click();
  return input;
}

const saveDraft = (page) => page.getByRole('button', { name: 'Save as draft' }).first();
const slugField = (page) => page.locator('.field:has(.derived-line)');
/** Where the verdict is rendered: the pattern IS the collision key. */
const patternField = (page) => page.locator('.field:has(label:text-matches("^Repository name pattern"))');
const refusal = (page) => patternField(page).locator('.field-error-msg');
const note = (page) => patternField(page).locator('.collision-note');

/** The dialog Save raises when the organization already holds matching names. */
const reposModal = (page) => page.locator('.modal-existing-repos');

/**
 * Save, and answer the dialog if it opens.
 *
 * `answer` is 'reuse', 'refuse', or null to cancel. It waits a beat rather than
 * for the dialog, because "it did not open" is a real and frequently asserted
 * outcome here - waiting for a locator that must not appear is how an absence
 * assertion becomes a timeout, and the caller checks `.count()` itself.
 */
async function saveAnswering(page, answer, button = 'Save as draft') {
  await page.getByRole('button', { name: button }).first().click();
  const modal = reposModal(page);
  await page.waitForTimeout(400);
  if (await modal.count() === 0) return false;
  if (answer === null) {
    await modal.getByRole('button', { name: 'Cancel' }).click();
  } else {
    await modal.locator(`input[value="${answer}"]`).check();
    await modal.getByRole('button', { name: button }).click();
  }
  return true;
}

async function expectNoWrite(page, writes) {
  await saveDraft(page).click();
  await page.waitForTimeout(300);
  expect(writes.filter((w) => w.path.startsWith('assignments/'))).toHaveLength(0);
}

// ---------------------------------------------------------------------------

test.describe('the name is free', () => {
  test('an org with nothing in it saves', async ({ page }) => {
    const writes = await openAdmin(page, { orgRepos: ['pxl-classroom-control', 'starter-template'] });
    await fillNew(page);
    await expect(refusal(page)).toHaveCount(0);
    await expect(note(page)).toHaveCount(0);

    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('THE CASE THAT MUST WORK: deleted before anybody joined, recreated by the same name', async ({ page }) => {
    // The delete writes retired/<id>/manifest.json unconditionally, so a record
    // exists for an assignment that never had a single repository. Refusing
    // this would refuse "I changed my mind and started over".
    const writes = await openAdmin(page, {
      orgRepos: ['pxl-classroom-control'],
      retired: manifest({ preserved_submissions: 0 }),
      archive: false,
    });
    await fillNew(page);

    await expect(refusal(page)).toHaveCount(0);
    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('…and it says so, in the muted voice, rather than saying nothing', async ({ page }) => {
    // Recreating the id means a later delete overwrites that record. Worth
    // knowing, not worth refusing - so it is a note, not an error.
    await openAdmin(page, {
      orgRepos: [],
      retired: manifest({ preserved_submissions: 0 }),
    });
    await fillNew(page);

    const n = note(page);
    await expect(n).toBeVisible();
    await expect(n).toContainText('Nothing is in the way');
    await expect(n).toContainText(`retired/${ID}/`);
    await expect(n).toContainText(/overwrite/i);
    await expect(refusal(page)).toHaveCount(0);
  });

  test('THE CLEANUP CASE: archive and repositories deleted by hand frees the name', async ({ page }) => {
    // The check asks what EXISTS. A lecturer who did the cleanup is believed.
    const writes = await openAdmin(page, {
      orgRepos: ['pxl-classroom-control'],
      retired: manifest({ preserved_submissions: 6 }),
      archive: false,
    });
    await fillNew(page);
    await expect(refusal(page)).toHaveCount(0);
    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('a repository whose name merely starts the same way is not a collision', async ({ page }) => {
    const writes = await openAdmin(page, {
      orgRepos: ['lab-30-alice', 'lab-3', 'lab-3-'],
    });
    await fillNew(page);
    await expect(refusal(page)).toHaveCount(0);
    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('the same id with a DIFFERENT pattern is free', async ({ page }) => {
    // The id is not the collision key. Reusing it over a fresh namespace is
    // fine, and this is the escape hatch the refusal points at.
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice', 'lab-3-bob'] });
    await fillNew(page, { pattern: 'lab-3-2026-{github_login}' });
    await expect(refusal(page)).toHaveCount(0);
    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });
});

test.describe('the name is taken', () => {
  test('existing repositories say NOTHING on the form - they are not a refusal', async ({ page }) => {
    // It refused until 2026-09-09, over a question this screen cannot answer:
    // who will accept. A real course hit it with `portfolio-{github_login}` on
    // an org holding 300 portfolios from previous years, of which perhaps two
    // belonged to a student who would accept - and the two ways forward were
    // rename the assignment or delete 300 students' work.
    //
    // And nothing renders under the field either. One lecturer in the
    // deployment meets this; a permanent line asking the rest to notice it is
    // clutter for everyone and an answer for nobody.
    await openAdmin(page, { orgRepos: ['lab-3-alice', 'lab-3-bob', 'unrelated-repo'] });
    await fillNew(page);

    await expect(refusal(page)).toHaveCount(0);
    await expect(note(page)).toHaveCount(0);
  });

  test('…it is asked once, in a dialog Save opens', async ({ page }) => {
    await openAdmin(page, { orgRepos: ['lab-3-alice', 'lab-3-bob', 'unrelated-repo'] });
    await fillNew(page);
    await saveDraft(page).click();

    const modal = reposModal(page);
    await expect(modal).toBeVisible();
    // The count, the organization and the pattern - so a lecturer can tell
    // whether it is 300 of everybody's or two of theirs.
    await expect(modal).toContainText(`2`);
    await expect(modal).toContainText(ORG);
    await expect(modal).toContainText('lab-3-{github_login}');
    // Reuse pre-selected: it is what already happens, and a pair with neither
    // filled would ask a question the system has already answered.
    await expect(modal.locator('.policy-option.selected')).toContainText('Give them the existing repository');
    // BOTH outcomes named. "they get it back" alone asserts something the
    // system does not always do - a frozen repository refuses that student -
    // and it would be wrong in the case that matters most (DESIGN.md §1.5).
    await expect(modal).toContainText('locked by an earlier deadline is refused whichever you pick');
  });

  test('the confirming button echoes the one that was clicked', async ({ page }) => {
    // The dialog interrupts an action the lecturer asked for; offering a
    // differently-named one asks whether it still does what they clicked.
    await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page);
    await saveDraft(page).click();
    await expect(reposModal(page).getByRole('button', { name: 'Save as draft' })).toBeVisible();

    await reposModal(page).getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Save & publish' }).first().click();
    await expect(reposModal(page).getByRole('button', { name: 'Save & publish' })).toBeVisible();
  });

  test('choosing reuse saves, and records the answer', async ({ page }) => {
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice', 'lab-3-bob'] });
    await fillNew(page);
    expect(await saveAnswering(page, 'reuse')).toBe(true);

    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
    // RECORDED, and that is what makes not asking again honest rather than
    // forgetful: absent means "never came up", set means "asked, and this is
    // what they said".
    expect(writes.find((w) => w.path === `assignments/${ID}.yml`).content)
      .toContain('existing_repo_policy: reuse');
  });

  test('choosing refuse saves that instead', async ({ page }) => {
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page);
    expect(await saveAnswering(page, 'refuse')).toBe(true);

    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
    expect(writes.find((w) => w.path === `assignments/${ID}.yml`).content)
      .toContain('existing_repo_policy: refuse');
  });

  test('Cancel means cancel - nothing is written', async ({ page }) => {
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page);
    expect(await saveAnswering(page, null)).toBe(true);

    await page.waitForTimeout(300);
    expect(writes.filter((w) => w.path.startsWith('assignments/'))).toHaveLength(0);
  });

  test('a DIFFERENT id pointing at an occupied pattern is caught too', async ({ page }) => {
    // The whole reason the check is on the pattern rather than the id: this
    // looks like a brand new assignment and would hand out lab-3's
    // repositories. Still detected - it is the consequence that moved.
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page, { title: 'Lab 3 v2', slug: 'lab-3-v2', pattern: 'lab-3-{github_login}' });
    expect(await saveAnswering(page, 'reuse')).toBe(true);
    await expect.poll(() => writes.filter((w) => w.path === 'assignments/lab-3-v2.yml').length).toBe(1);
  });

  test('an answer given about ONE pattern is not reused for another', async ({ page }) => {
    // The ask-once rule keyed on the STORED pattern, which a new assignment does
    // not have yet - so between answering and the assignment existing, the
    // answer applied to whatever the pattern became. Reachable without anything
    // exotic: answer, have the commit fail, change the name, save again. The
    // second save recorded a decision about repositories nobody was shown.
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice', 'resit-bob'] });
    // Fail the first write only, so the editor stays open with the answer in it.
    let failed = false;
    await page.route('**/contents/assignments/**', async (route) => {
      if (route.request().method() !== 'PUT' || failed) return route.fallback();
      failed = true;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'boom' }) });
    });

    await fillNew(page);
    expect(await saveAnswering(page, 'refuse')).toBe(true);
    await expect.poll(() => failed).toBe(true);
    expect(writes.filter((w) => w.path.startsWith('assignments/'))).toHaveLength(0);

    // A different name, a different set of repositories, a question never asked
    // about them.
    const pat = page.getByPlaceholder('linux-processes-{github_login}');
    await pat.fill('resit-{github_login}');
    await pat.blur();
    expect(await saveAnswering(page, 'reuse'), 'it must ask again for the new pattern').toBe(true);
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
    expect(writes.find((w) => w.path === `assignments/${ID}.yml`).content)
      .toContain('existing_repo_policy: reuse');
  });

  test('Cancel records nothing, so the next save asks again', async ({ page }) => {
    // Cancelling is not an answer. If it counted as one, backing out of the
    // dialog would silently commit the pre-selected option on the next save -
    // a suggestion accepted by not answering it.
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page);
    expect(await saveAnswering(page, null)).toBe(true);
    expect(writes.filter((w) => w.path.startsWith('assignments/'))).toHaveLength(0);

    expect(await saveAnswering(page, 'refuse'), 'it must ask again').toBe(true);
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
    expect(writes.find((w) => w.path === `assignments/${ID}.yml`).content)
      .toContain('existing_repo_policy: refuse');
  });

  test('and once answered, saving again in the same session asks nothing', async ({ page }) => {
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page);
    expect(await saveAnswering(page, 'reuse')).toBe(true);
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Lab 3 renamed');
    expect(await saveAnswering(page, 'reuse'), 'a title edit is not a new question').toBe(false);
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(2);
  });

  test('nothing is asked where the name is free', async ({ page }) => {
    // A dialog over nothing is a question about nothing, and it would land on
    // every lecturer in the deployment rather than the one who meets this.
    const writes = await openAdmin(page, { orgRepos: ['pxl-classroom-control', 'starter-template'] });
    await fillNew(page);
    expect(await saveAnswering(page, 'reuse')).toBe(false, 'the dialog must not open');

    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
    // And nothing is recorded either: the question never came up, and writing
    // `reuse` anyway would turn silence into a decision - the tri-state trap
    // org_scoped_lock and template_grades both fell into.
    expect(writes.find((w) => w.path === `assignments/${ID}.yml`).content)
      .not.toContain('existing_repo_policy');
  });

  test('another LIVE assignment already using the pattern blocks, and is named', async ({ page }) => {
    // lib/seed-teams.mjs invariant 2, enforced for the first time.
    const writes = await openAdmin(page, {
      orgRepos: [],
      assignments: { 'lab-3-old': liveAssignment('lab-3-old', 'lab-3-{github_login}') },
    });
    await fillNew(page, { title: 'Lab 3 New', slug: 'lab-3-new', pattern: 'lab-3-{github_login}' });

    await expect(refusal(page)).toContainText('"lab-3-old" already uses this repository name pattern');
    await expectNoWrite(page, writes);
  });

  test('a clash through a different placeholder is caught, not just an identical string', async ({ page }) => {
    // `lab-3-{team_slug}` and `lab-3-{github_login}` produce one namespace.
    await openAdmin(page, {
      orgRepos: [],
      assignments: { 'lab-3-groups': liveAssignment('lab-3-groups', 'lab-3-{team_slug}') },
    });
    await fillNew(page, { title: 'Lab 3 Solo', slug: 'lab-3-solo', pattern: 'lab-3-{github_login}' });
    await expect(refusal(page)).toContainText('"lab-3-groups"');
  });

  test('a surviving archive blocks even when every repository is gone', async ({ page }) => {
    // The one that fails weeks later: preserve.mjs pushes without --force onto
    // a ref the archive still holds.
    const writes = await openAdmin(page, {
      orgRepos: ['pxl-classroom-control'],
      retired: manifest({ preserved_submissions: 6 }),
      archive: true,
    });
    await fillNew(page);

    await expect(refusal(page)).toContainText('6 preserved submissions');
    await expect(refusal(page)).toContainText(/preservation would fail at the new deadline/);
    await expectNoWrite(page, writes);
  });

  test('an archive with no record at all still blocks', async ({ page }) => {
    // retired/<id>/ is an ordinary file a lecturer can delete. Its absence is
    // not proof the run never happened.
    await openAdmin(page, { orgRepos: [], retired: null, archive: true });
    await fillNew(page);
    await expect(refusal(page)).toContainText('the archive still exists');
  });

  test('the refusal names every blocker at once, so one retry clears them all', async ({ page }) => {
    const writes = await openAdmin(page, {
      orgRepos: ['lab-3-alice'],
      retired: manifest(),
      archive: true,
      assignments: { 'lab-3-old': liveAssignment('lab-3-old', 'lab-3-{github_login}') },
    });
    await fillNew(page);

    const err = refusal(page);
    await expect(err).toContainText('"lab-3-old"');
    await expect(err).toContainText('the archive still exists');
    // TWO blockers now, not three. The existing repositories are a note, and
    // the retired record never blocked - the remedies say "delete the archive",
    // and nobody has to delete the evidence of the previous run or 300
    // students' repositories.
    await expect(err.locator('.collision-list').first().locator('li')).toHaveCount(2);
    await expect(err).not.toContainText(`retired/${ID}/`);
    await expect(err).not.toContainText('lab-3-alice');
    await expectNoWrite(page, writes);
  });

  test('the refusal names real options, and never points at the repo docs', async ({ page }) => {
    // A refusal that only says no gets routed around. DESIGN.md 1.6 - and a
    // lecturer is not the operator of this deployment.
    await openAdmin(page, { orgRepos: [], archive: true });
    await fillNew(page);
    const err = refusal(page);
    await expect(err).toContainText('What to do:');
    await expect(err.locator('.collision-ways li')).toHaveCount(2);
    await expect(err).toContainText('Recommended');
    await expect(err).toContainText('The name has to be different');
    await expect(err).toContainText('Delete the archive repository');
    await expect(err).not.toContainText(/RUNBOOK|ARCHITECTURE|LESSONS|DESIGN\.md/);
  });

  test('it names no replacement at all - not a composed name, not a year', async ({ page }) => {
    // Two goes at this, both wrong in the same direction. "2627-lab-3" is a
    // name nothing checked - it can be taken too - and "Add the academic year
    // - 2627" is the same defect one step back: nothing here knows THAT name
    // is free either, nor that the organization does not already encode the
    // year some other way. The requirement is stated instead.
    await openAdmin(page, { orgRepos: [], archive: true });
    await fillNew(page, { opensAt: '2026-09-21T06:00' });

    const ways = refusal(page).locator('.collision-ways li').first();
    await expect(ways).not.toContainText(/\d/);
    await expect(ways).not.toContainText(/academic/i);
    await expect(ways).not.toContainText(/never collides?/i);
    await expect(ways).toContainText('The name has to be different');
    await expect(ways).toContainText('put something in front of it');
    // And NOT "or suffix": a placeholder expands to `[A-Za-z0-9-]+`, so a
    // suffixed pattern is still inside the original's namespace and the clash
    // survives. Advice that sends a lecturer back into the same refusal.
    await expect(ways).not.toContainText(/suffix/);
  });

  test('deleting is not offered when there is nothing to delete', async ({ page }) => {
    // Only a pattern clash: nothing exists to remove, and offering it would
    // read as an invitation to remove something.
    await openAdmin(page, {
      orgRepos: [],
      assignments: { 'lab-3-old': liveAssignment('lab-3-old', 'lab-3-{github_login}') },
    });
    await fillNew(page, { title: 'Lab 3 New', slug: 'lab-3-new', pattern: 'lab-3-{github_login}' });

    const err = refusal(page);
    // One way forward, and it is not "delete": there is nothing to delete.
    await expect(err.locator('.collision-ways li')).toHaveCount(1);
    await expect(err).not.toContainText(/Delete/);
    // Nor "Recommended" - there is nothing to recommend it over.
    await expect(err).not.toContainText('Recommended');
    // The finding names the pattern, so the field to change is identified
    // without a second remedy saying the same thing as the first.
    await expect(err).toContainText('already uses this repository name pattern');
  });

  test('the delete option says what it costs, in the same breath', async ({ page }) => {
    await openAdmin(page, { orgRepos: [], archive: true, retired: manifest() });
    await fillNew(page);
    // What it destroys is the preserved submissions: the archive is the only
    // thing this option still deletes.
    await expect(refusal(page)).toContainText('destroys the preserved submissions');
  });

  test('matching is case-insensitive, because GitHub repository names are', async ({ page }) => {
    // `Lab-3-Alice` and `lab-3-alice` cannot both exist, so a case-sensitive
    // match would report a name free that cannot be created.
    await openAdmin(page, { orgRepos: ['Lab-3-Alice'] });
    await fillNew(page);
    await saveDraft(page).click();
    await expect(reposModal(page)).toContainText('1 repository');
  });

  test('a TEAM pattern is not asked about at all - the answer is fixed', async ({ page }) => {
    const writes = await openAdmin(page, { orgRepos: ['lab-3-team-alpha', 'lab-3-team-beta'] });
    await page.locator('.new-btn').click();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Lab 3');
    await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
    // The form only accepts a {team_slug} pattern on a group assignment.
    await page.locator('input[value="group"]').check();
    const pat = page.getByPlaceholder('linux-processes-{github_login}');
    await pat.fill('lab-3-{team_slug}');
    await pat.blur();
    await saveDraft(page).click();

    // TOLD, NOT ASKED. There is no choice to offer - a team slug names a team
    // rather than a student, so a repository already at that name belonged to a
    // DIFFERENT team and is refused at acceptance whatever anybody picks. But
    // it still has to be said: suppressing the question suppressed the warning
    // with it, and the lecturer only found out when the first team was turned
    // away mid-cohort.
    const modal = reposModal(page);
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('will be turned away');
    await expect(modal).toContainText('may be a previous team');
    // No radios: there is nothing to choose.
    await expect(modal.locator('.policy-option')).toHaveCount(0);

    await modal.getByRole('button', { name: 'Save as draft' }).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
    // And nothing is recorded, so the default keeps deciding.
    expect(writes.find((w) => w.path === `assignments/${ID}.yml`).content)
      .not.toContain('existing_repo_policy');
  });

  test('a team assignment that says reuse is not warned about a refusal that will not happen', async ({ page }) => {
    // The warning's whole sentence is "a team whose name matches will be turned
    // away", and that is false for an assignment whose YAML says `reuse`.
    // A warning that does not apply is DESIGN.md §1.5.
    const writes = await openAdmin(page, {
      assignments: { [ID]: liveAssignment(ID, `${ID}-{team_slug}`, { assignment_type: 'group', existing_repo_policy: 'reuse' }) },
      orgRepos: [`${ID}-team-alpha`],
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    const pat = page.getByPlaceholder('linux-processes-{github_login}');
    await pat.fill(`${ID}-v2-{team_slug}`);
    await pat.blur();

    expect(await saveAnswering(page, 'reuse'), 'no dialog for an explicit reuse').toBe(false);
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('a huge cohort is counted, not printed', async ({ page }) => {
    // 200 is the shape of the case this whole change is about: a number that
    // says nothing about how many of them belong to a student who will accept,
    // which is why it is one sentence at save and not a wall of names.
    await openAdmin(page, { orgRepos: Array.from({ length: 200 }, (_, i) => `lab-3-s${i}`) });
    await fillNew(page);
    await saveDraft(page).click();
    await expect(reposModal(page)).toContainText('200');
    // The names are NOT in it. Two hundred of them is a wall nobody reads, and
    // the count is the part that carries the decision.
    await expect(reposModal(page)).not.toContainText('lab-3-s0');
  });
});

test.describe('what the check does when it cannot see', () => {
  test('an unreadable org listing refuses rather than assuming the name is free', async ({ page }) => {
    // Fail closed: a short list would read as "nothing is in the way", which is
    // the one answer an unanswered request must never produce.
    const writes = await openAdmin(page, { orgReposStatus: 500 });
    await fillNew(page);
    await expect(refusal(page)).toContainText(/could not list the repositories/i);
    await expectNoWrite(page, writes);
  });

  test('an unreadable archive probe refuses, and names the repository', async ({ page }) => {
    const writes = await openAdmin(page, { archiveStatus: 502 });
    await fillNew(page);
    await expect(refusal(page)).toContainText(/could not check/i);
    await expect(refusal(page)).toContainText(ARCHIVE);
    await expectNoWrite(page, writes);
  });

  test('an unreadable retired record refuses', async ({ page }) => {
    const writes = await openAdmin(page, { retiredStatus: 500 });
    await fillNew(page);
    await expect(refusal(page)).toContainText(/could not check whether/i);
    await expectNoWrite(page, writes);
  });

  test('a retired record that will not parse is still a record, and is only a note', async ({ page }) => {
    // Unparseable is not unreadable: the file is there, so the WARNING applies.
    // It must not become a refusal - nothing about a corrupt record blocks.
    const writes = await openAdmin(page, { orgRepos: [], retiredRaw: '{ not json' });
    await fillNew(page);
    await expect(refusal(page)).toHaveCount(0);
    await expect(note(page)).toBeVisible();
    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });
});

test.describe('the verdict follows the form it was about', () => {
  // These are about STALENESS, not about which finding was raised, so they need
  // a blocker to watch appear and disappear - and it has to be one the pattern
  // decides, because two of them clear it by editing the pattern. A live
  // assignment on the same pattern is that; the archive is keyed on the id and
  // would survive a pattern change, which is correct and useless here.
  const rival = () => ({ 'lab-3-old': liveAssignment('lab-3-old', 'lab-3-{github_login}') });

  test('editing the slug drops a verdict decided for the previous one', async ({ page }) => {
    await openAdmin(page, { orgRepos: [], assignments: rival() });
    const slug = await fillNew(page);
    await expect(refusal(page)).toBeVisible();

    await slug.fill('lab-3-resit');
    await expect(refusal(page)).toHaveCount(0);
  });

  test('editing the PATTERN drops it too - it is the half that actually decides', async ({ page }) => {
    await openAdmin(page, { orgRepos: [], assignments: rival() });
    await fillNew(page);
    await expect(refusal(page)).toBeVisible();

    await page.getByPlaceholder('linux-processes-{github_login}').fill('lab-3-2026-{github_login}');
    await expect(refusal(page)).toHaveCount(0);
  });

  test('…and re-checking with the new pattern clears it for real', async ({ page }) => {
    const writes = await openAdmin(page, { orgRepos: [], assignments: rival() });
    await fillNew(page);
    await expect(refusal(page)).toBeVisible();

    const pat = page.getByPlaceholder('linux-processes-{github_login}');
    // A PREFIX, and it has to be. A placeholder expands to `[A-Za-z0-9-]+`, so
    // `lab-3-2026-{github_login}` is still inside `lab-3-{github_login}`'s
    // namespace and the clash correctly survives - which makes a suffix a
    // fixture that proves the opposite of what this test is for.
    await pat.fill('2026-lab-3-{github_login}');
    await pat.blur();
    await expect(refusal(page)).toHaveCount(0);
    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('retyping the title re-derives both halves and drops the stale verdict', async ({ page }) => {
    // autoSyncSlug rewrites form.id AND the pattern without an @input on
    // either field, so the clear cannot live only on those handlers.
    await openAdmin(page, { orgRepos: [], assignments: rival() });
    await page.locator('.new-btn').click();
    const title = page.getByPlaceholder('e.g. Linux Processes 2026');
    await title.fill('Lab 3');
    await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
    const slug = await openSlug(page);
    await slug.focus();
    await slug.blur();
    await expect(refusal(page)).toBeVisible();

    await title.fill('Lab 3 Resit');
    await expect(slug).toHaveValue('lab-3-resit');
    await expect(refusal(page)).toHaveCount(0);
  });

  test('save re-checks even when neither field was ever left', async ({ page }) => {
    // The blur check is a courtesy. Filling in the form and hitting Save
    // without leaving a field must still be refused.
    //
    // What proves it is the WRITE COUNT, not the message on screen. The title
    // carries an @blur of its own now, so moving from it to the template box
    // can raise the same refusal by the courtesy route - which is the point of
    // that handler, and would make an assertion about visible text pass
    // without the gate ever running.
    const writes = await openAdmin(page, { orgRepos: [], assignments: rival() });
    await page.locator('.new-btn').click();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Lab 3');
    await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
    await (await openSlug(page)).fill(ID);

    await saveDraft(page).click();
    await expect(refusal(page)).toBeVisible();
    expect(writes.filter((w) => w.path.startsWith('assignments/'))).toHaveLength(0);
  });

  test('an invalid slug is reported as invalid, not as a collision', async ({ page }) => {
    // The format error owns the field; probing for `Lab 3!` would be nonsense.
    // It is reported on the SLUG's own field - the collision verdict moved to
    // the pattern, but a malformed slug is a fact about the slug.
    await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page, { slug: 'Lab 3!' });
    const slugError = slugField(page).locator('.field-error-msg');
    await expect(slugError).toContainText(/lowercase/i);
    // Nothing under the pattern at all - `not.toContainText` would pass
    // vacuously here anyway, since it FAILS on a locator matching nothing.
    await expect(refusal(page)).toHaveCount(0);
  });

  test('a pattern with no placeholder is reported as invalid, not probed', async ({ page }) => {
    await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page, { pattern: 'lab-3-everyone' });
    await expect(page.locator('.field-error-msg', { hasText: '{github_login}' })).toBeVisible();
    // The format error and the collision verdict now share one field, as
    // v-if/v-else-if - so "the check never ran" is proved by the field saying
    // the FORMAT is wrong and never mentioning a collision, rather than by the
    // field being empty. A probe for `lab-3-everyone` would be nonsense.
    await expect(refusal(page)).not.toContainText(/land on top of/i);
    await expect(note(page)).toHaveCount(0);
  });
});

test.describe('an existing assignment', () => {
  const open = (page, extra = {}) => openAdmin(page, {
    assignments: { [ID]: liveAssignment(ID, `${ID}-{github_login}`), ...extra.assignments },
    orgRepos: extra.orgRepos ?? [`${ID}-alice`, `${ID}-bob`],
    retired: extra.retired ?? null,
    archive: extra.archive ?? false,
  });

  test('saves normally - its own repositories are its own', async ({ page }) => {
    // Its repositories match its pattern, its archive is meant to be there.
    // Asking the new-assignment questions here would refuse every save.
    const writes = await open(page, { archive: true, retired: manifest() });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    // Not a disabled box any more. Changing the slug of an existing assignment
    // orphans its YAML, so on an existing one it is only ever a reading: the
    // value is shown and there is no way in. A disabled input said the same
    // thing while still looking like somewhere a value goes.
    await expect(slugField(page)).toContainText(ID);
    await expect(page.getByPlaceholder('linux-processes-2026')).toHaveCount(0);
    await expect(slugField(page).getByRole('button', { name: 'Edit' })).toHaveCount(0);

    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('but repointing its pattern at ANOTHER live assignment is refused', async ({ page }) => {
    // The slug is locked when editing; the pattern is not. This is the only
    // way an existing assignment can start handing out somebody else's repos.
    const writes = await open(page, {
      assignments: { other: liveAssignment('other', 'other-{github_login}') },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await page.getByPlaceholder('linux-processes-{github_login}').fill('other-{github_login}');

    await saveDraft(page).click();
    await expect(refusal(page)).toContainText('"other" already uses this repository name pattern');
    expect(writes.filter((w) => w.path.startsWith('assignments/'))).toHaveLength(0);
  });

  test('and its OWN pattern is never a reason to refuse its own save', async ({ page }) => {
    const writes = await open(page);
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await page.getByPlaceholder('linux-processes-{github_login}').blur();
    await expect(refusal(page)).toHaveCount(0);
    // Nor a note: an unchanged pattern asks the organization nothing at all.
    await expect(note(page)).toHaveCount(0);

    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('THE WAY ROUND THE CREATION CHECK: repointing at occupied names is reported now', async ({ page }) => {
    // Create under a name the check accepts, save, then edit the pattern to the
    // one you wanted. It went through in silence, because this branch only ever
    // looked at other assignments - and it is the natural move for a lecturer
    // who has just been told no, written down in RUNBOOK §5.1.
    const writes = await open(page, { orgRepos: ['portfolio-alice', 'portfolio-bob'] });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    const pat = page.getByPlaceholder('linux-processes-{github_login}');
    await pat.fill('portfolio-{github_login}');
    await pat.blur();

    // Not a refusal - same as at creation. What it buys is that the lecturer is
    // asked once rather than walking past it in silence.
    await expect(refusal(page)).toHaveCount(0);
    expect(await saveAnswering(page, 'reuse')).toBe(true);
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('one that already answered is not asked again when it is opened', async ({ page }) => {
    // The whole point of storing the answer. Opening a saved assignment to
    // change its title must not re-ask a question it has already answered -
    // that is what turns a warning into something people click past.
    const writes = await openAdmin(page, {
      assignments: { [ID]: liveAssignment(ID, `${ID}-{github_login}`, { existing_repo_policy: 'reuse' }) },
      orgRepos: [`${ID}-alice`, `${ID}-bob`],
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    expect(await saveAnswering(page, 'reuse'), 'it must not ask again').toBe(false);

    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
    // And the stored answer survives the save: buildDoc rebuilds the whole
    // document, so a value it did not carry would be deleted by an edit to
    // something else entirely.
    expect(writes.find((w) => w.path === `assignments/${ID}.yml`).content)
      .toContain('existing_repo_policy: reuse');
  });

  test('…but changing its pattern asks again, about the new set', async ({ page }) => {
    const writes = await openAdmin(page, {
      assignments: { [ID]: liveAssignment(ID, `${ID}-{github_login}`, { existing_repo_policy: 'reuse' }) },
      orgRepos: [`${ID}-alice`, 'resit-bob'],
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    const pat = page.getByPlaceholder('linux-processes-{github_login}');
    await pat.fill('resit-{github_login}');
    await pat.blur();

    expect(await saveAnswering(page, 'refuse'), 'a different pattern is a different question').toBe(true);
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
    expect(writes.find((w) => w.path === `assignments/${ID}.yml`).content)
      .toContain('existing_repo_policy: refuse');
  });

  test('…and widening its own pattern does not report its own cohort back at it', async ({ page }) => {
    // A placeholder expands to `[A-Za-z0-9-]+`, so `lab-3-{github_login}`
    // matches `lab-3-2026-alice`. Going the other way - narrow to wide - would
    // otherwise list this assignment's own repositories as something in its
    // way, which is the reading that makes the check useless on an edit.
    await openAdmin(page, {
      assignments: { [ID]: liveAssignment(ID, `${ID}-2026-{github_login}`) },
      orgRepos: [`${ID}-2026-alice`, `${ID}-2026-bob`],
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    const pat = page.getByPlaceholder('linux-processes-{github_login}');
    await pat.fill(`${ID}-{github_login}`);
    await pat.blur();

    await expect(note(page)).toHaveCount(0);
    await expect(refusal(page)).toHaveCount(0);
  });
});
