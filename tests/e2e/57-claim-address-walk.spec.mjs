// 57 - What the claim card is entitled to say about a student's addresses.
//
// The card tells a student "GitHub has not verified a Hogeschool PXL address on
// this account" and now sends them to change GitHub accounts on the strength of
// it. That is a statement about the WHOLE list, and it was made from
// `/user/emails?per_page=100` read once.
//
// Nobody has a hundred email addresses, and that is not the point: the same
// shape - one page, a confident negative - is what told a student with a
// pending invitation that setup had failed, twice, from two different
// endpoints. `getUserEmails` walks the Link header now, and where the walk is
// CAPPED the capped case must not report `ok`, or a truncated read becomes the
// same confident negative by a slower route.
//
// Both halves are driven for real here rather than grepped, because that is the
// only way to know the walk happens in a browser: `link` is a cross-origin
// response header, so it needs `access-control-expose-headers` to be visible to
// JS at all - the trap that made an earlier pagination test pass over a
// single-page read.

import { test, expect } from '@playwright/test';
import { ORG, STUDENT_1, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

const ID = 'claim-walk';
const PXL = 'tom.cool@student.pxl.be';

const assignment = () => ({
  id: ID,
  title: 'Claim Walk',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  // `open` + require_claim is the collect-and-record mode: the claim is asked
  // for and recorded, and nothing about the address is a gate.
  roster_mode: 'open',
  require_claim: true,
  max_acceptances: 50,
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  repository_name_pattern: `${ID}-{github_login}`,
  broker_repo: `broker-${ID}`,
});

/** A page of verified addresses, none of them institutional. */
const filler = (n, from) =>
  Array.from({ length: n }, (_, i) => ({ email: `filler-${from + i}@gmail.com`, verified: true, primary: false }));

/**
 * Serve /user/emails as `pages` pages. `endless` keeps a rel="next" on every
 * page so the walk hits its cap instead of finishing.
 */
async function routeEmails(page, { pages, endless = false, lastPage = [] }) {
  let served = 0;
  await page.route('**/api.github.com/user/emails*', (route) => {
    const url = new URL(route.request().url());
    const p = Number(url.searchParams.get('page') || 1);
    served = Math.max(served, p);
    const body = !endless && p === pages ? lastPage : filler(100, p * 100);
    const next = new URL(url);
    next.searchParams.set('page', String(p + 1));
    const more = endless || p < pages;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Without access-control-expose-headers JS cannot read `link` on a
      // cross-origin response, and the walk silently sees one page.
      headers: more
        ? { link: `<${next}>; rel="next"`, 'access-control-expose-headers': 'link' }
        : { 'access-control-expose-headers': 'link' },
      body: JSON.stringify(body),
    });
  });
  return () => served;
}

test.describe('57 - The claim card walks the address list', () => {
  test('an institutional address on page two is still found', async ({ page }) => {
    // The whole point of the walk. On a one-page read this student is told
    // GitHub has verified no PXL address for them, and pointed at creating a
    // different GitHub account - while the address sits on page two.
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: assignment() } });
    const servedPages = await routeEmails(page, {
      pages: 2,
      lastPage: [{ email: PXL, verified: true, primary: true }],
    });

    await page.goto(inviteUrl(ORG, ID));
    await expect(page.locator('.claim-card')).toBeVisible({ timeout: 20000 });

    // Offered as a pick, with GitHub's own verification behind it - which is
    // what makes the recorded claim `claim_verified: true`.
    await expect(page.locator('.claim-address')).toHaveText(PXL);
    await expect(page.locator('.claim-badge')).toContainText(/Verified by GitHub/i);
    expect(servedPages(), 'the second page must actually be requested').toBeGreaterThanOrEqual(2);

    // And it must NOT be telling them their account is wrong.
    await expect(page.locator('.claim-card')).not.toContainText(/has not verified/i);
  });

  test('a truncated walk says it could not check, never that there is nothing', async ({ page }) => {
    // The capped case. `maxPages` exists so a malformed Link header cannot spin
    // forever, and hitting it means the list was not read to the end - so the
    // card may not draw the confident negative from it.
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: assignment() } });
    await routeEmails(page, { pages: 99, endless: true });

    await page.goto(inviteUrl(ORG, ID));
    const card = page.locator('.claim-card');
    await expect(card).toBeVisible({ timeout: 20000 });

    await expect(card).toContainText(/could not check which addresses GitHub has verified/i, { timeout: 20000 });
    await expect(card, 'a truncated read is not evidence of an absent address')
      .not.toContainText(/has not verified/i);
  });

  test('a real negative is worded as what was actually checked', async ({ page }) => {
    // One page, finished, nothing institutional on it. NOW the negative is
    // earned - and it is scoped to what GitHub VERIFIED, because that is all
    // the card ever looked at: an address sitting on the account unverified is
    // filtered out before this decision.
    await injectAuth(page, STUDENT_1);
    await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: assignment() } });
    await page.route('**/api.github.com/user/emails*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { email: 'personal@gmail.com', verified: true, primary: true },
          // On the account, NOT verified - so it must not count as found, and
          // must not make the message a lie either.
          { email: PXL, verified: false, primary: false },
        ]),
      }));

    await page.goto(inviteUrl(ORG, ID));
    const card = page.locator('.claim-card');
    await expect(card).toBeVisible({ timeout: 20000 });

    await expect(card).toContainText(/GitHub has not verified/i);
    await expect(card, 'the claim is about verified addresses, not everything on the account')
      .not.toContainText(/None of the addresses on your GitHub account/i);

    // The article follows the domain's sound. "an student.pxl.be" shipped in
    // this sentence and in the typed-address error beside it.
    await expect(card).not.toContainText(/an student\.pxl\.be|an pxl\.be/i);
    await expect(card).toContainText(/a student\.pxl\.be/i);

    // The field is the action in this state: it is present, labelled for the
    // address actually wanted, and not hidden behind "use a different address".
    await expect(page.locator('.claim-field-label')).toContainText(/PXL email address/i);
    await expect(page.locator('.claim-typed input[type="email"]')).toBeVisible();
  });
});
