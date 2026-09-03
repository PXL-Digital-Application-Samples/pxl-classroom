// 46 - The claim, from the student's browser to the hub's decrypt
//
// Phase A's lesson was that the bug lives in the SEAM. Both halves of the
// signed title had unit tests; the join between them had none, and every group
// acceptance was rejected for months while the suite stayed green.
//
// So this drives the REAL browser through the REAL crypto and then opens what
// it posted with the REAL hub-side parser and decrypt. If AssignmentView ever
// stops putting the sealed claim in the body, or seals it to the wrong account,
// or records `claim_verified` for an address GitHub never verified, one of
// these goes red rather than a cohort discovering it at the accept button.
import { test, expect } from '@playwright/test';
import {
  ORG,
  STUDENT_1,
  E2E_CLAIM_KEYPAIR,
  injectAuth,
  setupStandardMockRoutes,
  inviteUrl,
  inviteToken,
} from '../fixtures/e2e-fixtures.mjs';
import { parseClaimFields, decryptClaim } from '../../lib/claim.mjs';

const ID = 'claim-assignment';

const claimAssignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'Claim Assignment',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'claim',
  max_acceptances: 50,
  repository_name_pattern: `${ID}-{github_login}`,
  broker_repo: `broker-${ID}`,
  invite_key: inviteToken(ORG, ID),
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  ...over,
});

/** Land a signed-in student on a claim assignment, with a chosen /user/emails reply. */
async function student(page, { emails, emailsStatus = 200, assignment = claimAssignment() } = {}) {
  const bodies = [];
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT_1,
    assignments: { [ID]: assignment },
    acceptanceBodies: bodies,
  });

  // /user/emails is not part of the standard fixture: it exists only for the
  // claim, and each of its answers means something different.
  await page.route('**/api.github.com/user/emails*', async (route) => {
    if (emailsStatus !== 200) {
      await route.fulfill({ status: emailsStatus, body: JSON.stringify({ message: 'nope' }) });
      return;
    }
    await route.fulfill({ status: 200, body: JSON.stringify(emails ?? []) });
  });

  await page.goto(inviteUrl(ORG, ID));
  return bodies;
}

/** Open what the browser posted, exactly as the hub does. */
async function openClaim(body) {
  const parsed = parseClaimFields({ body });
  expect(parsed.claim_payload, 'the body must carry a sealed claim').not.toBe('');
  const opened = await decryptClaim({
    privateKey: E2E_CLAIM_KEYPAIR.privateKey,
    payload: parsed.claim_payload,
  });
  return { ...opened, verified: parsed.claim_verified };
}

test.describe('46 - Confirming a verified address', () => {
  test('the address GitHub verified is offered, sealed, and marked verified', async ({ page }) => {
    const bodies = await student(page, {
      emails: [
        { email: 'alice@student.pxl.be', verified: true, primary: true },
        { email: 'alice@gmail.com', verified: true, primary: false },
      ],
    });

    // Only the institutional one is offered - the personal address is theirs
    // and verified, and still none of this course's business.
    await expect(page.getByText('alice@student.pxl.be')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('alice@gmail.com')).toHaveCount(0);
    await expect(page.getByText('Verified by GitHub')).toBeVisible();

    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });

    expect(bodies).toHaveLength(1);
    const claim = await openClaim(bodies[0]);
    expect(claim.email).toBe('alice@student.pxl.be');
    expect(claim.verified).toBe(true);
    expect(claim.assignmentId).toBe(ID);
    // Bound to the account that made it - this is the anti-replay property.
    expect(claim.githubId).toBe(STUDENT_1.id);
  });

  test('the plaintext address never appears in what is posted', async ({ page }) => {
    // The body lands in a public event GH Archive keeps forever. Only sealed
    // bytes may travel - that is the entire reason this is encrypted.
    const bodies = await student(page, {
      emails: [{ email: 'alice@student.pxl.be', verified: true, primary: true }],
    });
    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });

    expect(bodies[0]).not.toContain('alice');
    expect(bodies[0]).not.toContain('student.pxl.be');
    expect(bodies[0]).not.toContain('@');
  });

  test('an unverified address on the account is not offered', async ({ page }) => {
    // GitHub having the address is not GitHub having CHECKED it, and the
    // difference is the only thing claim_verified means.
    await student(page, {
      emails: [{ email: 'alice@student.pxl.be', verified: false, primary: true }],
    });
    await expect(page.getByPlaceholder(/you@student\.pxl\.be/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Verified by GitHub')).toHaveCount(0);
  });
});

