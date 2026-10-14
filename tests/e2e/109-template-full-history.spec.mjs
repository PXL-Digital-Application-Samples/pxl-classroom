// 109 - "Give students every branch and its full history" (template_full_history).
//
// Asked 2026-10-14 for a git exercise with prepared branches: GitHub's template
// copy gives one commit, and with all branches one commit each sharing no
// history. Provisioning does the copy (tests/provision-full-history.test.mjs);
// this is the editor's half - the box writes the field and reads it back - and
// the assignment page's: starter sync is not offered, because it does not run
// there (lib/starter-sync.mjs `syncRefusal`).

import { test, expect } from '@playwright/test';
import { parse } from 'yaml';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, inviteToken, expandSettings, openMoreActionsMenu, openAutogradeModal } from '../fixtures/e2e-fixtures.mjs';

const ID = 'git-exercise';

const assignment = (extra = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'Git exercise',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 150,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'git-exercise-template' },
  invite_key: inviteToken(ORG, ID),
  invite_nonce: 'e2e00109',
  invite_expires_at: '2099-01-01T00:00:00.000Z',
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 60 * 86400_000).toISOString(),
  ...extra,
});

const brokerRepo = { name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}`, html_url: `https://github.com/${ORG}/broker-${ID}` };

async function openEditor(page, extra = {}) {
  const contentWrites = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment(extra) },
    userRepos: [brokerRepo],
    contentWrites,
  });
  await page.route((url) => url.href.includes('/actions/workflows/') && url.href.includes('/dispatches'),
    (route) => route.fulfill({ status: 204, body: '' }));
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(page.locator('.editor-form[data-broker="present"]')).toBeVisible({ timeout: 15000 });
  await expandSettings(page);
  return contentWrites;
}

const box = (page) => page.locator('[data-template-history] input[type="checkbox"]');
// Under Advanced (asked once, rare), which is a closed disclosure.
const openAdvanced = async (page) => {
  const advanced = page.locator('#settings-advanced');
  if (!(await advanced.evaluate((d) => d.open))) await advanced.locator('summary').click();
};
const historyLine = (page) => page.locator('[data-derived="template-history"]');
const savedDoc = (writes) => {
  const w = [...writes].reverse().find((x) => x.path === `assignments/${ID}.yml`);
  return w ? parse(w.content) : null;
};

