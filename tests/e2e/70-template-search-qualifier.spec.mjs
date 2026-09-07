// 70 - The template picker's search, against a GitHub that behaves like GitHub.
//
// Reported live on 2026-09-07: a lecturer ticked **Template repository** on a
// private repo mid-demo, opened the Admin Panel, and it was not in the picker.
// The repository was correct - `is_template: true`, created 13:10 - and the
// panel said the organization had none.
//
// The query was `org:<org> is:template fork:true`. `is:` takes a fixed
// vocabulary and `template` is not in it, so GitHub DROPPED the term and
// answered with the whole organization. Measured that day on
// PXL-Automation-II: `org:X` -> 93, `org:X is:template` -> the same 93,
// `org:X template:true` -> 11.
//
// What hid it for a year is the client-side `.filter(r => r.is_template)`
// behind the call. On an org under 100 repositories the page cap never bites,
// the filter trims the superset back to exactly the right answer, and the
// picker is perfect. Above it, `per_page=100` throws results away FIRST and the
// filter salvages whatever survived - 5 of that org's 11 templates, in an order
// no lecturer can predict.
//
// So the bug is invisible from the response: no error, no empty state, a 200
// that is a superset of the truth, and the `listOrgRepos` fallback never runs
// because the search SUCCEEDED. Only two things can catch it - the query string
// (tests/template-search.test.mjs) and a mock that applies the qualifiers the
// way GitHub applies them, which is this file. Everything below hangs on
// `searchLikeGitHub` ignoring `is:template` exactly as the real API does: a
// mock that honours a qualifier GitHub throws away would have passed all year.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

const templateEmpty = (page) => page.locator('.template-empty');
const templateBox = (page) => page.getByPlaceholder('Type or select a template repository');

const repo = (name, { template = false, fork = false } = {}) => ({
  full_name: `${ORG}/${name}`,
  name,
  is_template: template,
  fork,
});

/**
 * GitHub's repository search, as far as this picker can tell.
 *
 * Four behaviours, and the first one is the whole point:
 *
 *   1. An unknown `is:<value>` is IGNORED, not refused. `is:template` narrows
 *      nothing and the query stays a 200.
 *   2. `template:true` is the qualifier that filters on the template flag.
 *   3. Forks are omitted unless the query says `fork:true`.
 *   4. `per_page` caps the ITEMS; `total_count` still reports the full match
 *      count, which is how a truncated answer looks like a complete one.
 */
async function searchLikeGitHub(page, repos, { onQuery = () => {} } = {}) {
  await page.route('**/search/repositories*', async (route) => {
    const url = new URL(route.request().url());
    const q = decodeURIComponent(url.searchParams.get('q') || '');
    onQuery(q);

    let matched = repos;
    if (!/\bfork:true\b/.test(q)) matched = matched.filter((r) => !r.fork);
    if (/\btemplate:true\b/.test(q)) matched = matched.filter((r) => r.is_template);
    // `in:name` with a free term is the OTHER caller of this endpoint
    // (listOrgRepos with a prefix). Modelled so it cannot answer nonsense.
    const prefix = /\bin:name\b/.test(q) && q.match(/(?:^|\s)([^\s:]+)(?=\s+in:name)/);
    if (prefix) matched = matched.filter((r) => r.name.startsWith(prefix[1]));

    const perPage = Number(url.searchParams.get('per_page')) || 30;
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ total_count: matched.length, items: matched.slice(0, perPage) }),
    });
  });
}

/** An org bigger than one page, with the templates deliberately late in it. */
function bigOrg({ templates = ['2627-pe-1'], filler = 130 } = {}) {
  const repos = Array.from({ length: filler }, (_, i) => repo(`course-repo-${String(i).padStart(3, '0')}`));
  return [...repos, ...templates.map((t) => repo(t, { template: true }))];
}

async function openCreateForm(page, repos, opts) {
  const seen = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
  await searchLikeGitHub(page, repos, { onQuery: (q) => seen.push(q), ...opts });
  await page.goto(`/dashboard/${ORG}/admin`);
  await page.locator('.new-btn').click();
  return { seen };
}

