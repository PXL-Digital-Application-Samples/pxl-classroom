// 71 - A template in another organization must be public.
//
// MEASURED on the live testbed 2026-09-07, by running the real acceptance and
// provisioning chain rather than reading the documentation (which was
// ambiguous enough that the prediction came out backwards once):
//
//   public template, another org        -> WORKS. `contains-studio/agents`
//                                          generated into a private student
//                                          repository, invitation sent. A
//                                          STRANGER'S repository - the token
//                                          does not authenticate as the
//                                          lecturer, so ownership is
//                                          irrelevant to whether it works.
//   private, another org, App INSTALLED -> HTTP 404, on PXL-Automation-II,
//                                          an org the App IS installed on.
//                                          A token is minted per installation
//                                          and `generate` is ONE call.
//
// Why the form is where this has to be caught: the pre-flight probe runs on
// the LECTURER'S token, and a lecturer can see their own private repository in
// another organization perfectly well. So the badge went green on the one
// configuration that cannot work, publishing said nothing, and the failure
// surfaced inside provisioning - after a student had clicked accept, after
// their acceptance was recorded and had spent a slot of `max_acceptances`.
// What that student saw was a waiting screen and then a timeout; what the
// lecturer got was `HTTP 404` naming a repository open in their other tab.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const templateBox = (page) => page.getByPlaceholder('Type or select a template repository');
const saveDraft = (page) => page.getByRole('button', { name: 'Save as draft' }).first();
const fieldError = (page) => page.locator('.field .field-error-msg');

/**
 * Answer `GET /repos/{owner}/{repo}` for the template probe.
 *
 * Registered AFTER the standard routes so it wins - Playwright matches in
 * reverse registration order, and the fixture carries a catch-all for
 * `/repos/`.
 */
async function routeTemplateRepo(page, { owner, repo, isPrivate, isTemplate = true }) {
  await page.route(`**/repos/${owner}/${repo}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        full_name: `${owner}/${repo}`,
        name: repo,
        private: isPrivate,
        is_template: isTemplate,
        default_branch: 'main',
        html_url: `https://github.com/${owner}/${repo}`,
      }),
    });
  });
}

async function openFormWithTemplate(page, template) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
  const [owner, repo] = template.full.split('/');
  await routeTemplateRepo(page, { owner, repo, isPrivate: template.isPrivate });

  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('.new-btn').click();
  await templateBox(page).fill(template.full);
  // The probe is debounced by 400ms; the badge is what says it has landed.
  await expect(page.locator('.template-preflight-badge')).toBeVisible({ timeout: 10000 });
}

test.describe('71 - a private template in another organization', () => {
  test('THE REGRESSION: it is refused, where a green badge used to be', async ({ page }) => {
    await openFormWithTemplate(page, { full: 'colleague-org/python-starter', isPrivate: true });

    await expect(page.locator('.badge-error', { hasText: 'Private template in another organization' }))
      .toBeVisible({ timeout: 10000 });
    await expect(page.locator('.badge-success')).toHaveCount(0);
  });

  test('and the sentence says what to do about it, on GitHub', async ({ page }) => {
    // Four words in a badge is not an instruction. The lecturer is about to
    // object "but I own it", so the message answers that before they do.
    await openFormWithTemplate(page, { full: 'colleague-org/python-starter', isPrivate: true });

    const msg = fieldError(page).filter({ hasText: 'colleague-org/python-starter' });
    await expect(msg).toBeVisible({ timeout: 10000 });
    await expect(msg).toContainText('even one you own');
    await expect(msg).toContainText(/make .* public/i);
    await expect(msg).toContainText(`copy it into ${ORG}`);
  });

  test('the save does not go through, and lifts as soon as it is fixable', async ({ page }) => {
    // The whole point. Saving it produces an assignment that looks correct on
    // every surface and cannot provision a single student.
    //
    // Asserted in BOTH directions on purpose: "the button is disabled" alone
    // passes just as well when the button is disabled for some unrelated
    // reason - a missing title, a form that never enables - and would keep
    // passing if this check were deleted tomorrow. Watching it become enabled
    // when the only thing that changed is the template's owner is what ties
    // the disabled state to this rule.
    const contentWrites = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, contentWrites });
    await routeTemplateRepo(page, { owner: 'colleague-org', repo: 'python-starter', isPrivate: true });
    await routeTemplateRepo(page, { owner: ORG, repo: 'starter-template', isPrivate: true });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Cross Org Lab');

    await templateBox(page).fill('colleague-org/python-starter');
    await expect(page.locator('.badge-error')).toBeVisible({ timeout: 10000 });
    await expect(saveDraft(page), 'a template that cannot provision must not be saveable').toBeDisabled();
    expect(contentWrites.filter((w) => String(w.path).startsWith('assignments/'))).toEqual([]);

    // Same form, same title, one field changed: the org's own private
    // template, which is the ordinary case.
    await templateBox(page).fill(`${ORG}/starter-template`);
    await expect(page.locator('.badge-success')).toBeVisible({ timeout: 10000 });
    await expect(saveDraft(page), 'and the refusal must lift when the template can').toBeEnabled();
  });
});

test.describe('71 - what must NOT be refused', () => {
  test('a PUBLIC template in another organization is fine - it was measured working', async ({ page }) => {
    // The feature this whole exercise exists to support. Refusing it would
    // break the case that provably works, which is the failure mode of a
    // guard written from documentation instead of measurement.
    await openFormWithTemplate(page, { full: 'colleague-org/python-starter', isPrivate: false });

    await expect(page.locator('.badge-success')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.badge-error')).toHaveCount(0);
  });

  test("a PRIVATE template in the assignment's own organization is untouched", async ({ page }) => {
    // The ordinary case, and the overwhelming majority of assignments. The App
    // is installed here, so private is exactly right.
    await openFormWithTemplate(page, { full: `${ORG}/starter-template`, isPrivate: true });

    await expect(page.locator('.badge-success')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.badge-success')).toContainText('private');
    await expect(page.locator('.badge-error')).toHaveCount(0);
  });

  test('the owner is matched case-insensitively, not with a raw !==', async ({ page }) => {
    // lib/github-login.mjs exists because a hand-written comparison already
    // split one student into two rows. Here the same mistake would refuse an
    // organization's OWN private template over its casing - the org's name is
    // typed by a human in one place and dispatched by GitHub in another.
    await openFormWithTemplate(page, { full: `${ORG.toUpperCase()}/starter-template`, isPrivate: true });

    await expect(page.locator('.badge-success')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.badge-error')).toHaveCount(0);
  });
});
