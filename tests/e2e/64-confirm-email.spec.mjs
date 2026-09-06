// 64 - "Tell us who you are", with no assignment attached.
//
// A roster row promoted from an acceptance carries a github_login and nothing
// else, and NOTHING fills it in afterwards: promotion skips a login it has
// seen, and a claim joins to a row by email, which such a row has none of. The
// claim itself was only ever collected AT ACCEPTANCE - `ClaimAddressCard`
// renders inside AssignmentView's "Accept assignment" branch - so a student who
// had already accepted could never be asked again, and an assignment not in
// `claim` mode never asked at all.
//
// The confirm link is the same secret asking a smaller question. It rides the
// assignment's own keypair, nonce and broker DELIBERATELY: that is what makes
// it inherit the kill switch (INVITE_ENABLED, flipped when the nightly
// finalizes) and the revocation (rotate the nonce, every link dies at once)
// rather than having a lifetime of its own that nobody would remember to end.
// The alternative was a standing per-org receiver, which means the broker App's
// private key on a public repository forever - the exact thing
// scripts/close-acceptance.mjs was written to end.
//
// The whole weight therefore falls on one question: what stops somebody
// relabelling `pxl-confirm:` as `pxl-accept:`? tests/confirm-purpose.test.mjs
// answers it at the crypto layer. What THIS file proves is the other half - the
// page never offers to accept anything, the title it mints is one the REAL
// broker verifier takes, and the address never leaves the browser in the clear.

import { test, expect } from '@playwright/test';
import {
  ORG,
  STUDENT_1,
  STUDENT_2,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  confirmUrl,
  inviteUrl,
  inviteToken,
  legacyInviteToken,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'cloud-lab-3';
const ADDRESS = 'student1@student.pxl.be';

const assignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'Cloud Lab 3',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  // ENFORCED on purpose. A confirmation does not consult roster_mode - the
  // record is org-scoped and says who an account IS, not what they may accept -
  // and this is the mode that collects no address at all, so it is the one
  // where a confirm link has to work if the feature means anything.
  roster_mode: 'enforced',
  repository_name_pattern: `${ID}-{github_login}`,
  broker_repo: `broker-${ID}`,
  invite_key: inviteToken(ORG, ID),
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  ...over,
});

/**
 * Open the confirm page as a student.
 *
 * `acceptanceTitles` and `acceptanceBodies` come back so a spec can inspect
 * exactly what the browser posted - the fixture runs the REAL verifier over the
 * title, so a green assertion here means the broker would have taken it.
 */
async function openConfirm(page, {
  user = STUDENT_1,
  over = {},
  emails = [{ email: ADDRESS, verified: true, primary: true }],
  emailsStatus = 200,
  issueStatus = null,
  url = null,
  signedIn = true,
} = {}) {
  const acceptanceTitles = [];
  const acceptanceBodies = [];
  if (signedIn) await injectAuth(page, user);
  await setupStandardMockRoutes(page, {
    currentUser: user,
    assignments: { [ID]: assignment(over) },
    acceptanceTitles,
    acceptanceBodies,
  });
  await page.route('**/api.github.com/user/emails*', (route) =>
    route.fulfill({
      status: emailsStatus,
      body: JSON.stringify(emailsStatus === 200 ? emails : { message: 'nope' }),
    }));
  if (issueStatus) {
    await page.route(`**/repos/${ORG}/broker-${ID}/issues`, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: issueStatus, body: JSON.stringify({ message: 'nope' }) })
        : route.fallback());
  }
  await page.goto(url || confirmUrl(ORG, ID));
  return { acceptanceTitles, acceptanceBodies };
}

const submit = (page) => page.getByRole('button', { name: /Confirm this address/i });
const address = (page) => page.getByText(ADDRESS).first();

// ============================================================ what the page is