test.describe('70 - a template past the first page of results', () => {
  test('THE REGRESSION: the template ticked during the demo is in the picker', async ({ page }) => {
    // 130 repositories, one template, and it is the 131st thing the unfiltered
    // search would return. With `is:template` the response is the first 100
    // repositories of an org-wide match and this template is not among them -
    // the panel then states, in a bordered box, that the organization has no
    // templates at all.
    await openCreateForm(page, bigOrg());

    await expect(templateEmpty(page), 'the org HAS a template - the wall is a false claim').toHaveCount(0);
    // One template, so the form fills it in for the lecturer.
    await expect(templateBox(page)).toHaveValue(`${ORG}/2627-pe-1`, { timeout: 5000 });
  });

  test('every template is found, not the ones that fit in the first hundred', async ({ page }) => {
    // The live shape: 11 templates in an org of 250-odd repositories, of which
    // the old query surfaced 5. A count is what the lecturer reads, and a
    // count that is quietly short is worse than an error.
    const templates = Array.from({ length: 11 }, (_, i) => `template-${i}`);
    await openCreateForm(page, bigOrg({ templates, filler: 250 }));

    await expect(page.locator('text=Found 11 template repositories')).toBeVisible({ timeout: 5000 });
  });

  test('the query narrows at GitHub, so the page cap never has to be argued about', async ({ page }) => {
    // The fix is not "raise per_page" or "walk the pages" - it is to ask the
    // question that fits. This asserts the request that left the browser,
    // because the response cannot tell you which question was asked.
    const { seen } = await openCreateForm(page, bigOrg());
    await expect(templateBox(page)).toHaveValue(`${ORG}/2627-pe-1`, { timeout: 5000 });

    const q = seen.find((s) => s.includes('template:true'));
    expect(q, 'the picker must filter on template:true at the API').toBeTruthy();
    expect(q, 'a qualifier GitHub ignores is a query for the whole org').not.toContain('is:template');
  });
});

test.describe('70 - the qualifiers hold each other up', () => {
  test('a forked template past the cap survives both rules at once', async ({ page }) => {
    // The two known blind spots on one query: forks are hidden by default, and
    // an org-wide match gets truncated. A fix for either that drops the other
    // fails here rather than a year from now.
    const repos = [...bigOrg({ templates: [] }), repo('forked-template', { template: true, fork: true })];
    await openCreateForm(page, repos);

    await expect(templateEmpty(page)).toHaveCount(0);
    await expect(templateBox(page)).toHaveValue(`${ORG}/forked-template`, { timeout: 5000 });
  });

  test('a non-template the API hands back anyway is still refused', async ({ page }) => {
    // Belt and braces, in that order. The client-side `is_template` filter
    // stays - it is only the bug when it is asked to BE the filter, running
    // after the page cap has already thrown the answer away.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    // Registered AFTER the standard routes: Playwright matches in reverse
    // order of registration, so a route added first is the one that loses.
    await page.route('**/search/repositories*', async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({
          total_count: 2,
          items: [repo('really-a-template', { template: true }), repo('not-a-template')],
        }),
      });
    });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateBox(page)).toHaveValue(`${ORG}/really-a-template`, { timeout: 5000 });
    await templateBox(page).fill('');
    await expect(page.locator('.template-option', { hasText: 'not-a-template' })).toHaveCount(0);
  });
});

// ================================================== one page is not the list

/**
 * The search endpoint as a PAGED endpoint.
 *
 * `total_count` is the whole collection and is repeated on every page - the
 * two things a caller can cross-check. `link: rel="next"` needs
 * `access-control-expose-headers`, or JS cannot read it on a cross-origin
 * response and the walk quietly sees one page. (That is a real failure mode,
 * not mock trivia: it is invisible in the browser and looks exactly like a
 * short org.)
 */
async function routeSearchPages(page, repos, { failPage = null, omitLink = false, endless = false } = {}) {
  const PER = 100;
  await page.route('**/search/repositories*', async (route) => {
    const url = new URL(route.request().url());
    const p = Number(url.searchParams.get('page') || 1);
    if (failPage === p) {
      await route.fulfill({ status: 502, body: JSON.stringify({ message: 'bad gateway' }) });
      return;
    }
    const items = repos.slice((p - 1) * PER, p * PER);
    const more = endless || (!omitLink && p * PER < repos.length);
    const next = new URL(url);
    next.searchParams.set('page', String(p + 1));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: more
        ? { link: `<${next}>; rel="next"`, 'access-control-expose-headers': 'link' }
        : { 'access-control-expose-headers': 'link' },
      // total_count is the COLLECTION, not the page - which is what makes a
      // missing Link header detectable rather than merely absent.
      body: JSON.stringify({ total_count: repos.length, items }),
    });
  });
}

