// 78 - "students start from nothing" still needs a repository.
//
// 2026-09-17, twice: pxl-werkplekleren published an assignment on a repository
// called `empty-template` and lost both acceptances to `generate HTTP 422 Could
// not clone: ... is empty`, and a lecturer asked the same evening whether the
// template could be skipped the way GitHub Classroom allowed. It cannot be
// skipped; it can be made in one click.
//
// The judge is unit-tested (tests/blank-starter.test.mjs). What is here is the
// half a unit test cannot reach: that the button is wired to the call, that
// what comes back reaches the template field through the same probe a picked
// template gets, and - the one that matters - that a REFUSED create leaves the
// field alone rather than adopting a repository somebody else's assignment may
// own.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const titleBox = (page) => page.getByPlaceholder('e.g. Linux Processes 2026');
const templateBox = (page) => page.getByPlaceholder('Type or select a template repository');
const blankStarter = (page) => page.locator('.blank-starter');
// The block holds exactly one button, and its LABEL CHANGES while the request
// is in flight ("Creating…"), so an accessible-name locator stops matching at
// the one moment a test wants to look at it. Locate the element, assert the
// label where the label is the subject.
const createBtn = (page) => blankStarter(page).locator('button');

/**
 * Answer the create, and record what was asked for.
 *
 * Registered after the standard routes so it wins, and matched on POST alone:
 * `GET /orgs/{org}/repos` is the template list's own fallback leg and must keep
 * falling through to the fixture.
 */
async function routeCreate(page, reply) {
  const asked = [];
  await page.route(`**/orgs/${ORG}/repos`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    asked.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({
      status: reply.status,
      contentType: 'application/json',
      body: JSON.stringify(reply.body),
    });
  });
  return asked;
}

/** The probe that runs the moment the field is filled in. */
async function routeStarterRepo(page, name) {
  await page.route(`**/repos/${ORG}/${name}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 9001,
        full_name: `${ORG}/${name}`,
        name,
        private: true,
        is_template: true,
        default_branch: 'main',
        html_url: `https://github.com/${ORG}/${name}`,
      }),
    });
  });
}

/** Hold the create until the test lets it go, so "in flight" can be asserted. */
async function routeHeldCreate(page, reply) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(`**/orgs/${ORG}/repos`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await held;
    await route.fulfill({
      status: reply.status,
      contentType: 'application/json',
      body: JSON.stringify(reply.body),
    });
  });
  return () => release();
}

async function openForm(page, opts = {}) {
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {}, ...opts });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('.new-btn').click();
  await expect(titleBox(page)).toBeVisible({ timeout: 10000 });
}

test.describe('78 - the blank starter', () => {
  test('it waits for a title, because the name is derived from the slug', async ({ page }) => {
    await openForm(page);

    await expect(createBtn(page)).toBeDisabled();
    await expect(blankStarter(page)).toContainText('Title the assignment first');

    await titleBox(page).fill('Portfolio');
    await expect(createBtn(page)).toBeEnabled();
    await expect(createBtn(page)).toHaveText(/Create a blank starter/);
    // The name it will make is on screen BEFORE the click, not reported after.
    await expect(blankStarter(page)).toContainText(`${ORG}/starter-portfolio`);
  });

  test('one call sets the commit and the checkbox, and the field fills itself', async ({ page }) => {
    await openForm(page);
    const asked = await routeCreate(page, {
      status: 201,
      body: { id: 9001, name: 'starter-portfolio', full_name: `${ORG}/starter-portfolio` },
    });
    await routeStarterRepo(page, 'starter-portfolio');

    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();

    await expect(templateBox(page)).toHaveValue(`${ORG}/starter-portfolio`, { timeout: 10000 });
    // The two things a lecturer doing this by hand gets wrong. Asserted on the
    // request body rather than on the button's own report of itself.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      name: 'starter-portfolio',
      auto_init: true,
      is_template: true,
      private: true,
    });
    // And it went through the ordinary probe, which is what takes the pin and
    // the submission ref - not a written-in `refs/heads/main`.
    await expect(page.locator('.template-preflight-badge .badge-success')).toBeVisible({ timeout: 10000 });
  });

  test('THE REGRESSION: a name that exists is refused, and nothing is adopted', async ({ page }) => {
    await openForm(page);
    // The body measured on the testbed, 2026-09-17, by creating the same name
    // twice. A repository called `starter-portfolio` may be last year's
    // `portfolio` assignment: the name pins the slug, not the assignment id.
    await routeCreate(page, {
      status: 422,
      body: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    });

    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();

    await expect(blankStarter(page).locator(".field-error-msg")).toContainText('already exists', { timeout: 10000 });
    await expect(blankStarter(page).locator(".field-error-msg")).toContainText('has not been adopted');
    // The field is untouched: the refusal did not quietly point the assignment
    // at whatever was standing there.
    await expect(templateBox(page)).toHaveValue('');
  });

  test('a lecturer who may not create repositories keeps the manual route', async ({ page }) => {
    await openForm(page);
    await routeCreate(page, {
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    });

    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();

    await expect(blankStarter(page).locator(".field-error-msg"))
      .toContainText('not allowed to create repositories', { timeout: 10000 });
    await expect(templateBox(page)).toHaveValue('');
    // The button is not left spinning: it says what happened and can be tried
    // again once an owner has granted it.
    await expect(createBtn(page)).toBeEnabled();
  });
});

