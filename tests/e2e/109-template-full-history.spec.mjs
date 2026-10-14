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
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, inviteToken, expandSettings, openMoreActionsMenu } from '../fixtures/e2e-fixtures.mjs';

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
    await historyLine(page).getByRole('button', { name: 'Change' }).click();
    await expect(box(page)).toBeVisible();
    await expect(box(page)).toBeChecked();
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

  for (const [label, extra, offered] of [
    ['an ordinary assignment offers Sync Starter Code (the control)', {}, true],
    ['a full-history assignment shows Sync Starter Code disabled, and says why', { template_full_history: true }, false],
  ]) {
    test(label, async ({ page }) => {
      await injectAuth(page, LECTURER);
      await setupStandardMockRoutes(page, {
        currentUser: LECTURER,
        assignments: { [ID]: assignment(extra) },
        reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students: [] } },
      });
      await page.goto(`/dashboard/${ORG}/${ID}`);
      await openMoreActionsMenu(page);
      const item = page.locator('[data-sync-starter]');
      // Never simply gone (DESIGN.md §1.5): disabled, with the reason.
      await expect(item).toHaveCount(1);
      if (offered) {
        await expect(item).toBeEnabled();
      } else {
        await expect(item).toBeDisabled();
        await expect(item).toContainText('students were given the template with its full history');
        await item.click({ force: true });
        await expect(page.locator('#starter-sync-title')).toHaveCount(0);
      }
    });
  }

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
