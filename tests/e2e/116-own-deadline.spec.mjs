// 116 - A student's own deadline reaches their page through their repository.
//
// Found by the live UI suite (2026-10-15): the student page read an extension
// from the control repository, which is private to staff, so a real student
// was answered 404 and never saw it - "Deadline passed" in red, "Submitted
// late" for work inside their extension. The fixture served that file to
// anyone, which is how every spec here stayed green. Decided: the deadline in
// force is a variable on their own repository (lib/deadline-variable.mjs).
//
// Every spec below answers the control repository as GitHub answers a
// student: 404.
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, injectAuth, setupStandardMockRoutes, inviteUrl } from '../fixtures/e2e-fixtures.mjs';

const ID = 'lab-own';
const STUDENT = { login: 'own-student', name: 'Own Student', token: 'mock_own_token' };
const REPO = `${ID}-${STUDENT.login}`;
const FULL = `${ORG}/${REPO}`;
const hours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const ZONE = 'Europe/Brussels';
const shown = (iso) => new Date(iso).toLocaleString('en-GB', {
  timeZone: ZONE, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
});

const assignment = (deadline) => ({
  id: ID, title: 'Own Deadline Lab', organization: ORG, state: 'published', assignment_type: 'individual',
  deadline_at: deadline, timezone: ZONE, repository_name_pattern: `${ID}-{github_login}`,
});

async function studentPage(page, { deadline = hours(-12), variable = null, push = true, commitAt = hours(-6) } = {}) {
  await injectAuth(page, STUDENT);
  await setupStandardMockRoutes(page, {
    currentUser: STUDENT,
    userRepos: [{
      name: REPO, full_name: FULL, html_url: `https://github.com/${FULL}`,
      permissions: { admin: push, maintain: push, push, triage: true, pull: true },
    }],
    assignments: { [ID]: assignment(deadline) },
    repoVariables: variable ? { [FULL]: variable } : {},
  });
  // As GitHub answers a student: the control repository is not theirs to read.
  await page.route('**/pxl-classroom-control/contents/overrides/**', (route) =>
    route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }));
  await page.route(`**/repos/${FULL}/commits?**`, (route) => route.fulfill({
    status: 200,
    body: JSON.stringify([{ sha: 'a'.repeat(40), commit: { message: 'work', author: { date: commitAt }, committer: { date: commitAt } } }]),
  }));
  await page.route(`**/repos/${FULL}/activity?**`, (route) => route.fulfill({
    status: 200, body: JSON.stringify([{ actor: { login: STUDENT.login }, activity_type: 'push', after: 'a'.repeat(40) }]),
  }));
  await page.goto(inviteUrl(ORG, ID));
  const card = page.locator('.student-status-card');
  await expect(card).toBeVisible({ timeout: 15000 });
  return card;
}

test.describe('116 - the student page reads their own deadline from their repository', () => {
  test('an extension on their repository is shown, counts down, and work inside it is on time', async ({ page }) => {
    const extended = hours(36);
    const card = await studentPage(page, { variable: new Date(extended).toISOString() });
    // The date only - the reason is in the control repository, for staff.
    await expect(card.locator('.override-alert-banner')).toHaveText(`Deadline extended to ${shown(extended)}.`);
    await expect(card.locator('.deadline-countdown')).toContainText('Closes in');
    await expect(card.locator('.badge-success')).toHaveText('Submitted on time');
  });

  test('no extension, and they can still push: work after the deadline is late', async ({ page }) => {
    const card = await studentPage(page);
    await expect(card.locator('.badge-warning')).toHaveText('Submitted late');
    await expect(card.locator('.override-alert-banner')).toHaveCount(0);
  });

  test('locked (they cannot push, so their variable is unreadable): never called late, and the hover says why', async ({ page }) => {
    const card = await studentPage(page, { push: false });
    const badge = card.locator('.badge', { hasText: /^Submitted$/ });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/badge-neutral/);
    await expect(badge).toHaveAttribute('title', 'Pushed after the assignment deadline. If you were given more time, your own deadline applies, and this page could not read it.');
    await expect(card).not.toContainText('Submitted late');
  });

  test('locked, with work before the deadline: on time is certain whatever their extension', async ({ page }) => {
    const card = await studentPage(page, { push: false, commitAt: hours(-14) });
    await expect(card.locator('.badge-success')).toHaveText('Submitted on time');
  });
});

