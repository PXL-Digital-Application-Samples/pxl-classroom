// The Sync Starter Code dialog sends each student what THEY are missing, and
// shows it before it is sent.
//
// 2026-09-25, PXL-2TIN-NetAdv-26-27: lab 3 reached 31 of 111 students before
// its run stopped, lab 4 was synced over it, and a dialog that only ever
// offered the newest commit's files could never have sent lab 3 to the other
// 43. Here a student generated at lab 2 has lab 4 but not lab 3; the dialog
// must list lab 3 as an earlier change they are missing, count them as
// updated, and send a selection that carries it - `["*"]`, or `["*", "!path"]`
// once the lecturer unticks it.
//
// Spec 09 covers the fallback: its fixture's commits carry no tree, so every
// student there starts "unknown" and is planned the old way.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes, openStarterSyncModal } from '../fixtures/e2e-fixtures.mjs';

const TPL = 'template-labs';
const LAB2 = '2'.repeat(40);
const LAB3 = '3'.repeat(40);
const LAB4 = '4'.repeat(40);
const repoOf = (s) => `lab-catchup-${s.login}`;

const T = {
  [LAB2]: { 'README.md': 'r1', 'Lab02/Program.cs': 'b2' },
  [LAB3]: { 'README.md': 'r1', 'Lab02/Program.cs': 'b2', 'Lab03/Program.cs': 'b3' },
  [LAB4]: { 'README.md': 'r1', 'Lab02/Program.cs': 'b2', 'Lab03/Program.cs': 'b3', 'Lab04/Program.cs': 'b4' },
};
const TREE_SHA = { [LAB2]: 'tree-lab2', [LAB3]: 'tree-lab3', [LAB4]: 'tree-lab4' };

// STUDENT_1 was generated at lab 2 and received lab 4, never lab 3.
// STUDENT_2 was generated at lab 4.
const BASE_ROOT = { [repoOf(STUDENT_1)]: 'tree-lab2', [repoOf(STUDENT_2)]: 'tree-lab4' };
let ROOT = BASE_ROOT;

// `swapped`: STUDENT_1 was created from a DIFFERENT template - the assignment's
// template was changed after they accepted - so their first commit matches no
// commit of this one (2026-09-25, PXL-Automation-II / 2627-pe-1-test-1).
const OLD_STARTER = { 'README.md': 'old-readme', 'old-notes.md': 'o' };

async function setup(page, { swapped = false } = {}) {
  ROOT = swapped ? { ...BASE_ROOT, [repoOf(STUDENT_1)]: 'tree-old' } : BASE_ROOT;
  const workflowDispatches = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    workflowDispatches,
    gitTrees: {
      [`${ORG}/${TPL}@${LAB2}`]: T[LAB2],
      [`${ORG}/${TPL}@${LAB3}`]: T[LAB3],
      [`${ORG}/${TPL}@${LAB4}`]: T[LAB4],
      [`${ORG}/${repoOf(STUDENT_1)}@main`]: swapped ? OLD_STARTER : { ...T[LAB2], 'Lab02/Program.cs': 'their-work', 'Lab04/Program.cs': 'b4' },
      [`${ORG}/${repoOf(STUDENT_1)}@tree-old`]: OLD_STARTER,
      [`${ORG}/${repoOf(STUDENT_2)}@main`]: T[LAB4],
    },
    assignments: {
      'lab-catchup': {
        id: 'lab-catchup',
        title: 'Labs with catch-up',
        organization: ORG,
        state: 'published',
        assignment_type: 'individual',
        template: { owner: ORG, repository: TPL },
      },
    },
    reports: {
      'lab-catchup': {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        assignment_id: 'lab-catchup',
        students: [STUDENT_1, STUDENT_2].map((s) => ({
          github_login: s.login,
          acceptance_state: 'provisioned',
          submission_status: 'on-time',
          repo_name: `${ORG}/${repoOf(s)}`,
        })),
      },
    },
  });

  // Registered after the standard routes, so these answer first: the
  // template's history with its trees, the newest commit's detail, and each
  // student's first commit behind a `last` link - the reads a starting point
  // is found with.
  await page.route(/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits(\/[0-9a-f]{40})?(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const [, , owner, repo, , sha] = url.pathname.split('/');
    if (owner !== ORG) return route.fallback();
    if (repo === TPL && sha) {
      return route.fulfill({
        status: 200,
        body: JSON.stringify({
          sha,
          parents: [{ sha: LAB3 }],
          commit: { message: 'add lab 4 startcode', author: { name: 'Lecturer Alice', date: new Date().toISOString() } },
          files: [{ filename: 'Lab04/Program.cs', status: 'added', additions: 1, deletions: 0, patch: '+// lab 4' }],
        }),
      });
    }
    if (repo === TPL) {
      const page = Number(url.searchParams.get('page') || 1);
      const rows = [LAB4, LAB3, LAB2].map((s) => ({
        sha: s,
        commit: {
          message: s === LAB4 ? 'add lab 4 startcode' : 'earlier lab',
          tree: { sha: TREE_SHA[s] },
          author: { name: 'Lecturer Alice', date: new Date().toISOString() },
          committer: { date: new Date().toISOString() },
        },
      }));
      return route.fulfill({ status: 200, body: JSON.stringify(page === 1 ? rows : []) });
    }
    if (ROOT[repo]) {
      const page = Number(url.searchParams.get('page') || 1);
      const headers = { link: `<https://api.github.com/repos/${ORG}/${repo}/commits?sha=main&per_page=1&page=4>; rel="last"`, 'access-control-expose-headers': 'Link' };
      const row = page === 4 ? { sha: 'r'.repeat(40), commit: { tree: { sha: ROOT[repo] } } } : { sha: 'n'.repeat(40), commit: { tree: { sha: 'tip' } } };
      return route.fulfill({ status: 200, headers, body: JSON.stringify([row]) });
    }
    return route.fallback();
  });

  return { workflowDispatches };
}

