// 74 - A change to a live assignment reaches the page students read.
//
// THE FAILURE: PXL-2TIN-NetAdv-26-27/net-advanced-guts-2627, 2026-09-16.
//
// A lecturer ticked "Ask students to confirm their PXL email address" on a
// published assignment and pressed Save. The commit landed, so the hub enforced
// `require_claim: true` from that second on. But the student page reads the
// card pages/generate.mjs writes, and the broker already existed - so Save
// dispatched nothing, the card kept `require_claim: false`, and the page never
// showed the address field. The lecturer's own acceptance was refused six times
// in twelve minutes as `rejected:no-claim`, for leaving out a field nobody had
// shown him. Retrying could not help: a rejection regenerates nothing.
//
// Same defect on three more writes, each with its own wrong page: closing
// (a card still saying published offers an Accept button the hub refuses),
// reopening (a card still saying closed tells the cohort they are too late) and
// raising a full cap (the page checks the cap before it offers the button).
//
// The assertions are on the DISPATCH, and on it following the write. A
// regeneration dispatched before the commit rebuilds the page from the old
// document, which is the bug with extra steps.

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { test, expect } from '@playwright/test';
import {
  ORG,
  LECTURER,
  injectAuth,
  setupStandardMockRoutes,
  inviteToken,
  expandSettings,
  openMoreActionsMenu,
} from '../fixtures/e2e-fixtures.mjs';

// Read, not spelled: the label names the institution from deployment.yml.
const INSTITUTION_SHORT = parse(
  readFileSync(new URL('../../deployment.yml', import.meta.url), 'utf8'),
).institution_short;
const ASK_LABEL = `Ask students to confirm their ${INSTITUTION_SHORT} email address`;

const ID = 'net-advanced-labs';
const REGENERATE = 'regenerate-dashboard.yml';
const PUBLISH = 'publish-assignment.yml';

const liveAssignment = (over = {}) => ({
  schema_version: 1,
  id: ID,
  title: '.NET Advanced Labs',
  organization: ORG,
  state: 'published',
  assignment_type: 'individual',
  roster_mode: 'open',
  max_acceptances: 150,
  repository_name_pattern: `${ID}-{github_login}`,
  template: { owner: ORG, repository: 'dotnet-template' },
  // No `broker_repo`: the schema does not declare it, and the cohort page
  // writes this document back whole, so the fixture refuses the save. The
  // broker name is derived, which is what the fixture does too.
  invite_key: inviteToken(ORG, ID),
  invite_nonce: 'e2e00074',
  invite_expires_at: '2099-01-01T00:00:00.000Z',
  opens_at: new Date(Date.now() - 86400_000).toISOString(),
  deadline_at: new Date(Date.now() + 60 * 86400_000).toISOString(),
  ...over,
});

const brokerRepo = {
  name: `broker-${ID}`,
  full_name: `${ORG}/broker-${ID}`,
  html_url: `https://github.com/${ORG}/broker-${ID}`,
};

/**
 * Every dispatch, with how many writes to the assignment had landed when it was
 * sent. Registered after the fixture, so it wins; it answers 204 itself, or the
 * status a spec asks for on one workflow.
 */
async function recordDispatches(page, writes, { refuse = null } = {}) {
  const dispatches = [];
  await page.route(
    (url) => url.href.includes('/actions/workflows/') && url.href.includes('/dispatches'),
    async (route) => {
      const workflow = decodeURIComponent(route.request().url().match(/\/workflows\/([^/]+)\/dispatches/)[1]);
      let inputs = null;
      try { inputs = route.request().postDataJSON()?.inputs ?? null; } catch { /* no body */ }
      dispatches.push({
        workflow,
        inputs,
        writesBefore: writes.filter((w) => w.path === `assignments/${ID}.yml`).length,
      });
      if (refuse && workflow === refuse) {
        await route.fulfill({
          status: 403,
          body: JSON.stringify({ message: 'Resource not accessible by integration' }),
        });
        return;
      }
      await route.fulfill({ status: 204, body: '' });
    },
  );
  return dispatches;
}

async function openLiveEditor(page, { assignment = liveAssignment(), broker = true, refuse = null } = {}) {
  const writes = [];
  await injectAuth(page, LECTURER);
  await setupStandardMockRoutes(page, {
    currentUser: LECTURER,
    assignments: { [ID]: assignment },
    userRepos: broker ? [brokerRepo] : [],
    contentWrites: writes,
  });
  const dispatches = await recordDispatches(page, writes, { refuse });
  await page.goto(`/dashboard/${ORG}/admin?edit=${ID}`);
  // The only answer that skips the publish is a broker positively found, so
  // wait for the panel to have looked. Clicking Save before this is the `null`
  // case, which publishes - a different test.
  await expect(
    page.getByText(broker ? 'Assignment is Published & Verified Live' : 'Publish Incomplete: Student Acceptance Broker Missing'),
  ).toBeVisible({ timeout: 15000 });
  await expandSettings(page);
  return { writes, dispatches };
}

const guardrails = (page) =>
  page.locator('fieldset', { has: page.locator('legend', { hasText: 'Guardrails' }) });

const named = (dispatches, workflow) => dispatches.filter((d) => d.workflow === workflow);

