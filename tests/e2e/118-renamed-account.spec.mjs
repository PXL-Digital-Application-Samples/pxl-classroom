// 118 - A student who renamed their GitHub account keeps their repository.
//
// PXL-2TIN-DevOps-2627 and PXL-Java-Essentials, 2026-10-30: students changed
// their username for another course. The repository keeps the name it was given
// (lib/login-rename.mjs), so the name this page builds from today's login does
// not exist, and it offered Accept over their work. Pressing it would have made
// a second, empty repository.
//
// What makes a repository theirs is that nobody holds the name it was made for (a
// classmate's they were added to fits the pattern just as well) AND an acceptance
// attempt of their own (a RENAMED classmate's has the first, and a student who
// never accepted lost the Accept button over it). Null is safe: Accept stays, and
// the hub decides by account id.
import { test, expect } from '@playwright/test';
import { ORG, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';
import { REJECTED_LABEL } from '../../lib/acceptance-labels.mjs';

const ID = 'lab-renamed';
const STUDENT = { login: 'NewNamePXL', name: 'New Name', token: 'mock_renamed_token' };
const OLD_LOGIN = 'old-name';
const OLD_REPO = `${ID}-${OLD_LOGIN}`;
const FULL = `${ORG}/${OLD_REPO}`;

const assignment = {
  id: ID, title: 'Renamed Lab', organization: ORG, state: 'published', assignment_type: 'individual',
  deadline_at: new Date(Date.now() + 72 * 3600_000).toISOString(), timezone: 'Europe/Brussels',
  repository_name_pattern: `${ID}-{github_login}`,
};

const repoCalled = (name) => ({
  name, full_name: `${ORG}/${name}`, html_url: `https://github.com/${ORG}/${name}`, owner: { login: ORG },
  permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
});
const theirRepo = repoCalled(OLD_REPO);

// GitHub lists an issue under its author's name today, so their old attempt is theirs.
const theirAttempt = {
  number: 7, title: 'Acceptance (processed)', state: 'open', created_at: '2026-10-01T09:00:00Z',
  user: { login: STUDENT.login, id: 77 }, labels: [],
};

async function open(page, { userRepos = [theirRepo], notAccounts = [OLD_LOGIN], invitations = [], brokerIssues = [theirAttempt] } = {}) {
  await injectAuth(page, STUDENT);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT, userRepos, notAccounts, invitations, brokerIssues,
    assignments: { [ID]: assignment },
    allOrgAssignments: { [ORG]: { [ID]: assignment } },
    participatingOrgs: [{ login: ORG, name: 'Course' }],
  });
  // As GitHub answers it: nothing stands at the name today's login makes.
  await page.route(`**/repos/${ORG}/${ID}-${STUDENT.login}`, (route) =>
    route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
  await page.route(`**/repos/${FULL}`, (route) => route.fulfill({ status: 200, body: JSON.stringify(theirRepo) }));
}

test.describe('118 - a renamed account keeps its repository', () => {
  test('their page shows the repository they have, and offers no Accept', async ({ page }) => {
    await open(page);
    await page.goto(inviteUrl(ORG, ID));
    await expect(page.locator('.student-status-card')).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`a[href="https://github.com/${FULL}"]`).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toHaveCount(0);
  });

  test("a classmate's repository they were added to is not theirs: Accept stays", async ({ page }) => {
    await open(page, { userRepos: [repoCalled(`${ID}-classmate`)] });
    await page.goto(inviteUrl(ORG, ID));
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`a[href="https://github.com/${ORG}/${ID}-classmate"]`)).toHaveCount(0);
  });

  test("a student who never accepted keeps Accept, even over a renamed classmate's repository", async ({ page }) => {
    await open(page, { brokerIssues: [] });
    await page.goto(inviteUrl(ORG, ID));
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`a[href="https://github.com/${FULL}"]`)).toHaveCount(0);
  });

  test('a refused attempt proves nothing either', async ({ page }) => {
    await open(page, { brokerIssues: [{ ...theirAttempt, labels: [{ name: REJECTED_LABEL }] }] });
    await page.goto(inviteUrl(ORG, ID));
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeVisible({ timeout: 15000 });
  });

  test("their own beside a classmate's is still found", async ({ page }) => {
    await open(page, { userRepos: [theirRepo, repoCalled(`${ID}-classmate`)] });
    await page.goto(inviteUrl(ORG, ID));
    await expect(page.locator(`a[href="https://github.com/${FULL}"]`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toHaveCount(0);
  });

  test('two named for nobody say nothing about which is theirs: Accept stays, and the hub decides', async ({ page }) => {
    await open(page, { userRepos: [theirRepo, repoCalled(`${ID}-also-gone`)], notAccounts: [OLD_LOGIN, 'also-gone'] });
    await page.goto(inviteUrl(ORG, ID));
    await expect(page.getByRole('button', { name: /Accept assignment/i })).toBeVisible({ timeout: 15000 });
  });

  test('a pending invitation under the old name is the one they are offered', async ({ page }) => {
    await open(page, {
      userRepos: [],
      invitations: [{ id: 9, repository: theirRepo, html_url: `https://github.com/${FULL}/invitations`, permissions: 'write' }],
    });
    await page.goto(inviteUrl(ORG, ID));
    await expect(page.getByRole('button', { name: /^Accept invitation$/i })).toBeVisible({ timeout: 15000 });
  });

  test('My Assignments lists it, linked to the repository under its old name', async ({ page }) => {
    await open(page);
    await page.goto('/');
    const card = page.locator('.my-assignment-card', { hasText: 'Renamed Lab' });
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.getByRole('link', { name: /Open on GitHub/i })).toHaveAttribute('href', `https://github.com/${FULL}`);
  });

  test("My Assignments does not list a classmate's repository as theirs", async ({ page }) => {
    await open(page, { userRepos: [repoCalled(`${ID}-classmate`)] });
    await page.goto('/');
    await expect(page.getByText('No accepted assignments yet')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.my-assignment-card', { hasText: 'Renamed Lab' })).toHaveCount(0);
  });

  test("nor a renamed classmate's, for a student who never accepted", async ({ page }) => {
    await open(page, { brokerIssues: [] });
    await page.goto('/');
    await expect(page.getByText('No accepted assignments yet')).toBeVisible({ timeout: 15000 });
  });
});
