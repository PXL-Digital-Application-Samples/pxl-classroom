// 98 - Editing a finished assignment never publishes it, and never demotes it.
//
// THE FAILURE (review, 2026-10-06). A closed assignment's only save button was
// "Save & publish": it wrote `state: published` and dispatched the publish
// workflow. On a FINISHED one (deadline passed, lock ran) the workflow refused
// - correctly - but its prior-state step sat after the refusal, so it never
// ran, and the revert read the empty output as "not published" and wrote
// `state: draft`. Fixing a typo in a closed exam's grading turned it into a
// draft with no way back. The workflow half is tests/finished-assignment.test.mjs;
// this is the editor half: closed and archived save as they are, a finished
// assignment is refused before anything is written, and a draft that was
// published before is deleted in full, never as a bare file.

import { parse } from 'yaml';
import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
  expandSettings,
  chooseState,
} from '../fixtures/e2e-fixtures.mjs';

const ID = 'cloud-exam-98';
const PUBLISH = 'publish-assignment.yml';
const REGENERATE = 'regenerate-dashboard.yml';
const DAY = 86400_000;

const doc = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: 'Cloud Exam',
  organization: ORG,
  state: 'closed',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 150,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'cloud-template' },
  invite_key: inviteToken(ORG, ID),
  invite_nonce: 'e2e00098',
  invite_expires_at: '2099-01-01T00:00:00.000Z',
  opens_at: new Date(Date.now() - 20 * DAY).toISOString(),
  deadline_at: new Date(Date.now() - 5 * DAY).toISOString(),
  ...over,
});

async function open(page, { assignment, locked = true, broker = true } = {}) {
  const writes = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment },
    userRepos: broker ? [{ name: `broker-${ID}`, full_name: `${ORG}/broker-${ID}`, html_url: `https://github.com/${ORG}/broker-${ID}` }] : [],
    contentWrites: writes,
  });
  // The deadline's lock ran (or did not). Registered after the fixture, so it wins.
  await page.route(`**/contents/lockdowns/${ID}/lockdown-record.json*`, (route) =>
    (locked
      ? route.fulfill({ status: 200, body: JSON.stringify({ content: Buffer.from('{}').toString('base64'), encoding: 'base64', sha: 'lock-sha' }) })
      : route.fulfill({ status: 404, body: JSON.stringify({ message: 'Not Found' }) })));
  const dispatches = [];
  await page.route(
    (url) => url.href.includes('/actions/workflows/') && url.href.includes('/dispatches'),
    async (route) => {
      const workflow = decodeURIComponent(route.request().url().match(/\/workflows\/([^/]+)\/dispatches/)[1]);
      let inputs = null;
      try { inputs = route.request().postDataJSON()?.inputs ?? null; } catch { /* no body */ }
      dispatches.push({ workflow, inputs });
      await route.fulfill({ status: 204, body: '' });
    },
  );
  await page.goto(`/dashboard/${ORG}/${ID}?tab=settings`);
  await expandSettings(page);
  return { writes, dispatches };
}

const assignmentWrites = (writes) => writes.filter((w) => w.path === `assignments/${ID}.yml`);
const named = (dispatches, workflow) => dispatches.filter((d) => d.workflow === workflow);
const bar = (page) => page.locator('.editor-action-buttons');