// THE LECTURER'S SIDE: the grant writes it, and the dialog says what their page shows.
const REPORT_ROW = {
  github_login: STUDENT.login, acceptance_state: 'provisioned', submission_status: 'late',
  repo_name: FULL, repo_id: 9116, effective_deadline_at: null,
};
async function lecturerPage(page, { variable = null, overrides = {}, variableWrites = [] } = {}) {
  const deadline = hours(-12);
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment(deadline) },
    reports: { [ID]: { schema_version: 1, assignment_id: ID, generated_at: new Date().toISOString(), students: [{ ...REPORT_ROW, effective_deadline_at: deadline }] } },
    controlOverrides: { [ID]: overrides },
    repoVariables: variable ? { [FULL]: variable } : {},
    variableWrites,
  });
  await page.goto(`/dashboard/${ORG}/${ID}`);
  await page.getByRole('button', { name: `Actions for ${STUDENT.login}` }).first().click();
  return page.getByRole('dialog', { name: `Actions for ${STUDENT.login}` });
}

test.describe('116 - the lecturer grants it, and sees what their page shows', () => {
  test('granting an extension writes the new deadline to their repository', async ({ page }) => {
    const variableWrites = [];
    const dialog = await lecturerPage(page, { variableWrites });
    const local = hours(48).slice(0, 16);
    await dialog.locator('input[type="datetime-local"]').first().fill(local);
    await dialog.getByPlaceholder(/Medical certificate/).fill('Medical certificate');
    await dialog.getByRole('button', { name: 'Grant extension' }).click();
    // None there yet, so made (the PATCH before it was a 404, which writes
    // nothing) - with the instant the form meant, in UTC.
    await expect.poll(() => variableWrites.length, { timeout: 15000 }).toBe(1);
    expect(variableWrites).toEqual([{ repo: FULL, method: 'POST', value: new Date(local).toISOString() }]);
    await expect(page.locator('.toast', { hasText: `Extension granted to ${STUDENT.login}; their own page shows it` })).toBeVisible();
  });

  test('an extension their page does not show yet is said, and sent on request', async ({ page }) => {
    const variableWrites = [];
    const value = hours(48);
    const dialog = await lecturerPage(page, {
      variableWrites,
      overrides: { [STUDENT.login]: { schema_version: 1, assignment_id: ID, github_login: STUDENT.login, overrides: [{ type: 'deadline_extension', value, reason: 'medical', overridden_by: 'l', overridden_at: hours(-1) }] } },
    });
    const line = dialog.locator('[data-page-deadline]');
    await expect(line).toHaveAttribute('data-state', 'behind');
    await expect(line).toContainText('Their own page does not show it yet: it shows the assignment deadline.');
    await line.getByRole('button', { name: 'Send it to their page' }).click();
    await expect(line).toHaveAttribute('data-state', 'current', { timeout: 15000 });
    await expect(line).toHaveText('Their own page shows this deadline.');
    expect(variableWrites).toEqual([{ repo: FULL, method: 'POST', value: new Date(value).toISOString() }]);
  });

  test('one their page already shows is said so, with nothing to send', async ({ page }) => {
    const value = new Date(hours(48)).toISOString();
    const dialog = await lecturerPage(page, {
      variable: value,
      overrides: { [STUDENT.login]: { schema_version: 1, assignment_id: ID, github_login: STUDENT.login, overrides: [{ type: 'deadline_extension', value, reason: 'medical', overridden_by: 'l', overridden_at: hours(-1) }] } },
    });
    const line = dialog.locator('[data-page-deadline]');
    await expect(line).toHaveText('Their own page shows this deadline.');
    await expect(line.getByRole('button')).toHaveCount(0);
  });
});
