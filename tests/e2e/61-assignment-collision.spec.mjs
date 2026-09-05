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
// Three things block, and two are silent until the deadline:
//
//   - provision.mjs hands a returning student their OLD repository back
//     (`alreadyExists ? existing.data`), still carrying the previous deadline's
//     lockdown ruleset, which nothing can remove.
//   - two assignments sharing a pattern do that to each other, from the first
//     acceptance.
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
async function fillNew(page, { title = 'Lab 3', slug = ID, pattern = null } = {}) {
  await page.locator('.new-btn').click();
  await page.getByPlaceholder('e.g. Linux Processes 2026').fill(title);
  await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
  const slugInput = page.getByPlaceholder('linux-processes-2026');
  await slugInput.fill(slug);
  if (pattern !== null) {
    await page.getByPlaceholder('linux-processes-{github_login}').fill(pattern);
  }
  await slugInput.focus();
  await slugInput.blur();
  return slugInput;
}

const saveDraft = (page) => page.getByRole('button', { name: 'Save as draft' }).first();
const slugField = (page) => page.locator('.field:has(label:text-matches("^Slug"))');
const refusal = (page) => slugField(page).locator('.field-error-msg');
const note = (page) => slugField(page).locator('.collision-note');

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
  test('an existing student repository blocks, and is named', async ({ page }) => {
    const writes = await openAdmin(page, {
      orgRepos: ['lab-3-alice', 'lab-3-bob', 'unrelated-repo'],
    });
    await fillNew(page);

    const err = refusal(page);
    await expect(err).toBeVisible();
    await expect(err).toContainText('lab-3-alice, lab-3-bob');
    await expect(err).toContainText(/still locked down/);
    await expectNoWrite(page, writes);
  });

  test('a DIFFERENT id pointing at an occupied pattern is refused too', async ({ page }) => {
    // The whole reason the check is on the pattern: this looks like a brand new
    // assignment and would hand out lab-3's repositories.
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page, { title: 'Lab 3 v2', slug: 'lab-3-v2', pattern: 'lab-3-{github_login}' });

    await expect(refusal(page)).toBeVisible();
    await expect(refusal(page)).toContainText('lab-3-alice');
    await expectNoWrite(page, writes);
  });

  test('another LIVE assignment already using the pattern blocks, and is named', async ({ page }) => {
    // lib/seed-teams.mjs invariant 2, enforced for the first time.
    const writes = await openAdmin(page, {
      orgRepos: [],
      assignments: { 'lab-3-old': liveAssignment('lab-3-old', 'lab-3-{github_login}') },
    });
    await fillNew(page, { title: 'Lab 3 New', slug: 'lab-3-new', pattern: 'lab-3-{github_login}' });

    await expect(refusal(page)).toContainText('"lab-3-old" already uses the repository name pattern');
    await expect(refusal(page)).toContainText(/hand out each other's repositories/);
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
    await expect(refusal(page)).toContainText(/rejected at the new deadline/);
    await expectNoWrite(page, writes);
  });

  test('an archive with no record at all still blocks', async ({ page }) => {
    // retired/<id>/ is an ordinary file a lecturer can delete. Its absence is
    // not proof the run never happened.
    await openAdmin(page, { orgRepos: [], retired: null, archive: true });
    await fillNew(page);
    await expect(refusal(page)).toContainText('the archive repository still exists');
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
    await expect(err).toContainText('lab-3-alice');
    await expect(err).toContainText('"lab-3-old"');
    await expect(err).toContainText('the archive repository still exists');
    // Three blockers, and NOT the retired record: the consequence line says
    // "delete what is listed above", and nobody has to delete the evidence.
    await expect(err.locator('li')).toHaveCount(3);
    await expect(err).not.toContainText(`retired/${ID}/`);
    await expectNoWrite(page, writes);
  });

  test('the refusal says how to proceed, and never points at the repo docs', async ({ page }) => {
    // DESIGN.md 1.6 - a lecturer is not the operator of this deployment.
    await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page);
    const err = refusal(page);
    await expect(err).toContainText('Change the repository name pattern');
    await expect(err).toContainText('delete what is listed above');
    await expect(err).not.toContainText(/RUNBOOK|ARCHITECTURE|LESSONS|DESIGN\.md/);
  });

  test('matching is case-insensitive, because GitHub repository names are', async ({ page }) => {
    // `Lab-3-Alice` and `lab-3-alice` cannot both exist.
    await openAdmin(page, { orgRepos: ['Lab-3-Alice'] });
    await fillNew(page);
    await expect(refusal(page)).toContainText('Lab-3-Alice');
  });

  test('a group pattern collides on the team repositories', async ({ page }) => {
    await openAdmin(page, { orgRepos: ['lab-3-team-alpha', 'lab-3-team-beta'] });
    await page.locator('.new-btn').click();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Lab 3');
    await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
    // The form only accepts a {team_slug} pattern on a group assignment.
    await page.locator('input[value="group"]').check();
    const pat = page.getByPlaceholder('linux-processes-{github_login}');
    await pat.fill('lab-3-{team_slug}');
    await pat.blur();
    await expect(refusal(page)).toContainText('lab-3-team-alpha, lab-3-team-beta');
  });

  test('a huge cohort is counted, not printed', async ({ page }) => {
    await openAdmin(page, { orgRepos: Array.from({ length: 200 }, (_, i) => `lab-3-s${i}`) });
    await fillNew(page);
    await expect(refusal(page)).toContainText('200 repositories');
    await expect(refusal(page)).toContainText('…');
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
  test('editing the slug drops a verdict decided for the previous one', async ({ page }) => {
    await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    const slug = await fillNew(page);
    await expect(refusal(page)).toBeVisible();

    await slug.fill('lab-3-resit');
    await expect(refusal(page)).toHaveCount(0);
  });

  test('editing the PATTERN drops it too - it is the half that actually decides', async ({ page }) => {
    await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page);
    await expect(refusal(page)).toBeVisible();

    await page.getByPlaceholder('linux-processes-{github_login}').fill('lab-3-2026-{github_login}');
    await expect(refusal(page)).toHaveCount(0);
  });

  test('…and re-checking with the new pattern clears it for real', async ({ page }) => {
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page);
    await expect(refusal(page)).toBeVisible();

    const pat = page.getByPlaceholder('linux-processes-{github_login}');
    await pat.fill('lab-3-2026-{github_login}');
    await pat.blur();
    await expect(refusal(page)).toHaveCount(0);
    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });

  test('retyping the title re-derives both halves and drops the stale verdict', async ({ page }) => {
    // autoSyncSlug rewrites form.id AND the pattern without an @input on
    // either field, so the clear cannot live only on those handlers.
    await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await page.locator('.new-btn').click();
    const title = page.getByPlaceholder('e.g. Linux Processes 2026');
    await title.fill('Lab 3');
    await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
    const slug = page.getByPlaceholder('linux-processes-2026');
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
    const writes = await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await page.locator('.new-btn').click();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Lab 3');
    await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/starter-template`);
    await page.getByPlaceholder('linux-processes-2026').fill(ID);

    await saveDraft(page).click();
    await expect(refusal(page)).toBeVisible();
    expect(writes.filter((w) => w.path.startsWith('assignments/'))).toHaveLength(0);
  });

  test('an invalid slug is reported as invalid, not as a collision', async ({ page }) => {
    // The format error owns the field; probing for `Lab 3!` would be nonsense.
    await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page, { slug: 'Lab 3!' });
    await expect(refusal(page)).toContainText(/lowercase/i);
    await expect(refusal(page)).not.toContainText(/land on top of/i);
  });

  test('a pattern with no placeholder is reported as invalid, not probed', async ({ page }) => {
    await openAdmin(page, { orgRepos: ['lab-3-alice'] });
    await fillNew(page, { pattern: 'lab-3-everyone' });
    await expect(page.locator('.field-error-msg', { hasText: '{github_login}' })).toBeVisible();
    // Nothing at all under the slug: the pattern is invalid, so the collision
    // check never ran, and a probe for `lab-3-everyone` would be nonsense.
    await expect(refusal(page)).toHaveCount(0);
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
    await expect(page.getByPlaceholder('linux-processes-2026')).toBeDisabled();

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
    await expect(refusal(page)).toContainText('"other" already uses the repository name pattern');
    expect(writes.filter((w) => w.path.startsWith('assignments/'))).toHaveLength(0);
  });

  test('and its OWN pattern is never a reason to refuse its own save', async ({ page }) => {
    const writes = await open(page);
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await page.getByPlaceholder('linux-processes-{github_login}').blur();
    await expect(refusal(page)).toHaveCount(0);

    await saveDraft(page).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBe(1);
  });
});