test.describe('78 - where the offer is, and is not', () => {
  test('an existing assignment is never offered it', async ({ page }) => {
    // It would repoint a template students may already hold repositories
    // generated from. The pin would catch the swap and warn, which is not a
    // reason to walk up to it.
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
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [ID]: stored } });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.assignment-list li', { hasText: 'Java Lab' }).first().click();
    await expect(templateBox(page)).toHaveValue(`${ORG}/java-start`, { timeout: 10000 });

    await expect(blankStarter(page)).toHaveCount(0);
  });

  test('it goes away once a template is named, and comes back when the field is cleared', async ({ page }) => {
    // An offer that has been answered is not an offer: left standing it would
    // propose creating a repository over the one just chosen, and a second
    // press would be refused as a name clash.
    await openForm(page);
    await titleBox(page).fill('Portfolio');
    await expect(createBtn(page)).toBeEnabled();

    await templateBox(page).fill(`${ORG}/something-else`);
    await expect(blankStarter(page)).toHaveCount(0);

    await templateBox(page).fill('');
    await expect(blankStarter(page)).toBeVisible();
    await expect(blankStarter(page)).toContainText(`${ORG}/starter-portfolio`);
  });

  test('the name follows the title as it is typed, rather than freezing on the first one', async ({ page }) => {
    await openForm(page);
    await titleBox(page).fill('Portfolio');
    await expect(blankStarter(page)).toContainText(`${ORG}/starter-portfolio`);

    await titleBox(page).fill('Cloud Essentials Lab');
    await expect(blankStarter(page)).toContainText(`${ORG}/starter-cloud-essentials-lab`);
  });

  test('the created repository joins the list without a refresh', async ({ page }) => {
    await openForm(page);
    await routeCreate(page, {
      status: 201,
      body: { id: 9001, name: 'starter-portfolio', full_name: `${ORG}/starter-portfolio` },
    });
    await routeStarterRepo(page, 'starter-portfolio');
    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();
    await expect(templateBox(page)).toHaveValue(`${ORG}/starter-portfolio`, { timeout: 10000 });

    // Clear the field and open the dropdown: it is in there, top of the list,
    // without anybody pressing the refresh button.
    await templateBox(page).fill('');
    await templateBox(page).click();
    await expect(page.locator('.combobox-item').first()).toContainText(`${ORG}/starter-portfolio`);
  });
});

test.describe('78 - while it is in flight', () => {
  test('the button says so, is disabled, and a second press sends nothing', async ({ page }) => {
    await openForm(page);
    // Count every POST, including any the guard fails to stop.
    let posts = 0;
    await page.route(`**/orgs/${ORG}/repos`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts += 1;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 9001, name: 'starter-portfolio', full_name: `${ORG}/starter-portfolio` }),
      });
    });
    await routeStarterRepo(page, 'starter-portfolio');

    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();
    await expect(templateBox(page)).toHaveValue(`${ORG}/starter-portfolio`, { timeout: 10000 });
    expect(posts).toBe(1);
  });

  test('THE RACE: a template named while the create is in flight is not overwritten', async ({ page }) => {
    // The offer disappears the moment the field is non-empty, but the request
    // it started does not. A create landing two seconds later must not replace
    // the repository the lecturer picked in the meantime.
    await openForm(page);
    const release = await routeHeldCreate(page, {
      status: 201,
      body: { id: 9001, name: 'starter-portfolio', full_name: `${ORG}/starter-portfolio` },
    });

    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();
    await expect(createBtn(page)).toBeDisabled();
    await expect(createBtn(page)).toContainText('Creating');

    // They give up waiting and type a template of their own.
    await templateBox(page).fill(`${ORG}/my-own-template`);
    release();

    // The field still says what they typed, and the toast says the repository
    // exists rather than silently discarding it.
    await expect(page.locator('.toast, .toast-success')).toContainText('left alone', { timeout: 10000 });
    await expect(templateBox(page)).toHaveValue(`${ORG}/my-own-template`);
  });
});

