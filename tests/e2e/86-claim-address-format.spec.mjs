// 86 - The address has to say who the student is.
//
// 2026-09-26, a colleague on .NET Advanced: some students confirmed
// `<number>@student.pxl.be`, from which nobody can tell who they are - 16 of
// 111, measured. deployment.yml now carries `claim_address_format` (the part
// before the @ must contain a dot, shipped as firstname.lastname), applied by
// lib/claim.mjs on the hub and here in the student's card; an assignment can
// switch it off; and a binding that fails it is asked again. The hub side is
// tests/confirm-accept.test.mjs; this is the three screens.

import { test, expect } from '@playwright/test';
import {
  ORG,
  STUDENT_1,
  STUDENT_2,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  confirmUrl,
  inviteToken,
  expandSettings,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'net-labs';
const NUMBER = '12345678@student.pxl.be';
const NAMED = 'student.one@student.pxl.be';

const assignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'NET Labs',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 150,
  require_claim: true,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'net-template' },
  broker_repo: `broker-${ID}`,
  invite_key: inviteToken(ORG, ID),
  invite_nonce: 'e2e00086',
  invite_expires_at: '2099-01-01T00:00:00.000Z',
  opens_at: new Date(Date.now() - 3600_000).toISOString(),
  deadline_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  ...over,
});

async function openConfirm(page, { emails, over = {} }) {
  const acceptanceBodies = [];
  await injectAuth(page, STUDENT_1);
  await setupStandardMockRoutes(page, { currentUser: STUDENT_1, assignments: { [ID]: assignment(over) }, acceptanceBodies });
  await page.route('**/api.github.com/user/emails*', (route) => route.fulfill({ status: 200, body: JSON.stringify(emails) }));
  await page.goto(confirmUrl(ORG, ID));
  await expect(page.getByRole('heading', { name: /Tell your lecturer who you are/i })).toBeVisible({ timeout: 15000 });
  return { acceptanceBodies };
}

const typedBox = (page) => page.getByLabel(/email address/i).last();

test.describe('86 - the student card applies the address form', () => {
  test('of two verified addresses, only the one with a name is offered', async ({ page }) => {
    await openConfirm(page, { emails: [
      { email: NUMBER, verified: true, primary: true },
      { email: NAMED, verified: true, primary: false },
    ] });
    await expect(page.locator('.claim-option', { hasText: NAMED })).toBeVisible();
    await expect(page.locator('.claim-option', { hasText: NUMBER })).toHaveCount(0);
  });

  test('a student whose ONLY verified address is the number form is told so, by name - not "none found"', async ({ page }) => {
    await openConfirm(page, { emails: [{ email: NUMBER, verified: true, primary: true }] });
    const note = page.locator('.claim-note', { hasText: NUMBER });
    await expect(note).toContainText('does not say who you are');
    await expect(note).toContainText('firstname.lastname@ form');
    await expect(page.locator('.claim-note', { hasText: 'No verified' })).toHaveCount(0);
    // And they can still type the right one.
    await typedBox(page).fill(NUMBER);
    await expect(page.locator('.claim-problem')).toContainText('Use the firstname.lastname@ form of your address');
    await typedBox(page).fill(NAMED);
    await expect(page.locator('.claim-problem')).toHaveCount(0);
  });

  test('an assignment that switched the form off offers the number form like any other', async ({ page }) => {
    await openConfirm(page, { over: { claim_address_format: false }, emails: [{ email: NUMBER, verified: true, primary: true }] });
    await expect(page.locator('.claim-option', { hasText: NUMBER })).toBeVisible();
  });
});

test.describe('86 - the lecturer\'s side', () => {
  async function openEditor(page, over = {}) {
    const writes = [];
    await injectAuth(page, LECTURER);
    // No `broker_repo`: the schema does not declare it, so a document holding
    // it cannot be saved (spec 74). The confirm page above needs it; the
    // editor must not have it.
    const { broker_repo: _unused, ...doc } = assignment(over);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: doc },
      userRepos: [{ name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}`, html_url: `https://github.com/${ORG}/broker-${ID}` }],
      contentWrites: writes,
    });
    await page.route((u) => u.href.includes('/actions/workflows/') && u.href.includes('/dispatches'), (r) => r.fulfill({ status: 204, body: '' }));
    await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
    await expect(page.getByText('Assignment is Published & Verified Live')).toBeVisible({ timeout: 15000 });
    await expandSettings(page);
    return { writes };
  }
  const box = (page) => page.getByLabel(/Only accept the firstname\.lastname@ form/);

  test('the form is on by default, and unticking writes the opt-out - and only the opt-out', async ({ page }) => {
    const { writes } = await openEditor(page);
    await expect(box(page)).toBeChecked();
    await box(page).uncheck();
    await expect(page.getByText('Any address in the allowed domains is accepted.')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length, { timeout: 15000 }).toBe(1);
    expect(writes.at(-1).content).toMatch(/^claim_address_format: false$/m);
  });

  test('ticked is the deployment default, so nothing is written for it', async ({ page }) => {
    const { writes } = await openEditor(page, { claim_address_format: false });
    await expect(box(page)).not.toBeChecked();
    await box(page).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => writes.filter((w) => w.path === `assignments/${ID}.yml`).length, { timeout: 15000 }).toBe(1);
    expect(writes.at(-1).content).not.toMatch(/claim_address_format/);
  });

  test('not offered where no address is asked for', async ({ page }) => {
    await openEditor(page, { require_claim: false });
    await expect(box(page)).toHaveCount(0);
  });

  test('the assignment page names who still has to say who they are, and the cell says why', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment() },
      reports: {
        [ID]: {
          schema_version: 1,
          assignment_id: ID,
          generated_at: new Date().toISOString(),
          students: [
            { github_login: STUDENT_1.login, acceptance_state: 'provisioned', submission_status: 'on-time', repo_name: `${ORG}/${ID}-${STUDENT_1.login}`, claimed_email: NUMBER, claim_verified: true, claim_domain_allowed: true, claim_format_allowed: false },
            { github_login: STUDENT_2.login, acceptance_state: 'provisioned', submission_status: 'on-time', repo_name: `${ORG}/${ID}-${STUDENT_2.login}`, claimed_email: NAMED, claim_verified: true, claim_domain_allowed: true, claim_format_allowed: true },
          ],
        },
      },
    });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    const notice = page.getByRole('region', { name: 'Addresses without a name' });
    await expect(notice).toContainText('1 student confirmed an address without their name in it');
    await expect(notice).toContainText(`@${STUDENT_1.login}`);
    await expect(notice).not.toContainText(`@${STUDENT_2.login}`);
    await expect(notice).toContainText('Confirm-email link');
    await expect(page.locator('tr', { hasText: NUMBER })).toContainText('No name in the address');
  });
});
