// 85 - Changing Student permission on an assignment students already accepted.
//
// The field is read at acceptance, so a change reached nobody who had a
// repository. Now the Admin Panel offers to apply it, skipping anyone past
// their deadline (their repository may be locked, and a changed permission is
// an unlock), and updating pending invitations through the invitation - a
// second grant leaves an invitation at its OLD permission (measured
// 2026-09-26). lib/permission-change.mjs decides; tests/permission-change.test.mjs
// covers it; this is the wiring.

import { parse } from 'yaml';
import { test, expect } from '@playwright/test';
import { ORG, LECTURER, STUDENT_1, STUDENT_2, injectAuth, setupStandardMockRoutes, inviteToken, expandSettings } from '../fixtures/e2e-fixtures.mjs';

const ID = 'perm-test';

const liveAssignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'Permission test',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 150,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'perm-template' },
  student_permission: 'admin',
  invite_key: inviteToken(ORG, ID),
  invite_nonce: 'e2e00085',
  invite_expires_at: '2099-01-01T00:00:00.000Z',
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
  ...over,
});

const record = (s) => ({
  schema_version: 1,
  assignment_id: ID,
  github_login: s.login,
  repo_id: 2000 + s.login.length,
  repo_name: `${ORG}/${ID}-${s.login}`,
  repo_url: `https://github.com/${ORG}/${ID}-${s.login}`,
});

const brokerRepo = { name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}`, html_url: `https://github.com/${ORG}/broker-${ID}` };

async function openEditor(page, { assignment = liveAssignment(), accepted = [STUDENT_1, STUDENT_2] } = {}) {
  const writes = [];
  const grants = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment },
    userRepos: [brokerRepo],
    controlRepositories: accepted.length ? { [ID]: accepted.map(record) } : {},
    contentWrites: writes,
  });
  await page.route((url) => url.href.includes('/actions/workflows/') && url.href.includes('/dispatches'),
    (route) => route.fulfill({ status: 204, body: '' }));
  // STUDENT_1 is a collaborator; STUDENT_2 has not accepted the invitation,
  // which GitHub leaves at its old permission on a second grant.
  await page.route(/\/repos\/[^/]+\/[^/]+\/(collaborators\/[^/?]+|invitations\/\d+)(\?.*)?$/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!['PUT', 'PATCH'].includes(req.method())) return route.fallback();
    grants.push({ method: req.method(), path: url.pathname, body: req.postDataJSON() });
    if (req.method() === 'PUT' && url.pathname.endsWith(`/collaborators/${STUDENT_2.login}`)) {
      return route.fulfill({ status: 201, body: JSON.stringify({ id: 4242, permissions: 'admin' }) });
    }
    if (req.method() === 'PATCH') {
      return route.fulfill({ status: 200, body: JSON.stringify({ id: 4242, permissions: req.postDataJSON().permissions }) });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  await expect(page.getByText('Assignment is Published & Verified Live')).toBeVisible({ timeout: 15000 });
  await expandSettings(page);
  await page.locator('details.advanced > summary').click();
  return { writes, grants };
}

const select = (page) => page.locator('.field', { has: page.locator('label', { hasText: 'Student permission' }) }).locator('select');
const notice = (page) => page.getByRole('status', { name: 'Student permission change' });

async function saveAs(page, level) {
  await select(page).selectOption(level);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast', { hasText: `Saved ${ID}` })).toBeVisible({ timeout: 15000 });
}

test.describe('85 - changing Student permission after students accepted', () => {
  test('the field says what each level can do, measured, and that accepted students keep the old one', async ({ page }) => {
    await openEditor(page);
    const field = page.locator('.field', { has: page.locator('label', { hasText: 'Student permission' }) });
    await expect(field).toContainText('register self-hosted runners');
    await select(page).selectOption('maintain');
    await expect(field).toContainText('They cannot register self-hosted runners');
    await expect(field).toContainText('Students who already accepted keep admin until you apply the change to them after saving.');
  });

  test('saving maintain offers to apply it; applying updates a collaborator AND a pending invitation', async ({ page }) => {
    const { writes, grants } = await openEditor(page);
    await saveAs(page, 'maintain');
    const saved = writes.filter((w) => w.path === `assignments/${ID}.yml`).at(-1);
    expect(parse(saved.content).student_permission).toBe('maintain');

    const n = notice(page);
    await expect(n).toContainText('Students who already accepted still have admin');
    await expect(n).toContainText('2 students accepted before this change');
    await expect(n.locator('.btn-primary')).toHaveCount(0);
    expect(grants, 'nothing is changed before the button').toHaveLength(0);

    await n.getByRole('button', { name: 'Apply maintain to 2 students' }).click();
    await expect(n).toContainText('2 students now have maintain');
    expect(grants.map((g) => `${g.method} ${g.path}`).sort()).toEqual([
      `PATCH /repos/${ORG}/${ID}-${STUDENT_2.login}/invitations/4242`,
      `PUT /repos/${ORG}/${ID}-${STUDENT_1.login}/collaborators/${STUDENT_1.login}`,
      `PUT /repos/${ORG}/${ID}-${STUDENT_2.login}/collaborators/${STUDENT_2.login}`,
    ].sort());
    expect(grants.find((g) => g.method === 'PATCH').body).toEqual({ permissions: 'maintain' });
    for (const g of grants.filter((x) => x.method === 'PUT')) expect(g.body).toEqual({ permission: 'maintain' });
  });

  test('past the deadline nobody is changed, and the notice says why', async ({ page }) => {
    const { grants } = await openEditor(page, {
      assignment: liveAssignment({ deadline_at: new Date(Date.now() - 3600_000).toISOString() }),
    });
    await saveAs(page, 'maintain');
    const n = notice(page);
    await expect(n).toContainText('2 past their deadline are left as they are');
    await expect(n).toContainText('changing it would unlock it');
    await expect(n.getByRole('button', { name: /Apply/ })).toHaveCount(0);
    expect(grants).toHaveLength(0);
  });

  test('a save that does not change the permission says nothing', async ({ page }) => {
    await openEditor(page);
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Permission test, renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast', { hasText: `Saved ${ID}` })).toBeVisible({ timeout: 15000 });
    await expect(notice(page)).toHaveCount(0);
  });

  test('nobody accepted yet: nothing to apply, nothing said', async ({ page }) => {
    await openEditor(page, { accepted: [] });
    await saveAs(page, 'maintain');
    await expect(notice(page)).toHaveCount(0);
  });

  test('a new assignment starts at maintain', async ({ page }) => {
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: {} });
    await page.goto(`/dashboard/${ORG}/admin`);
    await page.locator('.new-btn').click();
    await page.locator('details.advanced > summary').click();
    await expect(select(page)).toHaveValue('maintain');
  });
});