test.describe('78 - failures that are not a refusal', () => {
  test('a dead network says the repository MAY exist, because it cannot know', async ({ page }) => {
    // The request failed on the way out or on the way back. "Nothing was
    // changed" would be a claim this branch cannot make (DESIGN.md §1.5).
    await openForm(page);
    await page.route(`**/orgs/${ORG}/repos`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.abort('connectionfailed');
    });

    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();

    const err = blankStarter(page).locator('.field-error-msg');
    await expect(err).toContainText('may', { timeout: 10000 });
    await expect(err).not.toContainText('Nothing was changed');
    await expect(createBtn(page)).toBeEnabled();
  });

  test("a name GitHub rejects reports GitHub's reason, not its useless summary", async ({ page }) => {
    await openForm(page);
    await routeCreate(page, {
      status: 422,
      body: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', field: 'name', message: 'name is too long (maximum is 100 characters)' }],
      },
    });

    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();

    const err = blankStarter(page).locator('.field-error-msg');
    await expect(err).toContainText('name is too long', { timeout: 10000 });
    // Not read as a name clash - the field is untouched either way, but the
    // lecturer is not sent looking for a repository that does not exist.
    await expect(err).not.toContainText('already exists');
  });

  test('a 500 leaves the form exactly as it was', async ({ page }) => {
    await openForm(page);
    await routeCreate(page, { status: 500, body: { message: 'Server Error' } });

    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();

    await expect(blankStarter(page).locator('.field-error-msg')).toContainText('HTTP 500', { timeout: 10000 });
    await expect(templateBox(page)).toHaveValue('');
    await expect(page.locator('.template-preflight-badge')).toHaveCount(0);
  });

  test('created, but unreadable afterwards: the field fills and the badge does NOT go green', async ({ page }) => {
    // The create worked; the probe that follows it did not. A green badge here
    // would be the form asserting something it never read.
    await openForm(page);
    await routeCreate(page, {
      status: 201,
      body: { id: 9001, name: 'starter-portfolio', full_name: `${ORG}/starter-portfolio` },
    });
    await page.route(`**/repos/${ORG}/starter-portfolio`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) });
    });

    await titleBox(page).fill('Portfolio');
    await createBtn(page).click();

    await expect(templateBox(page)).toHaveValue(`${ORG}/starter-portfolio`, { timeout: 10000 });
    await expect(page.locator('.template-preflight-badge .badge-success')).toHaveCount(0);
    await expect(page.locator('.template-preflight-badge .badge-error')).toBeVisible({ timeout: 10000 });
  });
});

test.describe('78 - the one button', () => {
  test('the empty-organization box has no button of its own, only a link', async ({ page }) => {
    // Two grey `+ Create …` buttons four lines apart read as two spellings of
    // one action. Going to GitHub is a link, so it looks like one.
    await openForm(page);
    const box = page.locator('.template-empty');
    await expect(box).toBeVisible();
    await expect(box.locator('.btn')).toHaveCount(0);
    const link = box.getByRole('link', { name: /Create one on GitHub/i });
    await expect(link).toHaveAttribute('href', `https://github.com/organizations/${ORG}/repositories/new`);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('and the field carries exactly one button beside the refresh icon', async ({ page }) => {
    await openForm(page);
    await titleBox(page).fill('Portfolio');
    const field = page.locator('.field', { has: templateBox(page) });
    // The refresh icon and the blank starter. Nothing else, and no primary.
    await expect(field.locator('button')).toHaveCount(2);
    await expect(field.locator('.btn-primary')).toHaveCount(0);
  });
});