test.describe('74 - saving a live assignment', () => {
  test('the incident: ticking require_claim on a published assignment rebuilds the student page', async ({ page }) => {
    const { writes, dispatches } = await openLiveEditor(page);

    await guardrails(page).locator('label', { hasText: ASK_LABEL }).locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => named(dispatches, REGENERATE).length, { timeout: 15000 }).toBe(1);
    const [regen] = named(dispatches, REGENERATE);
    expect(regen.inputs, 'regenerated for this organization only').toEqual({ org: ORG });
    expect(regen.writesBefore, 'the page must be rebuilt from the document just saved, not the one before it').toBeGreaterThan(0);

    const saved = writes.filter((w) => w.path === `assignments/${ID}.yml`).at(-1);
    expect(parse(saved.content).require_claim).toBe(true);

    // The broker exists, so republishing it would be a redundant run - and
    // the publish workflow regenerates anyway, so doing both is two.
    expect(named(dispatches, PUBLISH)).toHaveLength(0);

    // The hub enforces the edit now and the page shows it in a couple of
    // minutes. Saying so is what stops "I just changed it, why am I refused".
    await expect(page.locator('.toast', { hasText: 'Students see this change in about two minutes' })).toBeVisible();
  });

  test('a retitle, which is on every card, is rebuilt too', async ({ page }) => {
    const { dispatches } = await openLiveEditor(page);

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('.NET Advanced Labs, renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => named(dispatches, REGENERATE).length, { timeout: 15000 }).toBe(1);
  });

  test('with no broker the save publishes, and does not also regenerate', async ({ page }) => {
    const { dispatches } = await openLiveEditor(page, { broker: false });

    await page.getByPlaceholder('e.g. Linux Processes 2026').fill('.NET Advanced Labs, repaired');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => named(dispatches, PUBLISH).length, { timeout: 15000 }).toBe(1);
    expect(named(dispatches, PUBLISH)[0].writesBefore).toBeGreaterThan(0);
    // publish-assignment.yml ends by dispatching the regeneration itself.
    expect(named(dispatches, REGENERATE)).toHaveLength(0);
  });

  test('a refused regeneration says the save landed and students cannot see it yet', async ({ page }) => {
    const { writes, dispatches } = await openLiveEditor(page, { refuse: REGENERATE });

    await guardrails(page).locator('label', { hasText: ASK_LABEL }).locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => named(dispatches, REGENERATE).length, { timeout: 15000 }).toBe(1);
    expect(writes.filter((w) => w.path === `assignments/${ID}.yml`).length).toBeGreaterThan(0);

    const error = page.locator('.toast-error');
    await expect(error).toContainText('publishing the change to students failed');
    await expect(error).toContainText('actions:write');
    await expect(error.locator('a')).toHaveAttribute('href', /regenerate-dashboard\.yml/);
    // Promising a rebuild that was refused is the lie this toast replaces.
    await expect(page.locator('.toast', { hasText: 'Students see this change' })).toHaveCount(0);
  });

  test('Stop accepting rebuilds the page, so it stops offering the Accept button', async ({ page }) => {
    const { writes, dispatches } = await openLiveEditor(page);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Stop accepting' }).click();

    await expect.poll(() => named(dispatches, REGENERATE).length, { timeout: 15000 }).toBe(1);
    expect(named(dispatches, REGENERATE)[0].writesBefore).toBeGreaterThan(0);
    const saved = writes.filter((w) => w.path === `assignments/${ID}.yml`).at(-1);
    expect(parse(saved.content).state).toBe('closed');
  });
});

test.describe('74 - the cohort page', () => {
  function fullReport(count) {
    return {
      schema_version: 1,
      assignment_id: ID,
      generated_at: new Date().toISOString(),
      students: Array.from({ length: count }, (_, i) => ({
        github_login: `student-${i + 1}`,
        repo_name: `${ID}-student-${i + 1}`,
        acceptance_state: 'provisioned',
        submission_status: 'on-time',
      })),
    };
  }

  async function openCohort(page, assignment, report) {
    const writes = [];
    await injectAuth(page, LECTURER);
    await setupStandardMockRoutes(page, {
      currentUser: LECTURER,
      assignments: { [ID]: assignment },
      reports: { [ID]: report },
      contentWrites: writes,
    });
    const dispatches = await recordDispatches(page, writes);
    await page.goto(`/dashboard/${ORG}/${ID}`);
    return { writes, dispatches };
  }

  test('raising a full cap rebuilds the page that was refusing the cohort', async ({ page }) => {
    const { writes, dispatches } = await openCohort(page, liveAssignment({ max_acceptances: 20 }), fullReport(20));

    const banner = page.locator('.capacity-banner');
    await expect(banner).toContainText('Registration cap reached', { timeout: 15000 });
    await banner.getByRole('button', { name: '+10' }).click();
    await expect(page.locator('.toast', { hasText: /Capacity increased to 30 slots/ })).toBeVisible();

    await expect.poll(() => named(dispatches, REGENERATE).length, { timeout: 15000 }).toBe(1);
    expect(named(dispatches, REGENERATE)[0].writesBefore).toBeGreaterThan(0);
    expect(parse(writes.at(-1).content).max_acceptances).toBe(30);
  });

  test('re-opening acceptance rebuilds the page that says it is closed', async ({ page }) => {
    const { writes, dispatches } = await openCohort(page, liveAssignment({ state: 'closed' }), fullReport(3));

    await openMoreActionsMenu(page);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('menuitem', { name: /Re-open Acceptance/ }).click();

    await expect.poll(() => named(dispatches, REGENERATE).length, { timeout: 15000 }).toBe(1);
    expect(named(dispatches, REGENERATE)[0].writesBefore).toBeGreaterThan(0);
    expect(parse(writes.at(-1).content).state).toBe('published');
  });
});