test.describe('46 - The typed fallback', () => {
  test('a student with no matching address can still accept, recorded unverified', async ({ page }) => {
    // Nobody is locked out. Requiring a verified address was considered and
    // rejected: it blocks a real fraction of students and stops nothing
    // determined, because the page is public JavaScript either way.
    const bodies = await student(page, {
      emails: [{ email: 'alice@gmail.com', verified: true, primary: true }],
    });

    const box = page.getByPlaceholder(/you@student\.pxl\.be/i);
    await expect(box).toBeVisible({ timeout: 15000 });

    const accept = page.getByRole('button', { name: /Accept assignment/i });
    await expect(accept).toBeDisabled();

    await box.fill('alice.example@student.pxl.be');
    await expect(accept).toBeEnabled();
    await accept.click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });

    const claim = await openClaim(bodies[0]);
    expect(claim.email).toBe('alice.example@student.pxl.be');
    expect(claim.verified).toBe(false);
  });

  test('an address outside the allowed domains is refused before it is sealed', async ({ page }) => {
    await student(page, { emails: [] });
    const box = page.getByPlaceholder(/you@student\.pxl\.be/i);
    await box.fill('alice@hotmail.com');

    await expect(page.getByText(/only accepts/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeDisabled();
  });

  test('typing normalises, so case and spacing cannot create a second binding', async ({ page }) => {
    const bodies = await student(page, { emails: [] });
    await page.getByPlaceholder(/you@student\.pxl\.be/i).fill('  Alice.Example@Student.PXL.be  ');
    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });

    expect((await openClaim(bodies[0])).email).toBe('alice.example@student.pxl.be');
  });
});

test.describe('46 - What the page says when it cannot know', () => {
  test('a 403 on /user/emails is not evidence the student has no PXL address', async ({ page }) => {
    // This is exactly what a missing `email_addresses: read` approval looks
    // like. Telling the student "none of your addresses is a PXL one" would be
    // a claim about their account we have no basis for - the same rule Tier 1
    // applies to an unreadable /apps/{slug}.
    await student(page, { emailsStatus: 403 });

    await expect(page.getByText(/could not check which addresses/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/has not verified/i)).toHaveCount(0);
    // And the way forward is still open.
    await expect(page.getByPlaceholder(/you@student\.pxl\.be/i)).toBeVisible();
  });

  test('an empty list IS evidence, and says the other thing', async ({ page }) => {
    // ...but only about what was actually looked at.
    //
    // This asserted "None of the addresses on your GitHub account is …", which
    // is a claim about the ACCOUNT, and the card only ever sees the addresses
    // GitHub has VERIFIED - `/user/emails` filtered to `verified === true`. An
    // address sitting on the account unverified is excluded, so the sentence
    // was wrong for exactly the student it is hardest on, and the card's own
    // loading line ("addresses GitHub has verified for you") already said the
    // narrower thing one paragraph above. The test was pinning the overclaim.
    await student(page, { emails: [] });
    await expect(page.getByText(/GitHub has not verified/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/could not check which addresses/i)).toHaveCount(0);
    await expect(
      page.getByText(/None of the addresses on your GitHub account/i),
      'the account-wide claim must not come back',
    ).toHaveCount(0);
  });
});

test.describe('46 - A non-claim assignment is untouched', () => {
  test('enforced mode asks for no address and posts an empty body', async ({ page }) => {
    const bodies = await student(page, {
      assignment: claimAssignment({ roster_mode: 'enforced' }),
      emails: [{ email: 'alice@student.pxl.be', verified: true, primary: true }],
    });

    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeEnabled({ timeout: 15000 });
    await expect(page.getByText('Confirm your school email address')).toHaveCount(0);

    await page.getByRole('button', { name: /Accept assignment/i }).click();
    await expect(page.locator('.pending-state')).toBeVisible({ timeout: 15000 });
    expect(bodies[0]).toBe('');
  });
});
