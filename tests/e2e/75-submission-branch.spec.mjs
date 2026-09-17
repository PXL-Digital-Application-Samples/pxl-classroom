// 75 - Submission ref names the branch a student repository actually gets.
//
// Provisioning generates each repository with `include_all_branches: false`, so
// a student starts with the template's DEFAULT branch and no other. The form
// seeded `refs/heads/main` whatever the template was, and `java-essentials-2627`
// kept it over a template whose only branch is `master`: the nightly collect
// answered `commit HTTP 404` for every student and failed that organization's
// leg on 2026-09-16 and 2026-09-17, recording no evidence at all.
//
// lib/template-source.mjs (`submissionBranchProvisioned`) is the judge. The form
// follows the template on a NEW assignment while the lecturer has not typed a
// ref, warns otherwise, and publishing refuses (scripts/check-publish-preflight.mjs).
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const templateBox = (page) => page.getByPlaceholder('Type or select a template repository');
const submissionRef = (page) => page.locator('details.advanced .field', { hasText: 'Submission ref' }).locator('input');
const branchWarning = (page) => page.locator('.submission-branch-warning');
const openAdvanced = (page) => page.locator('details.advanced summary').click();

/**
 * Answer `GET /repos/{owner}/{repo}` for the template probe. Registered after
 * the standard routes so it wins over the fixture's `/repos/` catch-all.
 */
async function routeTemplateRepo(page, { repo, defaultBranch, id = 7575 }) {
  await page.route(`**/repos/${ORG}/${repo}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id,
        full_name: `${ORG}/${repo}`,
        name: repo,
        private: true,
        is_template: true,
        default_branch: defaultBranch,
        html_url: `https://github.com/${ORG}/${repo}`,
      }),
    });
  });
}

async function openNew(page, templates) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
  for (const t of templates) await routeTemplateRepo(page, t);
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('.new-btn').click();
}

test.describe('75 - a new assignment collects from the branch students will have', () => {
  test('THE REGRESSION: a master template gives refs/heads/master, not the old main seed', async ({ page }) => {
    await openNew(page, [{ repo: 'java-start', defaultBranch: 'master' }]);
    await templateBox(page).fill(`${ORG}/java-start`);
    await expect(page.locator('.badge-success')).toContainText('master branch', { timeout: 10000 });

    await openAdvanced(page);
    await expect(submissionRef(page)).toHaveValue('refs/heads/master');
    await expect(branchWarning(page)).toHaveCount(0);
  });

  test('it follows the template when the lecturer picks another one', async ({ page }) => {
    await openNew(page, [
      { repo: 'java-start', defaultBranch: 'master' },
      { repo: 'python-start', defaultBranch: 'main', id: 7576 },
    ]);
    await openAdvanced(page);

    await templateBox(page).fill(`${ORG}/java-start`);
    await expect(submissionRef(page)).toHaveValue('refs/heads/master', { timeout: 10000 });

    await templateBox(page).fill(`${ORG}/python-start`);
    await expect(submissionRef(page)).toHaveValue('refs/heads/main', { timeout: 10000 });
    await expect(branchWarning(page)).toHaveCount(0);
  });

  test('a ref the lecturer TYPED is theirs: kept, and warned about', async ({ page }) => {
    await openNew(page, [{ repo: 'java-start', defaultBranch: 'master' }]);
    await openAdvanced(page);
    await submissionRef(page).fill('refs/heads/main');

    await templateBox(page).fill(`${ORG}/java-start`);
    await expect(page.locator('.badge-success')).toBeVisible({ timeout: 10000 });
    await expect(submissionRef(page), 'a typed value is never overwritten by a probe').toHaveValue('refs/heads/main');

    const warn = branchWarning(page);
    await expect(warn).toBeVisible();
    await expect(warn).toContainText('"main"');
    await expect(warn).toContainText('"master"');
    await expect(warn).toContainText('Set Submission ref to refs/heads/master.');

    // And it lifts when the only thing that changed is the ref, which ties
    // the warning to this rule rather than to anything else on the form.
    await submissionRef(page).fill('refs/heads/master');
    await expect(warn).toHaveCount(0);
  });
});

test.describe('75 - an existing assignment on the wrong branch', () => {
  const ID = 'java-lab';
  const stored = {
    schema_version: 1,
    id: ID,
    title: 'Java Lab',
    organization: ORG,
    template: { owner: ORG, repository: 'java-start' },
    repository_name_pattern: `${ID}-{github_login}`,
    opens_at: new Date(Date.now() - 86400_000).toISOString(),
    deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    submission_ref: 'refs/heads/main',
    state: 'draft',
    assignment_type: 'individual',
    roster_mode: 'open',
    max_acceptances: 50,
  };

  test('is warned, is not rewritten, and opening it does not make it look edited', async ({ page }) => {
    const dialogs = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      d.dismiss();
    });
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [ID]: stored } });
    await routeTemplateRepo(page, { repo: 'java-start', defaultBranch: 'master' });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.assignment-list li', { hasText: 'Java Lab' }).first().click();
    await expect(templateBox(page)).toHaveValue(`${ORG}/java-start`, { timeout: 10000 });

    await expect(branchWarning(page)).toContainText('Set Submission ref to refs/heads/master.', { timeout: 10000 });
    await openAdvanced(page);
    await expect(submissionRef(page), 'a probe never writes into an existing assignment').toHaveValue('refs/heads/main');

    // Writing into the form on probe would trip the unsaved-changes guard on an
    // assignment nobody touched.
    await page.locator('.new-btn').click();
    expect(dialogs, 'opening an assignment must not make it look edited').toEqual([]);
  });
});