test.describe('64 - what the page says it is', () => {
  test('it says out loud that it is NOT an assignment', async ({ page }) => {
    // A student who has already accepted and is handed a second link will
    // reasonably assume it is another one. Letting them find that out by
    // reading the button is how somebody clicks expecting a repository -
    // DESIGN.md §1.5 from the honest direction.
    await openConfirm(page);
    await expect(page.getByRole('heading', { name: /Tell your lecturer who you are/i }))
      .toBeVisible({ timeout: 15000 });
    await expect(page.locator('main')).toContainText('does not create a repository');
    // AND IT NAMES NO ASSIGNMENT. The binding is org-scoped - one confirmation
    // covers every assignment in the org - so "so your lecturer knows who Cloud
    // Lab 3 belongs to" described a per-assignment record that does not exist.
    await expect(page.locator('.confirm-intro')).not.toContainText('Cloud Lab 3');
  });

  test('IT NEVER OFFERS TO ACCEPT ANYTHING', async ({ page }) => {
    // The single most important assertion in this file. The page shares a
    // secret with the acceptance page and must never share its behaviour.
    await openConfirm(page);
    await expect(submit(page)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('Accept assignment');
  });

  test('signed out it shows the sign-in card, not a data-shaped empty state', async ({ page }) => {
    // DESIGN.md §6: AuthCard is the one sign-in surface, and an authenticated
    // view with no session shows it rather than "nothing to confirm".
    await openConfirm(page, { signedIn: false });
    await expect(page.locator('.auth-card, .center-card').first()).toBeVisible({ timeout: 15000 });
    await expect(submit(page)).toHaveCount(0);
  });

  test('exactly one primary button', async ({ page }) => {
    await openConfirm(page);
    await expect(submit(page)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.btn-primary')).toHaveCount(1);
  });
});

// ========================================================== the happy path

test.describe('64 - confirming', () => {
  test('THE FLOW: pick a verified address, confirm, done', async ({ page }) => {
    const { acceptanceTitles } = await openConfirm(page);

    // Offered, not typed. A typed address is recorded unverified, and the point
    // of asking GitHub is evidence.
    await expect(address(page)).toBeVisible({ timeout: 15000 });
    await submit(page).click();

    await expect(page.locator('main')).toContainText("that's all we needed", { timeout: 15000 });
    await expect(page.locator('main')).toContainText(ADDRESS);
    await expect(page.locator('main')).toContainText(STUDENT_1.login);

    // THE REAL VERIFIER RAN. The fixture checks the posted title exactly as the
    // broker would, so this is not "we posted something".
    expect(acceptanceTitles).toHaveLength(1);
    expect(acceptanceTitles[0].ok, acceptanceTitles[0].reason).toBe(true);
    expect(acceptanceTitles[0].title).toMatch(/^pxl-confirm:/);
  });

  test('the address is SEALED - nothing readable leaves the browser', async ({ page }) => {
    // The title and body land in a public event GH Archive keeps forever, which
    // is the whole reason the claim is encrypted rather than sent in the clear.
    const { acceptanceTitles, acceptanceBodies } = await openConfirm(page);
    await address(page).waitFor({ timeout: 15000 });
    await submit(page).click();
    await expect(page.locator('main')).toContainText("that's all we needed", { timeout: 15000 });

    expect(acceptanceBodies[0]).toBeTruthy();
    expect(acceptanceBodies[0]).not.toContain(ADDRESS);
    expect(acceptanceBodies[0]).not.toContain('student1');
    expect(acceptanceTitles[0].title).not.toContain(ADDRESS);
    // The shared builder's shape, not a hand-rolled object: the hub reads
    // `claim_verified === true`, so a body spelled in the view would record
    // every confirmation as unverified.
    const body = JSON.parse(acceptanceBodies[0]);
    expect(Object.keys(body).sort()).toEqual(['claim', 'claim_verified']);
    expect(body.claim_verified).toBe(true);
  });

  test('a TYPED address is carried as unverified, not quietly promoted', async ({ page }) => {
    // GitHub has nothing matching, so the card falls back to a text box - and
    // what it records must say so, because that is the whole difference between
    // this and the lecturer typing it themselves.
    const { acceptanceBodies } = await openConfirm(page, { emails: [] });
    const box = page.getByPlaceholder(/@/).first();
    await box.waitFor({ timeout: 15000 });
    await box.fill('typed.person@student.pxl.be');
    await submit(page).click();
    await expect(page.locator('main')).toContainText("that's all we needed", { timeout: 15000 });
    expect(JSON.parse(acceptanceBodies[0]).claim_verified).toBe(false);
  });

  test('nothing chosen, nothing to send: the button stays disabled', async ({ page }) => {
    await openConfirm(page, { emails: [] });
    await expect(submit(page)).toBeDisabled({ timeout: 15000 });
  });

  test('an UNREADABLE address list is not "you have no PXL address"', async ({ page }) => {
    // A 403 is exactly what a missing `email_addresses: read` approval looks
    // like, and it is not evidence about the student's account. Same rule the
    // org-owner check applies: unreadable yields no claim about the world.
    await openConfirm(page, { emailsStatus: 403 });
    await expect(page.locator('main')).toContainText(/could not check/i, { timeout: 15000 });
    await expect(page.locator('main')).not.toContainText(/no .* address/i);
  });
});

// ============================================================== the edges

test.describe('64 - the edges', () => {
  test('a broker that answers 404 is a dead link, said plainly', async ({ page }) => {
    await openConfirm(page, { issueStatus: 404 });
    await address(page).waitFor({ timeout: 15000 });
    await submit(page).click();
    await expect(page.locator('.auth-error')).toContainText(/no longer active/i, { timeout: 15000 });
    // And it must NOT claim success.
    await expect(page.locator('main')).not.toContainText("that's all we needed");
  });

  test('a 500 reports the failure rather than a green tick', async ({ page }) => {
    // Never set a success flag before the operation resolves - the defect that
    // cost sign-in, where "Copied" appeared over an empty clipboard.
    await openConfirm(page, { issueStatus: 500 });
    await address(page).waitFor({ timeout: 15000 });
    await submit(page).click();
    await expect(page.locator('.auth-error')).toContainText('500', { timeout: 15000 });
    await expect(page.locator('main')).not.toContainText("that's all we needed");
  });

  test('SIGNING OUT CLEARS EVERYTHING - these run on shared lab machines', async ({ page }) => {
    // A half-filled address left behind would be sealed under the NEXT
    // student's id, and a success card left on screen would tell them an
    // address they have never seen is now theirs.
    await openConfirm(page);
    await address(page).waitFor({ timeout: 15000 });
    await submit(page).click();
    await expect(page.locator('main')).toContainText("that's all we needed", { timeout: 15000 });

    await page.getByRole('button', { name: /sign out|log ?out/i }).first().click();
    await expect(page.locator('main')).not.toContainText("that's all we needed", { timeout: 10000 });
    await expect(page.locator('main')).not.toContainText(ADDRESS);
    await expect(submit(page)).toHaveCount(0);
  });

  test('a link for an assignment that does not exist says so, and offers nothing', async ({ page }) => {
    await openConfirm(page, { url: `/${ORG}/c/${'A'.repeat(184)}` });
    await expect(page.locator('main')).toContainText(/can't find this link/i, { timeout: 15000 });
    await expect(submit(page)).toHaveCount(0);
  });

  test('a PRE-MIGRATION link cannot confirm, and is not sent to a page that shrugs', async ({ page }) => {
    // It carries a bearer token rather than a key, so there is nothing to sign
    // a confirmation with - and its broker would refuse one anyway.
    await openConfirm(page, { url: `/${ORG}/c/${legacyInviteToken(ORG, ID)}` });
    await expect(page.locator('main')).toBeVisible({ timeout: 15000 });
    await expect(submit(page)).toHaveCount(0);
  });

  test('it works in EVERY roster mode, because it does not consult one', async ({ page }) => {
    // The design claim, tested rather than asserted in a comment. A
    // confirmation says who an account IS, not what they may accept, and the
    // record is org-scoped - so `enforced`, which collects no address at all on
    // the acceptance path, is as good a carrier as any other. That matters
    // exactly when the only live assignment is the wrong mode.
    for (const mode of ['enforced', 'claim', 'open']) {
      const over = mode === 'open' ? { roster_mode: mode, max_acceptances: 50 } : { roster_mode: mode };
      await openConfirm(page, { over });
      await expect(submit(page), `roster_mode: ${mode}`).toBeVisible({ timeout: 15000 });
    }
  });

  test('confirming TWICE is idempotent from the page\'s side', async ({ page }) => {
    // The hub answers `already-confirmed` for a second one - org-scoped
    // idempotence, exactly as under `claim`. What matters here is that the page
    // does not offer a second submit and re-post.
    const { acceptanceTitles } = await openConfirm(page);
    await address(page).waitFor({ timeout: 15000 });
    await submit(page).click();
    await expect(page.locator('main')).toContainText("that's all we needed", { timeout: 15000 });
    await expect(submit(page)).toHaveCount(0);
    expect(acceptanceTitles).toHaveLength(1);
  });

  test('a SECOND student on the same link signs their own confirmation', async ({ page }) => {
    // The link is not per student, deliberately - it is a door, not a name. The
    // signature names whoever is signed in, and the broker refuses one that
    // does not match the issue author.
    const { acceptanceTitles } = await openConfirm(page, { user: STUDENT_2 });
    await page.getByText('@', { exact: false }).first().waitFor({ timeout: 15000 });
    const box = page.getByPlaceholder(/@/).first();
    if (await box.count()) await box.fill('student2@student.pxl.be');
    await submit(page).click();
    await expect(page.locator('main')).toContainText("that's all we needed", { timeout: 15000 });
    expect(acceptanceTitles[0].ok, acceptanceTitles[0].reason).toBe(true);
  });
});

// ====================================================== the two pages differ

test.describe('64 - the confirm page and the accept page are not each other', () => {
  test('the same secret on /i/ still accepts, and signs a DIFFERENT title', async ({ page }) => {
    // Proof the two coexist on one keypair: same URL secret, two routes, two
    // prefixes, and both verify.
    const acceptanceTitles = [];
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [ID]: assignment({ roster_mode: 'open', max_acceptances: 50 }) },
      acceptanceTitles,
    });
    await page.goto(inviteUrl(ORG, ID));
    await page.getByRole('button', { name: /Accept assignment/i }).click({ timeout: 15000 });
    await expect.poll(() => acceptanceTitles.length, { timeout: 15000 }).toBe(1);
    expect(acceptanceTitles[0].ok, acceptanceTitles[0].reason).toBe(true);
    expect(acceptanceTitles[0].title).toMatch(/^pxl-accept:/);
  });

  test('pasting a /c/ link into "have a link?" lands on the CONFIRM page', async ({ page }) => {
    // A student handed a confirm link and told to paste it would otherwise be
    // told it is not a link at all - which is the worst answer available,
    // because it is one, and the box is the only thing on the page.
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [ID]: assignment() },
    });
    await page.goto('/');
    const box = page.getByPlaceholder(/link/i).first();
    await box.waitFor({ timeout: 15000 });
    await box.fill(`https://example.test/pxl-classroom${confirmUrl(ORG, ID)}`);
    await box.press('Enter');

    await expect(page).toHaveURL(new RegExp(`/${ORG}/c/`), { timeout: 15000 });
    await expect(page.locator('main')).toContainText('does not create a repository', { timeout: 15000 });
  });

  test('…and an /i/ link still lands on the ACCEPT page', async ({ page }) => {
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, {
      currentUser: STUDENT_1,
      assignments: { [ID]: assignment({ roster_mode: 'open', max_acceptances: 50 }) },
    });
    await page.goto('/');
    const box = page.getByPlaceholder(/link/i).first();
    await box.waitFor({ timeout: 15000 });
    await box.fill(`https://example.test/pxl-classroom${inviteUrl(ORG, ID)}`);
    await box.press('Enter');

    await expect(page).toHaveURL(new RegExp(`/${ORG}/i/`), { timeout: 15000 });
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeVisible({ timeout: 15000 });
  });

  test('the accept page does not link to the confirm page, or vice versa', async ({ page }) => {
    // Two doors for two questions. A student meets exactly the one they were
    // sent, and neither page offers to turn into the other.
    await openConfirm(page);
    await expect(submit(page)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('a[href*="/i/"]')).toHaveCount(0);
  });
});