test.describe('109 - every branch and its full history', () => {
  test('ticking the box writes the field; an untouched assignment does not carry it', async ({ page }) => {
    const writes = await openEditor(page);
    // Off, and folded away: nothing about it in the main flow.
    await expect(box(page)).toBeHidden();
    await expect(historyLine(page)).toHaveCount(0);
    await openAdvanced(page);
    await expect(box(page)).not.toBeChecked();
    await expect(page.locator('[data-template-history]')).toContainText('Students can read everything ever committed to the template.');
    await expect(page.locator('[data-template-history]')).toContainText('Reaches students who accept after you save.');
    await box(page).check();
    // On: said beside the template it changes.
    await expect(historyLine(page)).toContainText('Students get every branch and its full history');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast', { hasText: `Saved ${ID}` })).toBeVisible({ timeout: 15000 });
    expect(savedDoc(writes)?.template_full_history).toBe(true);
  });

  test('when it is on, the line under the template says so and Change opens Advanced on it', async ({ page }) => {
    await openEditor(page, { template_full_history: true });
    await expect(historyLine(page)).toBeVisible();
    await expect(box(page)).toBeHidden();
    // By its whole name, which says what it changes (D13): a bare "Change" would
    // match any button that merely contains the word.
    await historyLine(page).getByRole('button', { name: 'Change whether students get every branch and its full history', exact: true }).click();
    await expect(box(page)).toBeVisible();
    await expect(box(page)).toBeChecked();
    // On it: focus moves to the checkbox the line is about (DESIGN.md §1.8).
    await expect(box(page)).toBeFocused();
  });

  test('a stored answer loads ticked, and unticking removes it rather than writing false', async ({ page }) => {
    const writes = await openEditor(page, { template_full_history: true });
    await openAdvanced(page);
    await expect(box(page)).toBeChecked();
    await box(page).uncheck();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast', { hasText: `Saved ${ID}` })).toBeVisible({ timeout: 15000 });
    const doc = savedDoc(writes);
    expect(doc).not.toBeNull();
    expect('template_full_history' in doc).toBe(false);
  });

  test('TS-7 (D3/D4): the lock and the branch hints say what full history changes, and only when it is on', async ({ page }) => {
    await openEditor(page);
    await openAdvanced(page);
    const refHint = page.locator('.field', { has: page.locator('label', { hasText: 'Submission ref' }) }).locator('small');
    const option = (title) => page.locator('.policy-option', { has: page.locator('strong', { hasText: new RegExp(`^${title}$`) }) });
    const stops = option('Pushing stops');
    const readOnly = option('The repository becomes read-only');
    const OTHER_BRANCHES = 'Only the default branch stops; their other branches stay open.';
    await expect(refHint).toHaveText(/^\s*Student repositories start with the template's default branch only: refs\/heads\/[\w.-]+\.\s*$/, { timeout: 15000 });
    await expect(stops).not.toContainText(OTHER_BRANCHES);

    await box(page).check();
    await expect(refHint).toHaveText(/^\s*Students get every branch, but only the template's default branch, refs\/heads\/[\w.-]+, is graded and archived\.\s*$/);
    await expect(stops).toContainText(OTHER_BRANCHES);
    // Read-only takes the whole repository, every branch: the sentence is not true there.
    await expect(readOnly).not.toContainText('branches stay open');
  });

  // THE TEMPLATE-CHANGE HINT AND THE NOTICE AFTER THE SAVE, for each answer the
  // students' records give: Sync Starter Code runs, it does not, or the report
  // could not be read and nobody knows (TS-7: that was a guess that it runs).
  for (const [label, extra, report, said, link] of [
    ['ordinary', {}, 'empty', 'Sync Starter Code brings them up to the new template, and shows every change before it is sent.', true],
    ['full history on', { template_full_history: true }, 'empty', 'Sync Starter Code does not run on this assignment: students in it were given the template with its full history.', false],
    ['report unreadable', {}, 500, 'Whether Sync Starter Code can bring them up to the new template could not be read just now; it says so itself before anything is sent.', true],
  ]) {
    test(`TS-7: a template change on an assignment with a student, ${label}: the hint and the notice say only what was read`, async ({ page }) => {
      const contentWrites = [];
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, {
        currentUser: LECTURER,
        assignments: { [ID]: assignment(extra) },
        userRepos: [brokerRepo],
        contentWrites,
        reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students: [] } },
        controlRepositories: { [ID]: [{
          schema_version: 1, assignment_id: ID, github_login: 'ann', repo_id: 7001,
          repo_name: `${ORG}/${ID}-ann`, repo_url: `https://github.com/${ORG}/${ID}-ann`,
        }] },
      });
      if (report === 500) {
        await page.route(`**/pxl-classroom-control/contents/reports/${ID}.json*`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Server Error"}' }));
      }
      await page.route((url) => url.href.includes('/actions/workflows/') && url.href.includes('/dispatches'),
        (route) => route.fulfill({ status: 204, body: '' }));
      await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
      await expect(page.locator('.editor-form[data-broker="present"]')).toBeVisible({ timeout: 15000 });
      await expandSettings(page);
      await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/another-template`);

      const hint = page.locator('.form-hint[role="note"]', { hasText: 'already has' });
      await expect(hint).toContainText('1 student already has a repository from the current template. The new one is used only for students who accept from now on', { timeout: 10000 });
      if (report === 500) {
        await expect(hint).toHaveText(/accept from now on\.$/);
        await expect(hint).not.toContainText('Sync Starter Code');
      } else if (link) {
        await expect(hint).toContainText('after saving, Sync Starter Code sends it to the others.');
      } else {
        await expect(hint).toContainText('Sync Starter Code does not run on this assignment');
      }

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const notice = page.locator('.published-info-card', { hasText: 'Existing repositories still have the old template' });
      await expect(notice).toBeVisible({ timeout: 15000 });
      await expect(notice).toContainText('1 student has a repository made from the previous template.');
      await expect(notice).toContainText(said);
      await expect(notice.getByRole('link', { name: 'Sync Starter Code' })).toHaveCount(link ? 1 : 0);
    });
  }

  // The same three answers in the Autograde dialog, after it writes a starter
  // grading workflow to the template.
  for (const [label, extra, report, said] of [
    ['ordinary', {}, 'empty', 'Students who accepted before now keep their copy until you run Sync Starter Code on this assignment.'],
    ['full history on', { template_full_history: true }, 'empty', 'Students who accepted before now do not get it: Sync Starter Code does not run on this assignment, whose students were given the template with its full history.'],
    ['report unreadable', {}, 500, 'Students who accepted before now keep their copy. Whether Sync Starter Code can send it to them could not be read just now.'],
  ]) {
    test(`TS-7: the Autograde dialog, after adding a starter workflow to the template, ${label}`, async ({ page }) => {
      const contentWrites = [];
      const TEMPLATE = `${ORG}/git-exercise-template`;
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, {
        currentUser: LECTURER,
        assignments: { [ID]: assignment(extra) },
        userRepos: [brokerRepo],
        contentWrites,
        reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students: [] } },
      });
      if (report === 500) {
        await page.route(`**/pxl-classroom-control/contents/reports/${ID}.json*`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Server Error"}' }));
      }
      await page.route(`https://api.github.com/repos/${TEMPLATE}/contents/.github/workflows`, (route) =>
        route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' }));
      await page.route(`https://api.github.com/repos/${TEMPLATE}/contents/.github/workflows/classroom.yml`, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' })
          : route.fallback());
      await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
      await expect(page.locator('.editor-form[data-broker="present"]')).toBeVisible({ timeout: 15000 });
      await expandSettings(page);
      await openAutogradeModal(page);
      const dialog = page.locator('.autograde-setup-modal');
      await page.getByRole('radio', { name: /They come with my template/ }).check();
      await expect(dialog.locator('.ag-template-state')).toContainText(`No grading workflow in ${TEMPLATE}`, { timeout: 10000 });
      await page.getByRole('radio', { name: /Only on a hand-in commit/ }).check();
      await page.getByLabel('Commit message', { exact: true }).fill('einde examen');
      await dialog.getByRole('button', { name: /Add a starter workflow/ }).click();
      await expect.poll(() => contentWrites.some((w) => w.path === '.github/workflows/classroom.yml'), { timeout: 10000 }).toBe(true);
      await expect(dialog.locator('.ag-marker-hint', { hasText: 'Added to your template repository.' })).toHaveText(`Added to your template repository. ${said}`);
    });
  }

  // A student holding a full-history copy, on an assignment whose box was
  // unticked after they accepted: the copy is per student, the setting per assignment.
  const COPY_ROW = {
    github_login: 'ann', acceptance_state: 'accepted', submission_status: 'no-submission',
    repo_name: `${ORG}/${ID}-ann`, repo_id: 7001, commit_count: 0, starter_sha: 'c'.repeat(40), starter_commit_count: 14,
    full_history: true,
  };
  for (const [label, extra, students, reason] of [
    ['an ordinary assignment offers Sync Starter Code (the control)', {}, [], null],
    ['a full-history assignment shows Sync Starter Code disabled, and says why', { template_full_history: true }, [], 'students were given the template with its full history'],
    ['unticked after a student got such a copy: still disabled, and says some students have one', {}, [COPY_ROW], 'some students were given the template with its full history'],
  ]) {
    test(label, async ({ page }) => {
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, {
        currentUser: LECTURER,
        assignments: { [ID]: assignment(extra) },
        reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students } },
      });
      await page.goto(`/dashboard/${ORG}/${ID}`);
      await openMoreActionsMenu(page);
      const item = page.locator('[data-sync-starter]');
      // Never simply gone (DESIGN.md §1.5): disabled, with the reason.
      await expect(item).toHaveCount(1);
      if (!reason) {
        await expect(item).toBeEnabled();
        // ...and Enter opens it there, so the keyboard checks below can fail.
        await item.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#starter-sync-title')).toBeVisible();
      } else {
        await expect(item).toBeDisabled();
        await expect(item).toContainText(reason);
        // Still in the Tab order, so the reason is reachable from the keyboard (D12).
        await expect(item).not.toHaveAttribute('disabled');
        await item.focus();
        await expect(item).toBeFocused();
        await item.click({ force: true });
        // Enter and Space press a button too (TS-9).
        for (const key of ['Enter', 'Space']) {
          if (!(await item.isVisible())) await openMoreActionsMenu(page);
          await item.focus();
          await page.keyboard.press(key);
        }
        // Absent after a wait: the dialog opens asynchronously.
        await page.waitForTimeout(800);
        await expect(page.locator('#starter-sync-title')).toHaveCount(0);
      }
    });
  }

  test('the editor asks the same rule: unticked after a student got such a copy, a template change does not point at Sync Starter Code', async ({ page }) => {
    // Review 2026-10-14: the editor looked at the checkbox alone, and told the
    // lecturer the sync would bring them up to the new template - which the
    // page, the workflow and the CLI all refuse.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      userRepos: [brokerRepo],
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students: [COPY_ROW] } },
      // One student already holds a repository of the current template.
      controlRepositories: { [ID]: [{
        schema_version: 1, assignment_id: ID, github_login: 'ann', repo_id: 7001,
        repo_name: `${ORG}/${ID}-ann`, repo_url: `https://github.com/${ORG}/${ID}-ann`, starter_sha: 'c'.repeat(40), starter_commit_count: 14,
        full_history: true,
      }] },
    });
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await expect(page.locator('.editor-form[data-broker="present"]')).toBeVisible({ timeout: 15000 });
    await expandSettings(page);
    await page.getByPlaceholder('Type or select a template repository').fill(`${ORG}/another-template`);
    const hint = page.locator('.form-hint[role="note"]', { hasText: 'already has' });
    await expect(hint).toBeVisible({ timeout: 10000 });
    await expect(hint).toContainText('Sync Starter Code does not run on this assignment: students in it were given the template with its full history');
    await expect(hint).not.toContainText('Sync Starter Code sends it');
  });

  // REFRESH APPLIES THE REPORT'S OWN RULE (lib/starter-commit.mjs). The
  // repository has the template's 14 commits from the first second; counted,
  // the student read as handed in, with 14 commits of the lecturer's.
  const GIVEN = 'c'.repeat(40);
  async function refreshWith(page, { headSha, count }) {
    const gitCommits = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment({ template_full_history: true }) },
      reports: {
        [ID]: {
          schema_version: 1, assignment_id: ID, generated_at: new Date(Date.now() - 3600_000).toISOString(),
          students: [{
            github_login: 'ann', acceptance_state: 'accepted', submission_status: 'no-submission',
            repo_name: `${ORG}/${ID}-ann`, repo_id: 7001, commit_count: 0,
            starter_sha: GIVEN, starter_commit_count: 14,
          }],
        },
      },
      gitCommits,
    });
    await page.route(`**/repos/${ORG}/${ID}-ann/commits?**`, (route) => route.fulfill({
      status: 200,
      // Exposed across origins, as GitHub exposes it: without that the page
      // cannot read the count and falls back to the length of the page.
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'Link',
        link: `<https://api.github.com/repositories/7001/commits?sha=main&per_page=1&page=${count}>; rel="last"`,
      },
      body: JSON.stringify([{
        sha: headSha,
        commit: {
          message: 'Add a bug',
          author: { name: 'Lecturer', email: 'lecturer@pxl.be', date: '2026-09-01T10:00:00Z' },
          committer: { name: 'Lecturer', email: 'lecturer@pxl.be', date: '2026-09-01T10:00:00Z' },
        },
      }]),
    }));
    await page.goto(`/dashboard/${ORG}/${ID}`);
    const row = page.locator('tr', { hasText: 'ann' }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /^Refresh$/i }).first().click();
    await expect.poll(() => gitCommits.filter((c) => c.message === `Live refresh: ${ID}`).length, { timeout: 20000 }).toBe(1);
    const files = gitCommits.find((c) => c.message === `Live refresh: ${ID}`).files;
    const saved = JSON.parse(files.find((f) => f.path === `reports/${ID}.json`).content).students[0];
    const obs = JSON.parse(files.find((f) => f.path.startsWith(`observations/${ID}/ann/`)).content);
    return { row, saved, obs };
  }

  test('Refresh at the commit it was given: not handed in, 0 commits, and the lecturer is not its author', async ({ page }) => {
    const { row, saved, obs } = await refreshWith(page, { headSha: GIVEN, count: 14 });
    expect(saved.submission_status).toBe('no-submission');
    expect(saved.commit_count).toBe(0);
    expect([saved.author_name, saved.author_email]).toEqual([null, null]);
    // The observation is evidence as the collector stores it: the branch's whole count.
    expect(obs.commit_count).toBe(14);
    await expect(row).toContainText('No submission');
  });

  test('Refresh after the student added three commits: handed in, 3 commits', async ({ page }) => {
    const { row, saved, obs } = await refreshWith(page, { headSha: 'd'.repeat(40), count: 17 });
    expect(saved.submission_status).toBe('on-time');
    expect(saved.commit_count).toBe(3);
    expect(obs.commit_count).toBe(17);
    await expect(row).not.toContainText('No submission');
  });

  test('the ?sync=1 link a template-change notice hands out opens nothing on it', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment({ template_full_history: true }) },
      reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students: [] } },
    });
    await page.goto(`/dashboard/${ORG}/${ID}?sync=1`);
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page).not.toHaveURL(/sync=1/);
    await expect(page.locator('#starter-sync-title')).toHaveCount(0);
  });
});