test.describe('98 - editing a finished assignment', () => {
  test('a closed one saves as it is: "Save", state kept, nothing published', async ({ page }) => {
    const { writes, dispatches } = await open(page, { assignment: doc() });
    await expect(bar(page).getByRole('button', { name: 'Save & publish' })).toHaveCount(0);

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Cloud Exam (regraded)');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => assignmentWrites(writes).length, { timeout: 15000 }).toBe(1);
    const saved = parse(assignmentWrites(writes)[0].content);
    expect(saved.state, 'a save is not a reopen').toBe('closed');
    expect(saved.title).toBe('Cloud Exam (regraded)');
    // A closed assignment still has a card on the student page, so the page is
    // rebuilt; the publish workflow is not run.
    await expect.poll(() => named(dispatches, REGENERATE).length, { timeout: 15000 }).toBe(1);
    expect(named(dispatches, PUBLISH)).toHaveLength(0);
    await expect(page.locator('[data-state-menu]')).toContainText('Closed');
  });

  test('an archived one saves as it is too', async ({ page }) => {
    const { writes, dispatches } = await open(page, { assignment: doc({ state: 'archived' }) });
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Cloud Exam 2025');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => assignmentWrites(writes).length, { timeout: 15000 }).toBe(1);
    expect(parse(assignmentWrites(writes)[0].content).state).toBe('archived');
    expect(named(dispatches, PUBLISH)).toHaveLength(0);
  });

  test('publishing a finished draft is refused before anything is written', async ({ page }) => {
    // Back to draft after the exam, then Publish: the workflow would refuse
    // it, by which time the page had already written `published`.
    const { writes, dispatches } = await open(page, { assignment: doc({ state: 'draft' }) });
    await chooseState(page, 'Publish');
    await expect(page.locator('.toast-error', { hasText: 'is finished' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.toast-error', { hasText: 'move the deadline into the future first' })).toBeVisible();
    expect(assignmentWrites(writes)).toHaveLength(0);
    expect(named(dispatches, PUBLISH)).toHaveLength(0);
  });

  test('with a deadline moved into the future it publishes, and says what it was before', async ({ page }) => {
    const { writes, dispatches } = await open(page, { assignment: doc({ state: 'draft', deadline_at: new Date(Date.now() + 7 * DAY).toISOString() }) });
    await chooseState(page, 'Publish');
    await expect.poll(() => named(dispatches, PUBLISH).length, { timeout: 15000 }).toBe(1);
    expect(named(dispatches, PUBLISH)[0].inputs.prior_state, 'a failed publish puts back this').toBe('draft');
    expect(parse(assignmentWrites(writes).at(-1).content).state).toBe('published');
  });

  test('a live save of a finished assignment rebuilds the page instead of publishing', async ({ page }) => {
    // No broker found: an ordinary save would dispatch the publish workflow,
    // which refuses a finished assignment and goes red over a plain edit.
    const { writes, dispatches } = await open(page, { assignment: doc({ state: 'published' }), broker: false });
    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('Cloud Exam, final');
    await bar(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => assignmentWrites(writes).length, { timeout: 15000 }).toBe(1);
    await expect.poll(() => named(dispatches, REGENERATE).length, { timeout: 15000 }).toBe(1);
    expect(named(dispatches, PUBLISH)).toHaveLength(0);
    expect(parse(assignmentWrites(writes)[0].content).state).toBe('published');
  });

  test('a draft that was published before offers the full delete, not "Delete draft"', async ({ page }) => {
    await open(page, { assignment: doc({ state: 'draft' }) });
    const trigger = page.locator('[data-state-menu]');
    await expect(trigger).toBeEnabled({ timeout: 15000 });
    await trigger.click();
    const items = page.locator('.state-menu [role="menuitem"] .dropdown-item-title');
    await expect(items).toContainText(['Publish', 'Delete assignment…']);
    await expect(items.filter({ hasText: 'Delete draft' })).toHaveCount(0);
    await page.locator('.state-menu [role="menuitem"]').filter({ hasText: 'Delete assignment…' }).click();
    // The full delete: it removes the broker and keeps a record.
    await expect(page.locator('.modal-overlay .modal')).toBeVisible();
    await expect(page.locator('.confirm-dialog', { hasText: 'Delete the draft' })).toHaveCount(0);
  });

  test('a settings file GitHub fails to return is "could not read", never "no such assignment"', async ({ page }) => {
    // Review 2026-10-06: any read error dropped the file from the editor's
    // list, and Settings said "There is no assignment called X" under a
    // header showing X.
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, { currentUser: LECTURER, assignments: { [ID]: doc({ state: 'published', deadline_at: new Date(Date.now() + 7 * DAY).toISOString() }) } });
    await page.goto(`/dashboard/${ORG}/${ID}`);
    await expect(page.locator('.app-header-heading')).toHaveText('Cloud Exam', { timeout: 15000 });
    const failing = `**/pxl-classroom-control/contents/assignments/${ID}.yml*`;
    await page.route(failing, (route) => route.fulfill({ status: 502, body: JSON.stringify({ message: 'Server Error' }) }));
    await page.locator('.assignment-tabs .primer-tab', { hasText: /^Settings$/ }).click();
    await expect(page.getByText(`Couldn't read ${ID} just now.`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('There is no assignment called')).toHaveCount(0);

    await page.unroute(failing);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByPlaceholder('e.g. Linux Processes 2026')).toHaveValue('Cloud Exam', { timeout: 15000 });
  });

  test('a draft never published keeps "Delete draft"', async ({ page }) => {
    const fresh = doc({ state: 'draft', deadline_at: new Date(Date.now() + 7 * DAY).toISOString() });
    delete fresh.invite_key;
    delete fresh.invite_nonce;
    delete fresh.invite_expires_at;
    await open(page, { assignment: fresh, locked: false });
    await chooseState(page, 'Delete draft');
    await expect(page.locator('.confirm-dialog')).toContainText('It was never published');
  });
});
