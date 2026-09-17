// 58 - A student must not be handed the lecturer dashboard.
//
// Reported live with a screenshot, 2026-09-03. `tomccargo` - a test STUDENT
// account, not a member of PXL-Automation-II - signed in and saw the
// organization in the switcher, a "Lecturer" tag beside their name, and:
//
//   "Almost there - PXL-Automation-II needs its control repository"
//   [ Open Setup Organization ]
//
// The control repository existed. They simply could not read it, and GitHub
// returns 404 rather than 403 for a private repository you cannot see - so
// "does not exist" and "not yours" arrived identically and the page picked the
// friendlier one. The organization reaches the switcher for anyone whose App
// installation touches it, which accepting ONE assignment is enough to do.
//
// Nothing was exposed: every read behind that screen is the private control
// repo and every write is refused by GitHub. But a surface that hands a student
// a staff console and an admin button is its own defect - and it teaches them
// they have found a hole.
//
// THE FIXTURE COULD NOT EXPRESS THIS. "Student" meant "no installations at
// all", so no test could reach the dashboard as one; `studentHasInstallation`
// is what makes the reported situation reachable.

import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, injectAuth, setupStandardMockRoutes } from '../fixtures/e2e-fixtures.mjs';

/** The control repository is invisible - the 404 that means two things. */
async function controlRepoUnreadable(page) {
  await page.route(`**/api.github.com/repos/${ORG}/pxl-classroom-control*`, (route) =>
    route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
}

/** No write on the hub, which is what Setup Organization would need. */
async function noHubWrite(page) {
  await page.route('**/api.github.com/repos/PXL-Digital-Application-Samples/pxl-classroom', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ name: 'pxl-classroom', permissions: { push: false } }),
    }));
}

const REGISTRY_URL = '**/api.github.com/repos/PXL-Digital-Application-Samples/pxl-classroom/contents/participating-orgs.yml*';
const registryFile = (text) => ({
  status: 200,
  body: { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' },
});
const listed = () => registryFile(`orgs:\n  - login: ${ORG}\n    budget_owner_login: SamVanderstraeten\n`);
const unlisted = () => registryFile('orgs:\n  - login: PXL-Some-Other-Course\n    budget_owner_login: SamVanderstraeten\n');

/**
 * Write on the hub, not an owner of ORG, and ORG's control repository invisible:
 * an owner of the hub org who accepted an assignment in a course org. The fixture
 * answers GET /orgs/{org} as a non-owner for any login without "lecturer" in it.
 */
async function asHubAdminOutsider(page, { registry }) {
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: {}, studentHasInstallation: true });
  await controlRepoUnreadable(page);
  await page.route('**/api.github.com/repos/PXL-Digital-Application-Samples/pxl-classroom', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ name: 'pxl-classroom', permissions: { admin: true, push: true } }),
    }));
  await page.route(REGISTRY_URL, (route) => {
    const answer = typeof registry === 'function' ? registry() : registry;
    return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
  });
}

const visiblePrimaries = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.btn-primary')].filter((el) => el.offsetParent !== null).map((el) => el.textContent.trim()));