test.describe('80 - Starter sync sends each student what they are missing', () => {
  test('an earlier change a student missed is listed, counted and sent', async ({ page }) => {
    const { workflowDispatches } = await setup(page);
    await page.goto(`/dashboard/${ORG}/lab-catchup`);
    await openStarterSyncModal(page);
    const modal = page.locator('.modal.card.modal-wide');
    await expect(modal).toBeVisible();

    // The newest commit's file, as before.
    await expect(modal.locator('.file-path', { hasText: 'Lab04/Program.cs' })).toBeVisible();
    // And what one student is behind on from before it.
    await expect(modal.locator('.catch-up-head')).toContainText('Earlier template changes some students are still missing (1/1 selected)');
    // The newest commit's own count stays its own: 1 file, not 1 + the catch-up.
    await expect(modal.locator('.file-selector-box')).toContainText('Files this commit changed (1/1 selected)');
    const catchUp = modal.locator('.file-row-box', { hasText: 'Lab03/Program.cs' });
    await expect(catchUp).toContainText('missing for 1 student');

    // STUDENT_1 gets lab 3 directly; STUDENT_2 has everything.
    await expect(modal.locator('.preflight-card.clean .preflight-count')).toHaveText('1');
    await expect(modal.locator('.preflight-card.skipped .preflight-count')).toHaveText('1');
    await expect(modal.locator('.preflight-card.conflict .preflight-count')).toHaveText('0');
    // Nobody's start was unknown, so nothing says so.
    await expect(modal.locator('.catch-up-note')).toHaveCount(0);

    await modal.locator('button', { hasText: /Apply Starter Update \(1 repos\)/i }).click();
    await expect(modal.locator('.dispatch-banner.success')).toBeVisible();
    const sent = workflowDispatches.find((d) => d.workflow === 'sync-starter-code.yml');
    expect(JSON.parse(sent.inputs.selected_files)).toEqual(['*']);
  });

  test('unticking the missed change leaves it out, and the preview says so first', async ({ page }) => {
    const { workflowDispatches } = await setup(page);
    await page.goto(`/dashboard/${ORG}/lab-catchup`);
    await openStarterSyncModal(page);
    const modal = page.locator('.modal.card.modal-wide');
    await expect(modal.locator('.preflight-card.clean .preflight-count')).toHaveText('1');

    await modal.locator('.file-row-box', { hasText: 'Lab03/Program.cs' }).locator('input[type="checkbox"]').uncheck();
    // Re-decided from what is already loaded: STUDENT_1 already has lab 4, so
    // without lab 3 there is nothing left to send anyone.
    await expect(modal.locator('.preflight-card.clean .preflight-count')).toHaveText('0');
    await expect(modal.locator('.preflight-card.skipped .preflight-count')).toHaveText('2');

    // Ticking the newest commit's file off too leaves no file at all.
    await modal.locator('.file-row-box', { hasText: 'Lab04/Program.cs' }).locator('input[type="checkbox"]').uncheck();
    await expect(modal.locator('button', { hasText: /Apply Starter Update/i })).toBeDisabled();
    await modal.locator('.file-row-box', { hasText: 'Lab04/Program.cs' }).locator('input[type="checkbox"]').check();

    await modal.locator('button', { hasText: /Apply Starter Update/i }).click();
    await expect(modal.locator('.dispatch-banner.success')).toBeVisible();
    const sent = workflowDispatches.find((d) => d.workflow === 'sync-starter-code.yml');
    expect(JSON.parse(sent.inputs.selected_files)).toEqual(['*', '!Lab03/Program.cs']);
  });

  test('a repository created from a different template is brought up to this one whole, and the dialog says so', async ({ page }) => {
    const { workflowDispatches } = await setup(page, { swapped: true });
    await page.goto(`/dashboard/${ORG}/lab-catchup`);
    await openStarterSyncModal(page);
    const modal = page.locator('.modal.card.modal-wide');

    // Named, not counted: the lecturer who changed the template needs to know whose.
    await expect(modal.locator('.catch-up-note')).toContainText(`The template changed since ${STUDENT_1.login} accepted, so the full starter code will be sent`);
    await expect(modal.locator('.catch-up-note')).not.toContainText(STUDENT_2.login);
    // Every file of this template is missing for them, not just the newest commit's.
    for (const f of ['README.md', 'Lab02/Program.cs', 'Lab03/Program.cs']) {
      await expect(modal.locator('.file-row-box', { hasText: f })).toContainText('missing for 1 student');
    }
    // Untouched old starter: replaced and removed in place, no pull request.
    await expect(modal.locator('.preflight-card.clean .preflight-count')).toHaveText('1');
    await expect(modal.locator('.preflight-card.conflict .preflight-count')).toHaveText('0');
    await expect(modal.locator('.preflight-card.skipped .preflight-count')).toHaveText('1');

    await modal.locator('button', { hasText: /Apply Starter Update \(1 repos\)/i }).click();
    await expect(modal.locator('.dispatch-banner.success')).toBeVisible();
    const sent = workflowDispatches.find((d) => d.workflow === 'sync-starter-code.yml');
    expect(JSON.parse(sent.inputs.selected_files)).toEqual(['*']);
  });
});