/** The REST fallback, answering the same question the other way. */
async function routeOrgReposFallback(page, repos, { status = 200 } = {}) {
  await page.route(`**/orgs/${ORG}/repos*`, (route) =>
    route.fulfill({
      status,
      body: JSON.stringify(status === 200 ? repos : { message: 'nope' }),
    }));
}

test.describe('70 - one page is not the list', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => repo(`template-${String(i).padStart(3, '0')}`, { template: true }));

  test('a template on page two is found', async ({ page }) => {
    // "Found N template repositories" is a statement about the whole
    // collection, and so is the wall that says there are none. Both were being
    // made from a single per_page=100 read.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeSearchPages(page, many(150));

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await expect(page.locator('text=Found 150 template repositories')).toBeVisible({ timeout: 5000 });
  });

  test('a failed page is not a short list', async ({ page }) => {
    // Page one arrives, page two 502s. The walk has 100 real templates in hand
    // and they are NOT the answer - the fallback runs and answers in full.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeSearchPages(page, many(150), { failPage: 2 });
    await routeOrgReposFallback(page, many(150));

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await expect(page.locator('text=Found 150 template repositories')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Found 100 template repositories')).toHaveCount(0);
  });

  test('a missing Link header does not turn 120 templates into 100', async ({ page }) => {
    // The case a Link-only walk cannot see. GitHub omits Link when a response
    // fits on one page, so "no next page" and "we were not told about the next
    // page" are the same wire bytes - and the difference is a silently short
    // list. total_count is the second source that settles it.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeSearchPages(page, many(120), { omitLink: true });
    await routeOrgReposFallback(page, many(120));

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await expect(page.locator('text=Found 120 template repositories')).toBeVisible({ timeout: 5000 });
  });

  test('a Link header that never ends hits the cap and is not reported as the list', async ({ page }) => {
    // A malformed or self-referential Link header is what the page cap is
    // actually for - nobody has a thousand templates. Whatever it collected,
    // it cannot show it is the whole list.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeSearchPages(page, many(150), { endless: true });
    await routeOrgReposFallback(page, many(150));

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await expect(page.locator('text=Found 150 template repositories')).toBeVisible({ timeout: 15000 });
  });

  test('and when the fallback cannot answer either, it says so', async ({ page }) => {
    // The end of the chain. A partial search plus a failed listing is no
    // knowledge at all - not a short list, and not the wall, which would send
    // a lecturer to create the templates they already have.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await routeSearchPages(page, many(150), { failPage: 2 });
    await routeOrgReposFallback(page, [], { status: 503 });

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateEmpty(page), 'we never established that it has none').toHaveCount(0);
    await expect(page.locator('text=Found 100 template repositories')).toHaveCount(0);
    await expect(page.locator('.text-danger', { hasText: 'Failed to load templates' })).toBeVisible({ timeout: 5000 });
  });
});

test.describe('70 - the narrower query can still say "none"', () => {
  test('an organization with no templates still gets the wall', async ({ page }) => {
    // The fix must not make an empty answer unreachable. `template:true`
    // returning nothing on an org full of ordinary repositories is the case
    // the wall exists for, and it is now the ONLY way to reach it - which is
    // why it is asserted here rather than assumed from spec 32.
    await openCreateForm(page, bigOrg({ templates: [], filler: 40 }));

    await expect(templateEmpty(page)).toBeVisible({ timeout: 5000 });
    await expect(templateEmpty(page)).toContainText('Template repository');
  });

  test('and an unanswered search is not an empty organization', async ({ page }) => {
    // Unchanged by this fix, and re-asserted because the fix touched the leg
    // above it: a failed search falls through to listOrgRepos, and a failure
    // THERE is no evidence rather than evidence of none.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.route('**/search/repositories*', (route) =>
      route.fulfill({ status: 503, body: JSON.stringify({ message: 'nope' }) }));
    await page.route(`**/orgs/${ORG}/repos*`, (route) =>
      route.fulfill({ status: 503, body: JSON.stringify({ message: 'nope' }) }));

    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();

    await expect(templateEmpty(page), 'we do not know that it has none').toHaveCount(0);
  });
});