test.describe('58 - The dashboard refuses an account with no staff access', () => {
  test('a student who accepted an assignment is refused, not onboarded', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: {},
      studentHasInstallation: true,
    });
    await controlRepoUnreadable(page);
    await noHubWrite(page);

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.center-card');
    await expect(card).toBeVisible({ timeout: 20000 });

    await expect(card).toContainText(/lecturer view for/i);
    await expect(card, 'the org is right there in the switcher, so say why')
      .toContainText(/at least one repository in it/i);

    // The three things that made the screenshot alarming.
    await expect(page.locator('.lecturer-tag'), 'a role nothing had checked').toHaveCount(0);
    await expect(card, 'the repository exists - this claimed it does not')
      .not.toContainText(/needs its control repository/i);
    await expect(page.getByRole('button', { name: /Setup Organization/i }), 'an admin action they cannot run')
      .toHaveCount(0);
    await expect(page.getByRole('link', { name: /Setup Organization/i })).toHaveCount(0);
  });

  test('and is given the way back to their own assignments', async ({ page }) => {
    // A dead end reads like a bug. The one thing they can actually do is the
    // single primary action here (DESIGN.md §1.2).
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1, assignments: {}, studentHasInstallation: true,
    });
    await controlRepoUnreadable(page);
    await noHubWrite(page);

    await page.goto(`/dashboard/${ORG}`);
    const back = page.getByRole('link', { name: /My assignments/i });
    await expect(back).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.btn-primary')).toHaveCount(1);
  });

  test('an org OWNER onboarding a new organization is NOT refused', async ({ page }) => {
    // The persona the fix must not break, and the reason hub write alone was
    // not enough: a lecturer who has just been made an org owner has no write
    // on the hub, and produces exactly the same 404 as the student above.
    // GET /orgs/{org} separates them - `default_repository_permission` is
    // returned to an owner and null to everyone else.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await controlRepoUnreadable(page);
    await noHubWrite(page);

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.setup-required-card');
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card).toContainText(/needs its control repository/i);
    // Still no dead button - they cannot dispatch it themselves.
    await expect(card).toContainText(/a hub admin runs/i);
  });

  test('a hub admin who does not own a set-up org is told so, not offered setup', async ({ page }) => {
    // Reported 2026-09-17. An owner of the HUB org - write on the hub, so the
    // page called her staff - who was only an outside collaborator on the course
    // org, through accepting her own test assignment. She got "needs its control
    // repository", a Lecturer tag and a Set up button over a course running for
    // days, and ran Setup Organization twice. The hub registry lists the org.
    await asHubAdminOutsider(page, { registry: listed() });

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.center-card');
    await expect(card).toContainText(/is set up, but not for this account/i, { timeout: 20000 });
    await expect(card).toContainText(/ask an owner of/i);
    await expect(card, 'the one name a non-member can be given').toContainText('@SamVanderstraeten');

    await expect(page.locator('.lecturer-tag'), 'hub write is a role on the hub, not here').toHaveCount(0);
    await expect(card).not.toContainText(/needs its control repository/i);
    await expect(page.getByRole('button', { name: /Set up/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Setup Organization/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Check again/i })).toBeVisible();
    expect(await visiblePrimaries(page), 'DESIGN.md §1.2').toHaveLength(1);
  });

  test('the same hub admin on an org nobody has set up is still offered setup', async ({ page }) => {
    // The case the button exists for: a hub admin onboarding an org they do not
    // own. Unlisted is a real answer, so the onboarding card stays.
    await asHubAdminOutsider(page, { registry: unlisted() });

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.setup-required-card');
    await expect(card).toContainText(/needs its control repository/i, { timeout: 20000 });
    await expect(card.getByRole('button', { name: new RegExp(`Set up ${ORG}`, 'i') })).toBeVisible();
  });

  test('and when setup finishes, a non-owner sees the registry, not a timeout', async ({ page }) => {
    // A non-owner can never see the control repository appear, so waiting for
    // it ran four minutes and then called a successful run "taking longer than
    // expected". Registration is Setup's last step and is public.
    let registered = false;
    await asHubAdminOutsider(page, { registry: () => (registered ? listed() : unlisted()) });
    await page.route('**/actions/workflows/setup-org.yml/dispatches', (route) => {
      registered = true;
      return route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/dashboard/${ORG}`);
    await page.getByRole('button', { name: new RegExp(`Set up ${ORG}`, 'i') }).click({ timeout: 20000 });
    await expect(page.locator('.toast')).toContainText(/is set up/i, { timeout: 15000 });
    await expect(page.locator('.center-card')).toContainText(/is set up, but not for this account/i);
  });

  test('an unreadable registry is not a reason to offer setup', async ({ page }) => {
    await asHubAdminOutsider(page, { registry: { status: 500, body: { message: 'boom' } } });

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.center-card');
    await expect(card).toContainText(/couldn't tell whether/i, { timeout: 20000 });
    await expect(page.locator('.lecturer-tag')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Set up/i })).toHaveCount(0);
    expect(await visiblePrimaries(page)).toHaveLength(1);
  });

  test('the Admin Panel gives the same answer, and does not offer a form that cannot save', async ({ page }) => {
    await asHubAdminOutsider(page, { registry: listed() });

    await page.goto(`/dashboard/${ORG}/admin`);
    const box = page.locator('.error-state-box');
    await expect(box).toContainText(/is set up, but not for this account/i, { timeout: 20000 });
    await expect(box).toContainText('@SamVanderstraeten');
    await expect(box).not.toContainText(/onboarded/i);
    await expect(page.getByRole('button', { name: /New assignment/i })).toBeDisabled();
    await expect(page.locator('.editor-pane'), 'and nothing points at the disabled button')
      .not.toContainText(/click \+ New assignment/i);
  });

  test('the org admin check is a POSITIVE signal, so a failed read refuses', async ({ page }) => {
    // Unreadable is not evidence of authority. If GET /orgs/{org} cannot be
    // read, the page must not admit on the strength of not knowing.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await controlRepoUnreadable(page);
    await noHubWrite(page);
    await page.route(`**/api.github.com/orgs/${ORG}`, (route) =>
      route.fulfill({ status: 500, body: JSON.stringify({ message: 'boom' }) }));

    await page.goto(`/dashboard/${ORG}`);
    const card = page.locator('.center-card');
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card).toContainText(/lecturer view for/i);
    await expect(card).not.toContainText(/needs its control repository/i);
  });
});