// =========================================================== the lecturer

test.describe('64 - where a lecturer finds the link', () => {
  async function detail(page, over = {}) {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment(over) },
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await page.waitForLoadState('networkidle');
    // The link lives behind the "Invite link" trigger - one place for links,
    // and the place a lecturer comes back to a week later.
    await page.locator('button:has(span:text-is("Invite link"))').click();
  }

  const confirmRow = (page) => page.locator('.invitation-share-confirm');

  test('it sits with the invitation link, which is the one place links live', async ({ page }) => {
    await detail(page);
    const row = confirmRow(page).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toContainText('Confirm-email link');
    // What it does and does not do, beside the control rather than in a manual.
    await expect(row).toContainText(/no repository/i);
  });

  test('it does NOT add a second primary button to the view', async ({ page }) => {
    // DESIGN.md §1.2. The row is a secondary route out of a block whose primary
    // action is already spoken for.
    await detail(page);
    await expect(confirmRow(page).first()).toBeVisible({ timeout: 15000 });
    await expect(confirmRow(page).locator('.btn-primary')).toHaveCount(0);
  });

  test('copying it puts a /c/ URL on the clipboard, off the SAME secret', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await detail(page);
    await confirmRow(page).first().getByRole('button', { name: /Copy/i }).click({ timeout: 15000 });
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`/${ORG}/c/`);
    expect(copied).toContain(inviteToken(ORG, ID));
  });

  test('no link means no row - a control that cannot act is worse than none', async ({ page }) => {
    // `linkSecretFrom` finds nothing, so there is no link and nothing to copy.
    await detail(page, { invite_key: undefined, invite_token: undefined });
    await expect(confirmRow(page)).toHaveCount(0);
  });
});
